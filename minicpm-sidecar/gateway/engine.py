"""Backend-agnostic seam between `server.py` and whatever runs the model.

`InferenceEngine` is a structural Protocol, not an ABC, so `LlamaServer`
satisfies it unmodified — the llama.cpp path cannot regress, and existing
tests that patch in a `MagicMock` keep working.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import AsyncIterator, Optional, Protocol, runtime_checkable

from .log_setup import get_logger


# ── Backend identifiers ─────────────────────────────────────────────────────

BACKEND_LLAMA = "llama.cpp"
BACKEND_OPENVINO = "openvino"

_BACKEND_ALIASES = {
    "": BACKEND_LLAMA,
    "auto": BACKEND_LLAMA,
    "default": BACKEND_LLAMA,
    "llama": BACKEND_LLAMA,
    "llama.cpp": BACKEND_LLAMA,
    "llamacpp": BACKEND_LLAMA,
    "llama_cpp": BACKEND_LLAMA,
    "gguf": BACKEND_LLAMA,
    "openvino": BACKEND_OPENVINO,
    "ov": BACKEND_OPENVINO,
    "intel": BACKEND_OPENVINO,
}


def resolve_backend(raw: Optional[str] = None) -> str:
    """Normalise `--backend` / `MINICPM_BACKEND`.

    Fails open to llama.cpp: a typo must not take down the default path.
    """
    value = (raw if raw is not None else os.environ.get("MINICPM_BACKEND", "")).strip().lower()
    resolved = _BACKEND_ALIASES.get(value)
    if resolved is None:
        get_logger().warning(
            "unknown backend %r; falling back to %s. Known values: %s",
            value, BACKEND_LLAMA, ", ".join(sorted(set(_BACKEND_ALIASES.values()))),
        )
        return BACKEND_LLAMA
    return resolved


# ── The engine contract ─────────────────────────────────────────────────────


@runtime_checkable
class InferenceEngine(Protocol):
    """What `server.py` needs from an inference engine.

    Read-only properties, not plain attributes: that form is satisfied by
    either an instance attribute or a real `@property`, which `LlamaServer`
    mixes.
    """

    @property
    def model_path(self) -> Optional[Path]:
        """The .gguf file (llama.cpp) or IR directory (OpenVINO) in use."""

    @property
    def port(self) -> int:
        """Child server port, or 0 for in-process engines."""

    @property
    def adapter_paths(self) -> list[Path]: ...

    @property
    def alive(self) -> bool: ...

    async def start(self) -> None: ...

    async def stop(self, *, timeout: float = 5.0) -> None: ...

    async def health(self) -> Optional[dict]:
        """Engine-specific health blob, or None when unreachable."""

    async def swap_model(self, model_path: Path) -> None: ...

    async def reload_adapters(self, paths: list[Path]) -> None: ...

    def adapter_id_for(self, path: Path) -> Optional[int]: ...

    # NOT `async def`: an async-generator function returns its iterator
    # synchronously, so `async def` here would not match LlamaServer.
    def stream_chat(
        self,
        *,
        messages: list[dict],
        max_tokens: int,
        temperature: float,
        top_p: float,
        top_k: int,
        repetition_penalty: float,
        stop: Optional[list[str]] = None,
        enable_thinking: bool = True,
        lora: Optional[list[dict]] = None,
    ) -> AsyncIterator[tuple[str, str]]:
        """Yield `(kind, text)` where kind is "content" or "reasoning".

        Engines that cannot pre-split reasoning yield only "content" and
        let `ThinkBlockFilter` split downstream.
        """

    async def complete_once(
        self, *, prompt: str, max_tokens: int = 1, temperature: float = 0.0
    ) -> dict: ...


# ── Capability probes ───────────────────────────────────────────────────────


def supports_adapters(engine: object) -> bool:
    """Whether `engine` can load LoRA adapters.

    `getattr` with a default so `LlamaServer` gains the capability without
    declaring it; engines opt out with `supports_adapters = False`.
    """
    return bool(getattr(engine, "supports_adapters", True))
