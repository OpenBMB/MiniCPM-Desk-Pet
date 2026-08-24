"""Local llama-server traffic must never inherit system proxy settings."""

from __future__ import annotations

import pytest

from gateway import llama_client
from gateway.llama_client import LlamaServer


class _ReadyProbe:
    def __init__(self, **kwargs) -> None:
        self.kwargs = kwargs

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args) -> None:
        return None

    async def get(self, _url: str):
        return type("Response", (), {"status_code": 200})()


@pytest.mark.asyncio
async def test_readiness_probe_ignores_environment_proxy(monkeypatch):
    created: list[_ReadyProbe] = []

    def fake_async_client(**kwargs):
        client = _ReadyProbe(**kwargs)
        created.append(client)
        return client

    monkeypatch.setattr(llama_client.httpx, "AsyncClient", fake_async_client)

    server = LlamaServer(model_path=None)
    server.port = 18766
    await server._await_ready(timeout=1.0)

    assert created[0].kwargs["trust_env"] is False


@pytest.mark.asyncio
async def test_runtime_client_ignores_environment_proxy(monkeypatch):
    created: list[_ReadyProbe] = []

    def fake_async_client(**kwargs):
        client = _ReadyProbe(**kwargs)
        created.append(client)
        return client

    class _Process:
        pid = 1234
        stdout = None
        stderr = None

        def poll(self):
            return None

    server = LlamaServer(model_path=None)
    monkeypatch.setattr(server, "_resolve_binary", lambda: None)
    monkeypatch.setattr(server, "_build_argv", lambda: ["llama-server"])
    monkeypatch.setattr(server, "_spawn_tailer", lambda _proc: None)

    async def no_op(**_kwargs):
        return None

    monkeypatch.setattr(server, "_await_ready", no_op)
    monkeypatch.setattr(server, "_refresh_adapter_index", no_op)
    monkeypatch.setattr(llama_client, "cleanup_stale_llama_server", lambda _path: None)
    monkeypatch.setattr(llama_client, "write_pid_file", lambda _path, _pid: None)
    monkeypatch.setattr(llama_client, "_find_free_port", lambda: 18766)
    monkeypatch.setattr(llama_client.subprocess, "Popen", lambda *_args, **_kwargs: _Process())
    monkeypatch.setattr(llama_client.httpx, "AsyncClient", fake_async_client)

    await server.start()

    assert created[0].kwargs["trust_env"] is False
