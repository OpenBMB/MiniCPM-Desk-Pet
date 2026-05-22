"""End-to-end-ish test of /api/adapters + /api/load-adapter against a
real FastAPI app where llama-server is mocked out. Covers the chat
routing decisions (`_lora_arr_for`) at the handler level by spying on
`LlamaServer.stream_chat`'s `lora` kwarg.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from fastapi.testclient import TestClient

from gateway import server as server_mod


@pytest.fixture
def adapter_dir(tmp_path, monkeypatch):
    """Point the gateway at a clean adapter dir + create two stub
    `.gguf` files so /api/adapters has something to enumerate."""
    d = tmp_path / "adapters"
    d.mkdir()
    (d / "lora_neko.gguf").write_bytes(b"x")
    (d / "lora_zhiyuan.gguf").write_bytes(b"x")
    monkeypatch.setenv("MINICPM_ADAPTER_DIR", str(d))
    return d


@pytest.fixture
def model_path(tmp_path):
    p = tmp_path / "model.gguf"
    p.write_bytes(b"x")
    return p


@pytest.fixture
def app_with_stub_llama(adapter_dir, model_path):
    """Build a FastAPI app whose LlamaServer is fully mocked: start() is
    a no-op, alive is always True, stream_chat records its kwargs."""
    captured: dict[str, Any] = {"lora_kwarg": "UNSET"}

    async def fake_stream_chat(**kwargs):
        captured["lora_kwarg"] = kwargs.get("lora", "MISSING")
        # Yield one content tuple so the gateway's stream consumer drains.
        yield ("content", "ok")

    with patch.object(server_mod, "LlamaServer") as MockLlama:
        instance = MockLlama.return_value
        instance.start = AsyncMock()
        instance.stop = AsyncMock()
        instance.health = AsyncMock(return_value={"ok": True})
        instance.complete_once = AsyncMock(return_value={})
        instance.model_path = model_path
        instance.port = 12345
        instance.alive = True
        instance.adapter_paths = []
        instance.last_stderr = []
        # Default: pretend every known adapter has a positional id.
        def _id_for(p):
            if not p:
                return None
            name = Path(p).name
            return {"lora_neko.gguf": 0, "lora_zhiyuan.gguf": 1}.get(name)
        instance.adapter_id_for = _id_for
        instance.stream_chat = fake_stream_chat
        instance.reload_adapters = AsyncMock()
        instance.swap_model = AsyncMock()

        app = server_mod.build_app(initial_model=model_path)
        yield app, captured, instance


def test_api_adapters_lists_gguf(app_with_stub_llama, adapter_dir):
    app, _, _ = app_with_stub_llama
    with TestClient(app) as client:
        r = client.get("/api/adapters")
        assert r.status_code == 200
        data = r.json()
        names = sorted(it["name"] for it in data["items"])
        assert names == ["lora_neko.gguf", "lora_zhiyuan.gguf"]
        assert data["current"] is None
        assert data["adapter_dir"].endswith("adapters")


def test_api_adapters_merges_manifest(app_with_stub_llama, adapter_dir):
    """Electron drops a `.manifest.json` mirror next to the .gguf files;
    the gateway must surface displayName + aliases + source on every
    /api/adapters response so chat-bubble keyword routing can resolve
    user-typed aliases like 「猫娘」 to the right adapter."""
    import json

    target_path = adapter_dir / "lora_neko.gguf"
    manifest = {
        "version": 1,
        "items": [
            {
                "id": "preset:nekoqa",
                "path": str(target_path),
                "displayName": "猫娘 宝宝",
                "aliases": ["猫娘", "宝宝", "neko"],
                "persona": "neko",
                "source": "bundled",
            },
        ],
    }
    (adapter_dir / ".manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    app, _, _ = app_with_stub_llama
    with TestClient(app) as client:
        data = client.get("/api/adapters").json()
    neko = next(it for it in data["items"] if it["name"] == "lora_neko.gguf")
    assert neko["displayName"] == "猫娘 宝宝"
    assert neko["aliases"] == ["猫娘", "宝宝", "neko"]
    assert neko["source"] == "bundled"
    assert neko["id"] == "preset:nekoqa"
    # The other adapter has no manifest entry; gateway leaves it bare.
    zhi = next(it for it in data["items"] if it["name"] == "lora_zhiyuan.gguf")
    assert "displayName" not in zhi
    assert "aliases" not in zhi


def test_api_adapters_ignores_malformed_manifest(app_with_stub_llama, adapter_dir):
    """A corrupted mirror file must not 500 the endpoint — we treat it
    as if there were no manifest at all, so the user can still pick
    adapters from the UI and write a fresh one."""
    (adapter_dir / ".manifest.json").write_text("{this is not json", encoding="utf-8")
    app, _, _ = app_with_stub_llama
    with TestClient(app) as client:
        data = client.get("/api/adapters").json()
    for it in data["items"]:
        assert "displayName" not in it
        assert "aliases" not in it


def test_manifest_mirror_dot_prefixed_skipped_by_gguf_scan(app_with_stub_llama, adapter_dir):
    """The dot-prefixed mirror file lives alongside .gguf weights but
    must not pollute the adapter list."""
    (adapter_dir / ".manifest.json").write_text('{"version":1,"items":[]}', encoding="utf-8")
    app, _, _ = app_with_stub_llama
    with TestClient(app) as client:
        data = client.get("/api/adapters").json()
    assert all(it["name"].endswith(".gguf") for it in data["items"])
    assert not any(it["name"].startswith(".") for it in data["items"])


def test_load_adapter_activates_known_path(app_with_stub_llama, adapter_dir):
    app, _, _ = app_with_stub_llama
    target = str(adapter_dir / "lora_neko.gguf")
    with TestClient(app) as client:
        r = client.post("/api/load-adapter", json={"path": target})
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["ok"] is True
        assert data["adapter"] == str(Path(target).resolve())
        assert data["persona"] == "neko"

        # Health endpoint should now surface the active adapter.
        r2 = client.get("/api/health")
        assert r2.json()["adapter"] == str(Path(target).resolve())
        assert r2.json()["persona"] == "neko"


def test_load_adapter_null_unloads(app_with_stub_llama, adapter_dir):
    app, _, _ = app_with_stub_llama
    target = str(adapter_dir / "lora_neko.gguf")
    with TestClient(app) as client:
        client.post("/api/load-adapter", json={"path": target})
        r = client.post("/api/load-adapter", json={"path": None})
        assert r.status_code == 200
        assert r.json() == {"ok": True, "adapter": None, "persona": "default"}
        assert client.get("/api/health").json()["adapter"] is None


def test_load_adapter_null_restarts_llama_when_lora_was_loaded(
    app_with_stub_llama, adapter_dir
):
    """When llama-server was booted with `--lora <X>` and the user
    switches back to Base, the gateway MUST restart llama-server with
    no `--lora` flag — the pinned llama.cpp build can't honour a
    per-request `lora: []` to disable an already-loaded adapter, so
    failing to restart leaks the persona bias into base chat."""
    app, _, instance = app_with_stub_llama
    target = adapter_dir / "lora_neko.gguf"
    # Simulate the post-load state: llama-server was rebooted with
    # nekoqa preloaded.
    instance.adapter_paths = [target]
    with TestClient(app) as client:
        r = client.post("/api/load-adapter", json={"path": None})
        assert r.status_code == 200, r.text
    # reload_adapters called with empty list → llama-server respawns
    # without any --lora, which is the only reliable way to fully
    # unload on the pinned vendor build.
    instance.reload_adapters.assert_awaited_with([])


def test_load_adapter_rejects_non_gguf(app_with_stub_llama, adapter_dir):
    app, _, _ = app_with_stub_llama
    junk = adapter_dir / "not_a_lora.txt"
    junk.write_text("x")
    with TestClient(app) as client:
        r = client.post("/api/load-adapter", json={"path": str(junk)})
        assert r.status_code == 400
        assert "not a .gguf" in r.json()["error"]


def test_load_adapter_rejects_missing_file(app_with_stub_llama, adapter_dir):
    app, _, _ = app_with_stub_llama
    with TestClient(app) as client:
        r = client.post("/api/load-adapter", json={"path": "/nope/missing.gguf"})
        assert r.status_code == 400


def test_chat_forces_empty_lora_when_no_adapter_active(app_with_stub_llama):
    app, captured, _ = app_with_stub_llama
    with TestClient(app) as client:
        r = client.post(
            "/api/chat",
            json={"messages": [{"role": "user", "content": "hi"}], "stream": False},
        )
        assert r.status_code == 200
    # No adapter active → gateway must send lora=[] explicitly so
    # llama-server disables every preloaded adapter for this request.
    # Returning None here used to leak the boot-time global scale of
    # the first --lora into base chat, which surfaced as the 猫娘
    # persona bleeding through even after switching back to Base
    # (real-world bug observed 2026-05-22).
    assert captured["lora_kwarg"] == []


def test_chat_includes_lora_when_adapter_active(app_with_stub_llama, adapter_dir):
    app, captured, _ = app_with_stub_llama
    target = str(adapter_dir / "lora_neko.gguf")
    with TestClient(app) as client:
        client.post("/api/load-adapter", json={"path": target})
        r = client.post(
            "/api/chat",
            json={"messages": [{"role": "user", "content": "hi"}], "stream": False},
        )
        assert r.status_code == 200
    assert captured["lora_kwarg"] == [{"id": 0, "scale": 1.0}]


def test_chat_disable_adapter_sends_empty_array(app_with_stub_llama, adapter_dir):
    app, captured, _ = app_with_stub_llama
    target = str(adapter_dir / "lora_neko.gguf")
    with TestClient(app) as client:
        client.post("/api/load-adapter", json={"path": target})
        r = client.post(
            "/api/chat",
            json={
                "messages": [{"role": "user", "content": "hi"}],
                "stream": False,
                "disable_adapter": True,
            },
        )
        assert r.status_code == 200
    # Narrator path: even though nekoqa is "active", THIS request must
    # see lora=[] so the response stays informational.
    assert captured["lora_kwarg"] == []
