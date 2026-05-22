"""Verify the gateway injects a per-request `lora` array into
llama-server's chat body the way the plan dictates:

    disable_adapter=true            →  body["lora"] = []
    active adapter present          →  body["lora"] = [{"id": N, "scale": 1.0}]
    no adapter active               →  "lora" not in body

The mechanism is `stream_chat(lora=...)`, exercised here directly so we
don't depend on the gateway's FastAPI plumbing for the unit test.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from gateway.llama_client import LlamaServer


class _Recorder:
    def __init__(self) -> None:
        self.body: dict[str, Any] | None = None

    async def handler(self, request: httpx.Request) -> httpx.Response:
        self.body = json.loads(request.content.decode("utf-8"))
        return httpx.Response(
            200,
            content=b'data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',
            headers={"content-type": "text/event-stream"},
        )


def _make_server(handler) -> LlamaServer:
    server = LlamaServer(model_path=None)
    server._client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        base_url="http://t",
    )
    return server


async def _drain(server: LlamaServer, **kwargs) -> None:
    async for _ in server.stream_chat(
        messages=[{"role": "user", "content": "hi"}],
        max_tokens=8,
        temperature=0.0,
        top_p=1.0,
        top_k=0,
        repetition_penalty=1.0,
        enable_thinking=False,
        **kwargs,
    ):
        pass


@pytest.mark.asyncio
async def test_lora_omitted_when_no_adapter_active() -> None:
    rec = _Recorder()
    await _drain(_make_server(rec.handler), lora=None)
    assert rec.body is not None
    # No `lora` field → llama-server falls back to its global scales,
    # which is the desired "base model" behaviour when nothing is active.
    assert "lora" not in rec.body


@pytest.mark.asyncio
async def test_lora_empty_array_disables_all_for_narrator() -> None:
    rec = _Recorder()
    await _drain(_make_server(rec.handler), lora=[])
    # Empty list is semantically different from missing — it explicitly
    # tells llama-server "ignore every pre-loaded adapter for THIS
    # request only", which is exactly the narrator's bypass path.
    assert rec.body["lora"] == []


@pytest.mark.asyncio
async def test_lora_carries_id_and_scale() -> None:
    rec = _Recorder()
    await _drain(_make_server(rec.handler), lora=[{"id": 2, "scale": 1.0}])
    assert rec.body["lora"] == [{"id": 2, "scale": 1.0}]


def test_build_argv_includes_each_adapter(tmp_path) -> None:
    """`--lora` flag must appear once per adapter so llama-server
    pre-loads them all and `/lora-adapters` enumerates them with
    deterministic ids matching our adapter_paths ordering."""
    a = tmp_path / "a.gguf"
    a.write_bytes(b"x")
    b = tmp_path / "b.gguf"
    b.write_bytes(b"x")

    model = tmp_path / "model.gguf"
    model.write_bytes(b"x")
    server = LlamaServer(model_path=model, adapters=[a, b])
    server._binary = tmp_path / "fake-llama-server"
    server.port = 12345

    argv = server._build_argv()
    # Strip the path-dependent prefix and look for the lora structure.
    s = " ".join(argv)
    assert f"--lora {a.resolve()}" in s
    assert f"--lora {b.resolve()}" in s
    assert "--lora-init-without-apply" in s


def test_build_argv_omits_lora_flag_when_no_adapters(tmp_path) -> None:
    model = tmp_path / "model.gguf"
    model.write_bytes(b"x")
    server = LlamaServer(model_path=model, adapters=[])
    server._binary = tmp_path / "fake-llama-server"
    server.port = 12345
    argv = server._build_argv()
    assert "--lora" not in argv
    assert "--lora-init-without-apply" not in argv


def test_adapter_id_for_returns_none_when_unknown(tmp_path) -> None:
    server = LlamaServer(model_path=None)
    server._adapter_index = {tmp_path / "known.gguf": 0}
    assert server.adapter_id_for(tmp_path / "known.gguf") == 0
    assert server.adapter_id_for(tmp_path / "unknown.gguf") is None
