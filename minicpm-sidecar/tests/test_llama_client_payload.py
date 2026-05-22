"""Lock down the request body shape llama_client.stream_chat sends to
llama-server. The two things that bite hard if they regress:

  1) chat_template_kwargs.enable_thinking — controls whether MiniCPM5's
     GGUF Jinja template prefills `<think>\\n` into the assistant prompt.
     Without this, `thinking=false` won't actually skip reasoning and
     short-budget chats will return empty content.
  2) `temperature` / `top_p` / `top_k` / `repeat_penalty` use llama.cpp's
     naming, not raw OpenAI's.
"""

from __future__ import annotations

import asyncio
import json
from typing import AsyncIterator

import httpx
import pytest

from gateway.llama_client import LlamaServer


class _Recorder:
    """Records the JSON body of POST /v1/chat/completions and returns a tiny
    canned stream so the consumer drains naturally."""

    def __init__(self) -> None:
        self.body: dict | None = None

    async def handler(self, request: httpx.Request) -> httpx.Response:
        self.body = json.loads(request.content.decode("utf-8"))
        # llama-server "OpenAI" SSE stream with one reasoning chunk + one
        # content chunk + [DONE].
        body = (
            b'data: {"choices":[{"index":0,"delta":{"reasoning_content":"r1"}}]}\n\n'
            b'data: {"choices":[{"index":0,"delta":{"content":"c1"}}]}\n\n'
            b'data: [DONE]\n\n'
        )
        return httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})


@pytest.mark.asyncio
async def test_stream_chat_passes_enable_thinking_true():
    rec = _Recorder()
    transport = httpx.MockTransport(rec.handler)
    server = LlamaServer(model_path=None)
    server._client = httpx.AsyncClient(transport=transport, base_url="http://t")

    out: list[tuple[str, str]] = []
    async for kind, piece in server.stream_chat(
        messages=[{"role": "user", "content": "hi"}],
        max_tokens=16,
        temperature=0.5,
        top_p=0.9,
        top_k=20,
        repetition_penalty=1.05,
        enable_thinking=True,
    ):
        out.append((kind, piece))

    assert ("reasoning", "r1") in out
    assert ("content", "c1") in out

    assert rec.body is not None
    assert rec.body["chat_template_kwargs"] == {"enable_thinking": True}
    assert rec.body["top_k"] == 20
    assert rec.body["repeat_penalty"] == pytest.approx(1.05)
    assert rec.body["stream"] is True


@pytest.mark.asyncio
async def test_stream_chat_passes_enable_thinking_false():
    rec = _Recorder()
    server = LlamaServer(model_path=None)
    server._client = httpx.AsyncClient(transport=httpx.MockTransport(rec.handler), base_url="http://t")

    async for _ in server.stream_chat(
        messages=[{"role": "user", "content": "hi"}],
        max_tokens=8,
        temperature=0.0,
        top_p=1.0,
        top_k=0,
        repetition_penalty=1.0,
        enable_thinking=False,
    ):
        pass

    assert rec.body["chat_template_kwargs"] == {"enable_thinking": False}
    # top_k=0 must end up as 0 (llama.cpp's "disabled"), not omitted.
    assert rec.body["top_k"] == 0
