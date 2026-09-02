"""The engine seam must not cost the llama.cpp path anything.

`gateway/engine.py` exists so a second inference engine (OpenVINO, for
Intel AIPC machines whose NPU llama.cpp cannot target) can slot in behind
the same route handlers. The risk that buys is regression: if extracting
the seam changes `LlamaServer` even slightly, every existing user pays
for a feature only Intel AIPC owners can use.

These tests pin the two properties that make that risk zero:

  1. `LlamaServer` satisfies `InferenceEngine` *as written* — no base
     class, no import, no edit. If someone later "tidies up" the Protocol
     by adding a member `LlamaServer` lacks, this fails immediately.
  2. `supports_adapters()` defaults to True, so both `LlamaServer` and
     the `MagicMock` that `test_adapter_endpoints.py` patches in keep
     their LoRA behaviour without declaring anything.

Plus `resolve_backend()`, which must fail *open*: a typo in
`MINICPM_BACKEND` should cost a log line, not a dead desk pet.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from gateway import engine as engine_mod
from gateway.engine import (
    BACKEND_LLAMA,
    BACKEND_OPENVINO,
    InferenceEngine,
    resolve_backend,
    supports_adapters,
)
from gateway.llama_client import LlamaServer


# ── The zero-regression guarantee ───────────────────────────────────────────


def test_llama_server_satisfies_the_engine_protocol_unmodified():
    assert isinstance(LlamaServer(model_path=None), InferenceEngine)


@pytest.mark.parametrize(
    "member",
    [
        "model_path", "port", "adapter_paths", "alive",
        "start", "stop", "health", "swap_model",
        "reload_adapters", "adapter_id_for", "stream_chat", "complete_once",
    ],
)
def test_protocol_members_all_exist_on_llama_server(member):
    # Spelled out one-per-case so a failure names the missing member
    # instead of just saying "isinstance was False".
    assert hasattr(LlamaServer(model_path=None), member)


def test_stream_chat_is_not_declared_async_on_the_protocol():
    # An async-generator *function* hands back its iterator synchronously.
    # Declaring `stream_chat` as `async def` on the Protocol would describe
    # a coroutine returning an iterator, which is not what
    # `LlamaServer.stream_chat` is — and type checkers would flag every
    # engine. Guard the shape so nobody "fixes" it later.
    import inspect

    assert not inspect.iscoroutinefunction(InferenceEngine.stream_chat)


# ── Capability probe ────────────────────────────────────────────────────────


def test_supports_adapters_defaults_true_for_undeclared_engines():
    # LlamaServer never declares the flag; neither does the MagicMock that
    # test_adapter_endpoints.py substitutes for it. Both must keep LoRA.
    assert supports_adapters(LlamaServer(model_path=None)) is True
    assert supports_adapters(MagicMock()) is True


def test_supports_adapters_honours_an_explicit_opt_out():
    class _NoAdapters:
        supports_adapters = False

    assert supports_adapters(_NoAdapters()) is False


# ── Backend name resolution ─────────────────────────────────────────────────


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("", BACKEND_LLAMA),
        ("auto", BACKEND_LLAMA),
        ("default", BACKEND_LLAMA),
        ("llama", BACKEND_LLAMA),
        ("llama.cpp", BACKEND_LLAMA),
        ("LLAMA.CPP", BACKEND_LLAMA),
        ("  llama.cpp  ", BACKEND_LLAMA),
        ("gguf", BACKEND_LLAMA),
        ("openvino", BACKEND_OPENVINO),
        ("OpenVINO", BACKEND_OPENVINO),
        ("ov", BACKEND_OPENVINO),
        ("intel", BACKEND_OPENVINO),
    ],
)
def test_resolve_backend_accepts_known_spellings(raw, expected, monkeypatch):
    monkeypatch.delenv("MINICPM_BACKEND", raising=False)
    assert resolve_backend(raw) == expected


def test_resolve_backend_fails_open_on_garbage(monkeypatch, caplog):
    monkeypatch.delenv("MINICPM_BACKEND", raising=False)

    # Not an exception, not None, not "openvino" — the default path.
    assert resolve_backend("vulkan-typo") == BACKEND_LLAMA
    assert resolve_backend("openvimo") == BACKEND_LLAMA


def test_resolve_backend_reads_the_env_when_given_none(monkeypatch):
    monkeypatch.setenv("MINICPM_BACKEND", "openvino")
    assert resolve_backend() == BACKEND_OPENVINO

    monkeypatch.delenv("MINICPM_BACKEND", raising=False)
    assert resolve_backend() == BACKEND_LLAMA


def test_resolve_backend_prefers_its_argument_over_the_env(monkeypatch):
    # `--backend` on the CLI has to win over an inherited env var, or a
    # stale MINICPM_BACKEND from the OpenVINO skill would override an
    # explicit flag.
    monkeypatch.setenv("MINICPM_BACKEND", "openvino")
    assert resolve_backend("llama.cpp") == BACKEND_LLAMA


def test_every_alias_maps_to_a_real_backend():
    assert set(engine_mod._BACKEND_ALIASES.values()) == {BACKEND_LLAMA, BACKEND_OPENVINO}
