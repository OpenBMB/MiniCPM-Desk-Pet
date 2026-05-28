from __future__ import annotations

import sys
from pathlib import Path

from fastapi.testclient import TestClient

from gateway import llama_client
from gateway import server as server_mod


def test_windows_auto_normalises_to_cpu(monkeypatch):
    monkeypatch.delenv("MINICPM_DEVICE", raising=False)
    monkeypatch.setattr(llama_client.platform, "system", lambda: "Windows")
    monkeypatch.setattr(llama_client.platform, "machine", lambda: "AMD64")

    assert llama_client._normalise_device("auto") == "cpu"
    assert llama_client._normalise_device("") == "cpu"


def test_macos_auto_normalises_to_metal(monkeypatch):
    monkeypatch.delenv("MINICPM_DEVICE", raising=False)
    monkeypatch.setattr(llama_client.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(llama_client.platform, "machine", lambda: "arm64")

    assert llama_client._normalise_device("auto") == "metal"


def test_windows_devices_reports_cpu_recommended_and_vulkan_experimental(tmp_path, monkeypatch):
    vulkan = tmp_path / "llama-server.exe"
    vulkan.write_text("", encoding="utf-8")
    monkeypatch.delenv("MINICPM_DEVICE", raising=False)
    monkeypatch.setattr(llama_client.platform, "system", lambda: "Windows")
    monkeypatch.setattr(llama_client.platform, "machine", lambda: "AMD64")
    monkeypatch.setattr(
        llama_client,
        "_candidate_binary_paths",
        lambda device=None: [vulkan] if device == "vulkan" else [],
    )

    info = llama_client.detect_backend()

    assert info["recommended"] == "cpu"
    assert info["current"] == "cpu"
    assert "cpu" in info["available"]
    assert "vulkan" in info["available"]
    assert "vulkan" in info["experimental"]


def test_macos_devices_do_not_expose_vulkan(monkeypatch):
    monkeypatch.setenv("MINICPM_DEVICE", "vulkan")
    monkeypatch.setattr(llama_client.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(llama_client.platform, "machine", lambda: "arm64")
    monkeypatch.setattr(llama_client.shutil, "which", lambda _name: None)

    info = llama_client.detect_backend()

    assert llama_client._normalise_device("vulkan") == "metal"
    assert info["recommended"] == "metal"
    assert info["current"] == "metal"
    assert "vulkan" not in info["available"]
    assert "vulkan" not in info["experimental"]


def test_windows_vulkan_binary_paths_do_not_fall_back_to_default_cpu(monkeypatch):
    monkeypatch.setattr(llama_client.platform, "system", lambda: "Windows")
    monkeypatch.setattr(llama_client.platform, "machine", lambda: "AMD64")
    monkeypatch.setattr(llama_client, "_platform_triple", lambda: "win-x64")
    monkeypatch.setattr(llama_client.shutil, "which", lambda _name: None)
    monkeypatch.setattr(sys, "frozen", False, raising=False)
    monkeypatch.delenv("MINICPM_LLAMA_SERVER", raising=False)

    paths = llama_client._candidate_binary_paths("vulkan")
    rendered = [str(p) for p in paths]

    assert any("backends/vulkan" in s.replace("\\", "/") for s in rendered)
    assert not any(s.replace("\\", "/").endswith("bin/win-x64/llama-server.exe") for s in rendered)
    assert not any(s.replace("\\", "/").endswith("llama.cpp/build/bin/llama-server.exe") for s in rendered)


def test_windows_vulkan_binary_paths_ignore_generic_override(monkeypatch, tmp_path):
    override = tmp_path / "cpu-override.exe"
    override.write_text("", encoding="utf-8")
    monkeypatch.setenv("MINICPM_LLAMA_SERVER", str(override))
    monkeypatch.setattr(llama_client.platform, "system", lambda: "Windows")
    monkeypatch.setattr(llama_client.platform, "machine", lambda: "AMD64")
    monkeypatch.setattr(llama_client, "_platform_triple", lambda: "win-x64")
    monkeypatch.setattr(llama_client.shutil, "which", lambda _name: None)
    monkeypatch.setattr(sys, "frozen", False, raising=False)

    paths = llama_client._candidate_binary_paths("vulkan")

    assert override not in paths


def test_cpu_backend_does_not_pass_gpu_layers(tmp_path):
    model = tmp_path / "model.gguf"
    model.write_text("", encoding="utf-8")
    server = llama_client.LlamaServer(model_path=model, n_gpu_layers=-1)
    server.device = "cpu"
    server._binary = Path("llama-server.exe")
    server.port = 18766

    argv = server._build_argv()

    assert "--gpu-layers" not in argv


def test_set_device_rejects_vulkan_off_windows(monkeypatch):
    monkeypatch.setenv("MINICPM_DEVICE", "metal")
    monkeypatch.setattr(server_mod.platform, "system", lambda: "Darwin")
    app = server_mod.build_app(initial_model=None)

    with TestClient(app) as client:
        response = client.post("/api/set-device", json={"device": "vulkan"})

    assert response.status_code == 400
    assert "only configurable on Windows" in response.json()["error"]
    assert llama_client.os.environ["MINICPM_DEVICE"] == "metal"
