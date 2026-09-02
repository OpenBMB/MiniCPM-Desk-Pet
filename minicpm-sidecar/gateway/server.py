"""FastAPI gateway in front of the inference engine.

Exposes the same HTTP/SSE contract the Electron app already speaks with
the legacy PyTorch sidecar, so the renderer (clawd-on-desk/src/minicpm-chat.*)
does not need to change. The actual inference happens behind
`engine.InferenceEngine`; this file is just glue.

Two engines implement that protocol, chosen by `--backend` /
`MINICPM_BACKEND` and defaulting to llama.cpp:

  · `llama_client.LlamaServer` — GGUF via a llama-server child process.
    Supports LoRA adapters and every device llama.cpp can reach.
  · `openvino_client.OpenVinoEngine` — OpenVINO IR in-process, for Intel
    AIPC (Arc iGPU / AI Boost NPU, which llama.cpp cannot target). No
    child process and no adapters.
"""

from __future__ import annotations

import asyncio
import json
import os
import platform
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncGenerator, List, Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from .clawd_state import ClawdBridge
from . import adapter_compat
from .engine import (
    BACKEND_LLAMA,
    BACKEND_OPENVINO,
    InferenceEngine,
    resolve_backend,
    supports_adapters,
)
from .llama_client import LlamaServer, detect_backend
from .log_setup import get_logger
from . import openvino_client
from .think_filter import ThinkBlockFilter
from .updater import DEFAULT_SOURCE as DEFAULT_UPDATE_SOURCE
from .updater import ModelUpdater


# ── Request / response shapes ────────────────────────────────────────────────


class ChatMessage(BaseModel):
    role: str = Field(..., description="'system' | 'user' | 'assistant'")
    content: str


class ChatRequest(BaseModel):
    messages: List[ChatMessage]
    max_new_tokens: int = 512
    temperature: float = 0.6
    top_p: float = 0.95
    top_k: int = 0
    repetition_penalty: float = 1.05
    stream: bool = True
    system: Optional[str] = None
    thinking: bool = False
    silent: bool = False  # bypass pet state pushes (used by narrator)
    # When true the gateway sends `lora: []` to llama-server for THIS
    # request only, which disables every pre-loaded LoRA adapter for the
    # current generation without touching global scales. Used by the
    # narrator so its informational replies don't pick up the active
    # persona's stylistic bias. No-op when no adapter is currently
    # active.
    disable_adapter: bool = False


# When thinking=true the model emits a <think> block before the
# answer; both share one max_new_tokens budget. Bump the floor so reasoning
# doesn't eat the entire allowance and truncate the reply.
THINKING_MIN_MAX_NEW_TOKENS = 1280
MAX_NEW_TOKENS_CAP = 4096


def _effective_max_new_tokens(req: ChatRequest) -> int:
    base = int(max(1, min(req.max_new_tokens, MAX_NEW_TOKENS_CAP)))
    if req.thinking:
        return min(MAX_NEW_TOKENS_CAP, max(base, THINKING_MIN_MAX_NEW_TOKENS))
    return base


# ── Model discovery ─────────────────────────────────────────────────────────


def _is_staging(path: Path) -> bool:
    return any(
        part.endswith((".update-staging", ".bak", ".partial")) for part in path.parts
    )


def discover_models(roots: List[Path], *, backend: str = BACKEND_LLAMA) -> List[dict]:
    """Return [{name, path, kind}] for every model under `roots`.

    For llama.cpp a model is a single `*.gguf` file; for OpenVINO it is a
    *directory* holding `openvino_model.xml` and friends. `backend`
    defaults to llama.cpp so existing positional callers (and
    tests/test_discover_models.py) keep their exact behaviour.
    """
    seen: set[Path] = set()
    emitted: set[Path] = set()
    out: List[dict] = []

    def _emit(path: Path, kind: str) -> None:
        # Dedupe on the *result*, not just the root: nested roots are
        # normal (MINICPM_MODEL_DIR's parent plus <repo>/models, say), and
        # rglob from the outer one re-finds everything in the inner one.
        if path in emitted:
            return
        emitted.add(path)
        out.append({"name": path.name, "path": str(path), "kind": kind})

    for root in roots:
        try:
            r = root.expanduser().resolve()
        except Exception:
            continue
        if not r.exists() or r in seen:
            continue
        seen.add(r)

        if backend == BACKEND_OPENVINO:
            if r.is_dir() and openvino_client.is_openvino_ir(r):
                _emit(r, "openvino")
                continue
            if not r.is_dir():
                continue
            for xml in sorted(r.rglob("openvino_model.xml")):
                d = xml.parent
                if _is_staging(d) or not openvino_client.is_openvino_ir(d):
                    continue
                _emit(d, "openvino")
            continue

        if r.is_file() and r.suffix.lower() == ".gguf":
            _emit(r, "gguf")
            continue
        if not r.is_dir():
            continue
        for p in sorted(r.rglob("*.gguf")):
            if _is_staging(p):
                continue
            _emit(p, "gguf")
    return out


def _default_model_roots() -> List[Path]:
    """Locations to scan for *.gguf when no explicit MINICPM_MODEL_DIR
    is set. The Electron host passes `--model` explicitly so this is
    only used by direct CLI / dev runs."""
    here = Path(__file__).resolve().parent.parent
    return [
        Path.home() / "Library" / "Application Support" / "Clawd on Desk" / "models",
        Path.home() / ".local" / "share" / "Clawd on Desk" / "models",
        here / "models",
        here.parent / "models",
    ]


# ── LoRA adapter discovery ──────────────────────────────────────────────────


# Filename-keyword → persona slug. The slug is the stable identifier the
# Electron renderer keys off ("default" / "neko" / "muice" / ...) when
# deciding things like whether to flip `thinking` off (persona LoRAs don't
# carry <think> training, so reasoning collides with their style).
# Matching is substring + case-insensitive against the filename stem.
PERSONA_HINTS: dict[str, str] = {
    "nekoqa": "neko",
    "neko": "neko",
    "muice": "muice",
    "chuuni": "chuuni",
    "moyu": "moyu",
    "zhiyuan": "zhiyuan",
}


def _persona_for(path: Path) -> str:
    stem = path.stem.lower()
    parent = path.parent.name.lower()
    haystack = f"{parent}/{stem}"
    for needle, slug in PERSONA_HINTS.items():
        if needle in haystack:
            return slug
    return "custom"


def _default_adapter_roots() -> List[Path]:
    """Where to scan for `*.gguf` LoRA adapters when no `MINICPM_ADAPTER_DIR`
    env is set. The Electron host normally injects that env, so this only
    runs for direct CLI / dev / test invocations.

    The order here mirrors `_default_model_roots`: per-user app data first,
    then the dev-only repo path next to the sidecar package.
    """
    here = Path(__file__).resolve().parent.parent
    return [
        Path.home() / "Library" / "Application Support" / "Clawd on Desk" / "adapters",
        Path.home() / ".local" / "share" / "Clawd on Desk" / "adapters",
        here.parent / "adapters",   # <repo>/adapters/ in dev checkouts
    ]


def discover_adapters(roots: List[Path]) -> List[dict]:
    """Return [{name, path, persona}] for every `*.gguf` LoRA under `roots`.

    Skips electron-builder staging / backup directories the same way
    `discover_models` does, so we don't accidentally surface half-downloaded
    adapters."""
    seen_files: set[Path] = set()
    out: List[dict] = []
    for root in roots:
        try:
            r = root.expanduser().resolve()
        except Exception:
            continue
        if not r.exists() or not r.is_dir():
            continue
        for p in sorted(r.rglob("*.gguf")):
            if any(part.endswith(".update-staging") or part.endswith(".bak") for part in p.parts):
                continue
            try:
                resolved = p.resolve()
            except Exception:
                continue
            if resolved in seen_files:
                continue
            seen_files.add(resolved)
            out.append({
                "name": p.name,
                "path": str(p),
                "persona": _persona_for(p),
            })
    return out


def _resolve_adapter_root(initial_model: Optional[Path]) -> Optional[Path]:
    """Pick the canonical writable adapter dir for `/api/load-adapter`
    "open in Finder" hints. Resolution order:

    1. `MINICPM_ADAPTER_DIR` env (Electron host injects this in packaged
       mode pointing at `<userData>/adapters/`)
    2. First default root that already exists
    3. First default root regardless of existence (the caller can then
       `mkdir -p` before opening Finder)
    """
    env_dir = os.environ.get("MINICPM_ADAPTER_DIR")
    if env_dir:
        return Path(env_dir).expanduser()
    for cand in _default_adapter_roots():
        if cand.exists() and cand.is_dir():
            return cand
    defaults = _default_adapter_roots()
    return defaults[-1] if defaults else None


# Mirror file Electron writes after every manifest mutation. Lives in
# the adapter dir under a dot prefix so `discover_adapters`'s `*.gguf`
# scan misses it. Schema mirrors `<userData>/minicpm-adapters.json` 1:1
# (see clawd-on-desk/src/minicpm-chat.js).
_MANIFEST_MIRROR = ".manifest.json"


def read_adapter_manifest(adapter_root: Optional[Path]) -> dict:
    """Return the parsed `.manifest.json` from `adapter_root`, or an
    empty manifest if the file is absent / malformed.

    The gateway is a pure reader here — Electron owns the data and
    re-writes the mirror on every CRUD operation. Reading on every
    `/api/adapters` request keeps us a snapshot fresh without an
    explicit refresh endpoint."""
    if adapter_root is None:
        return {"version": 1, "items": []}
    try:
        mirror = Path(adapter_root) / _MANIFEST_MIRROR
        if not mirror.is_file():
            return {"version": 1, "items": []}
        with mirror.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return {"version": 1, "items": []}
    if not isinstance(data, dict):
        return {"version": 1, "items": []}
    items = data.get("items") if isinstance(data.get("items"), list) else []
    return {"version": int(data.get("version") or 1), "items": items}


def _manifest_by_resolved_path(manifest: dict) -> dict[Path, dict]:
    """Index manifest items by their resolved absolute path so the
    `/api/adapters` merge step is O(1) per scanned file."""
    out: dict[Path, dict] = {}
    for entry in manifest.get("items", []) or []:
        if not isinstance(entry, dict):
            continue
        raw = entry.get("path")
        if not isinstance(raw, str) or not raw:
            continue
        try:
            out[Path(raw).expanduser().resolve()] = entry
        except Exception:
            continue
    return out


# ── App factory ──────────────────────────────────────────────────────────────


def build_app(
    *,
    initial_model: Optional[Path],
    update_source: str = DEFAULT_UPDATE_SOURCE,
    ctx_size: int = 4096,
    n_gpu_layers: int = -1,
    threads: Optional[int] = None,
    backend: Optional[str] = None,
) -> FastAPI:
    log = get_logger()
    bridge = ClawdBridge(enabled=True, debug=False)
    backend = resolve_backend(backend)

    # Resolve the adapter root so /api/adapters can scan it; we still
    # show the full list to the UI even when none are loaded yet, so
    # users can browse + activate any LoRA from Settings.
    adapter_root = _resolve_adapter_root(initial_model)

    # Boot-time LoRA load is now *opt-in*: only the LoRA the Electron
    # host has persisted as the active one (env MINICPM_ACTIVE_ADAPTER)
    # gets passed to llama-server via --lora. Default behaviour is pure
    # Base — no third-party LoRA is preloaded just because it happens
    # to live on disk. Switching to a different LoRA later triggers
    # `LlamaServer.reload_adapters([new])`, costing one llama-server
    # restart but keeping the steady-state memory minimal.
    _env_active = os.environ.get("MINICPM_ACTIVE_ADAPTER", "").strip()
    initial_active: Optional[Path] = None
    if _env_active:
        try:
            cand = Path(_env_active).expanduser().resolve(strict=True)
            if cand.suffix.lower() == ".gguf":
                initial_active = cand
            else:
                log.warning("MINICPM_ACTIVE_ADAPTER ignored (not .gguf): %s", cand)
        except FileNotFoundError:
            log.warning("MINICPM_ACTIVE_ADAPTER points at missing file: %s", _env_active)

    if backend == BACKEND_OPENVINO:
        # In-process pipeline: no child, no adapters, no gguf. See
        # openvino_client for why the device choice is guarded.
        server = openvino_client.OpenVinoEngine(
            model_path=initial_model,
            ctx_size=ctx_size,
        )
        if initial_active:
            log.warning(
                "MINICPM_ACTIVE_ADAPTER ignored: the openvino backend has no "
                "LoRA support (weights are baked into the IR)"
            )
            initial_active = None
    else:
        server = LlamaServer(
            model_path=initial_model,
            ctx_size=ctx_size,
            n_gpu_layers=n_gpu_layers,
            threads=threads,
            adapters=[initial_active] if initial_active else [],
        )

    def detect_devices() -> dict:
        """`/api/devices` payload for whichever engine is loaded."""
        if backend == BACKEND_OPENVINO:
            return openvino_client.detect_devices()
        return detect_backend()

    # In-memory adapter state. Single source of truth for what the
    # Electron app sees as "the active LoRA". Boots from the persisted
    # choice; cleared on /api/load-adapter {path:null}; updated to a
    # new path on /api/load-adapter {path:<gguf>}. The Electron host
    # is responsible for writing the latest choice back to its prefs
    # file so the next sidecar spawn boots into the same state.
    state: dict[str, Optional[Path]] = {"current_adapter": initial_active}
    startup_error: Optional[str] = None

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        nonlocal startup_error
        # Don't fail boot when the model isn't on disk yet — onboarding
        # downloads it via /api/update-apply and only then calls
        # /api/load-model. The pet still wants /api/health to answer 200
        # in the meantime so the bubble doesn't show a permanent error.
        if initial_model and Path(initial_model).exists():
            try:
                await server.start()
                startup_error = None
            except Exception as exc:
                startup_error = str(exc)
                log.exception("initial llama-server start failed: %s", exc)
        else:
            log.info("model not present at startup; waiting for /api/load-model")
        bridge.post("idle", title="MiniCPM 桌宠")
        try:
            yield
        finally:
            bridge.post("sleeping")
            try:
                await server.stop()
            finally:
                bridge.close()

    app = FastAPI(title="MiniCPM Sidecar Gateway", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Model roots used by /api/models — honour the env override the
    # Electron host sets to <userData>/models/ in packaged mode.
    env_root = os.environ.get("MINICPM_MODEL_DIR")
    extra_roots: List[Path] = []
    if env_root:
        extra_roots.append(Path(env_root))
    if initial_model:
        extra_roots.append(Path(initial_model).expanduser().resolve().parent)
    extra_roots.extend(_default_model_roots())

    def _get_active_model_path() -> Path:
        if server.model_path:
            return server.model_path
        if initial_model:
            return Path(initial_model)
        # Fall back to the first discovered gguf so /api/update-check
        # always has *some* anchor to compare against.
        items = discover_models(extra_roots, backend=backend)
        if items:
            return Path(items[0]["path"])
        # Last resort: synthesise a stub path so updater code can still
        # compute target_dir for download staging.
        return (extra_roots[0] if extra_roots else Path.cwd()) / "minicpm.gguf"

    updater = ModelUpdater(_get_active_model_path(), source=update_source)

    # ─── Health / introspection ────────────────────────────────────────

    @app.get("/api/health")
    async def health():
        sub_health = await server.health()
        devices = detect_devices()
        adapter = state["current_adapter"]
        current = devices.get("current") or devices["recommended"]
        return {
            "ok": True,
            "alive": server.alive,
            "backend": backend,
            "accel": current,
            "device": current,  # alias used by older Electron code paths
            "dtype": "openvino-ir" if backend == BACKEND_OPENVINO else "gguf",
            "model_dir": str(server.model_path) if server.model_path else None,
            "model_name": server.model_path.name if server.model_path else None,
            "adapter": str(adapter) if adapter else None,
            "persona": _persona_for(adapter) if adapter else "default",
            # Key name kept for compatibility: the Electron host gates
            # readiness on `health.llama_server.status === "ok"` in five
            # places. `engine` is the same blob under a truthful name.
            "llama_server": sub_health,
            "engine": sub_health,
            "port": server.port,
            "startup_error": startup_error,
        }

    @app.get("/api/devices")
    def list_devices():
        return detect_devices()

    @app.post("/api/set-device")
    async def set_device(payload: dict):
        device = str(payload.get("device") or "").strip().lower()

        if backend == BACKEND_OPENVINO:
            if device not in ("cpu", "gpu", "npu", "auto", ""):
                return JSONResponse({"error": f"unknown device: {device!r}"}, status_code=400)
            available = detect_devices().get("available") or []
            if device and device != "auto" and device not in available:
                return JSONResponse(
                    {"error": f"device not available on this machine: {device!r}"},
                    status_code=400,
                )
            if device == "npu":
                # Second line of defence for openvino#35641. The engine
                # refuses at load time too, but catching it here turns a
                # dead sidecar into a toast the user can act on.
                target = server.model_path
                if target:
                    precision = openvino_client.inspect_ir_precision(Path(target))
                    if not precision.npu_ready:
                        return JSONResponse(
                            {
                                "error": (
                                    f"the loaded model is {precision.describe()}; the NPU "
                                    "needs a symmetric INT4 IR. Convert one with "
                                    "scripts/convert-openvino.py --preset npu"
                                )
                            },
                            status_code=400,
                        )
            openvino_client.invalidate_device_cache()
        else:
            if device not in ("metal", "cuda", "cpu", "vulkan", "mps", "auto", ""):
                return JSONResponse({"error": f"unknown device: {device!r}"}, status_code=400)
            # "mps" is the legacy name for Apple Silicon; transparently map
            # to metal for consistency with llama.cpp terminology.
            if device == "mps":
                device = "metal"
            if device == "vulkan" and platform.system() != "Windows":
                return JSONResponse(
                    {"error": "vulkan backend is only configurable on Windows"},
                    status_code=400,
                )

        if device:
            os.environ["MINICPM_DEVICE"] = device
        else:
            os.environ.pop("MINICPM_DEVICE", None)
        return {"ok": True, "device": device or "auto", "note": "restart sidecar to take effect"}

    @app.get("/api/onboarding")
    def onboarding():
        path = server.model_path or _get_active_model_path()
        present = path.exists() if path else False
        adapter = state["current_adapter"]
        devices = detect_devices()
        return {
            "model_present": present,
            "model_dir": str(path) if path else None,
            "device": devices.get("current") or devices["recommended"],
            "dtype": "openvino-ir" if backend == BACKEND_OPENVINO else "gguf",
            "adapter": str(adapter) if adapter else None,
            "persona": _persona_for(adapter) if adapter else "default",
            "stage_hint": "ready" if present else "model-download",
        }

    # ─── Model / adapter listing ───────────────────────────────────────

    @app.get("/api/models")
    def list_models():
        items = discover_models(extra_roots, backend=backend)
        current = str(server.model_path) if server.model_path else None
        return {
            "items": items,
            "current": current,
            "current_name": server.model_path.name if server.model_path else None,
        }

    @app.post("/api/load-model")
    async def load_model(payload: dict):
        nonlocal startup_error
        path = str(payload.get("path") or "").strip()
        if not path:
            return JSONResponse({"error": "path is required"}, status_code=400)
        target = Path(path).expanduser().resolve()
        if backend == BACKEND_OPENVINO:
            reason = openvino_client.validate_openvino_ir(target)
            if reason:
                return JSONResponse({"error": reason}, status_code=400)
        elif not target.is_file() or target.suffix.lower() != ".gguf":
            return JSONResponse({"error": f"not a .gguf file: {target}"}, status_code=400)
        bridge.post("working", event="LoadModel", title=f"加载 {target.name}")
        try:
            await server.swap_model(target)
            updater.local_model_path = target
            startup_error = None
        except Exception as exc:
            startup_error = str(exc)
            bridge.post("error")
            return JSONResponse({"error": str(exc)}, status_code=500)
        bridge.post("idle")
        return {"ok": True, "model_dir": str(target), "model_name": target.name}

    def _scan_adapters() -> List[dict]:
        # Re-resolve the root each call so Settings → "open adapter dir"
        # → drop new .gguf → "refresh" picks up files added at runtime
        # without restarting the sidecar. Also re-read the manifest
        # mirror on every call so rename / upload mutations show up in
        # the next /api/adapters response without any explicit refresh
        # ping from Electron.
        if not supports_adapters(server):
            # Don't offer clickable personas the backend will 501 on.
            return []
        root = _resolve_adapter_root(server.model_path)
        if not root:
            return []
        items = discover_adapters([root])
        manifest = read_adapter_manifest(root)
        by_path = _manifest_by_resolved_path(manifest)
        for item in items:
            try:
                key = Path(item["path"]).expanduser().resolve()
            except Exception:
                continue
            entry = by_path.get(key)
            if not entry:
                continue
            # Only surface the product-layer fields; gateway's persona
            # slug already on `item` wins by default but a manifest
            # override (user typed their own) takes precedence.
            if isinstance(entry.get("displayName"), str) and entry["displayName"].strip():
                item["displayName"] = entry["displayName"].strip()
            if isinstance(entry.get("aliases"), list):
                item["aliases"] = [str(a).strip() for a in entry["aliases"] if str(a).strip()]
            if isinstance(entry.get("source"), str):
                item["source"] = entry["source"]
            if isinstance(entry.get("id"), str):
                item["id"] = entry["id"]
            if isinstance(entry.get("persona"), str) and entry["persona"].strip():
                item["persona"] = entry["persona"].strip()

        # Tell the UI which entries would crash if picked, so it can grey
        # them out with a reason instead of letting the user find out by
        # killing their own desk pet.
        for item in items:
            try:
                reason = adapter_compat.adapter_mismatch_reason(
                    Path(item["path"]), server.model_path
                )
            except Exception:
                reason = None
            if reason:
                item["incompatible"] = True
                item["incompatibleReason"] = reason
        return items

    @app.get("/api/adapters")
    def list_adapters():
        items = _scan_adapters()
        current = state["current_adapter"]
        return {
            "items": items,
            "current": str(current) if current else None,
            "current_name": current.name if current else None,
            "adapter_dir": str(_resolve_adapter_root(server.model_path) or ""),
        }

    @app.post("/api/load-adapter")
    async def load_adapter(payload: dict):
        raw = payload.get("path")
        # path = null  →  deactivate any LoRA (back to base model)
        if raw is None or (isinstance(raw, str) and not raw.strip()):
            # If llama-server was booted with `--lora <something>`, a
            # per-request `lora: []` is enough to force base output on
            # modern llama.cpp. We still respawn with no `--lora` here
            # so switching back to Base releases the adapter weights too.
            if server.adapter_paths:
                bridge.post("working", event="UnloadAdapter", title="卸载 LoRA")
                try:
                    await server.reload_adapters([])
                except Exception as exc:
                    bridge.post("error")
                    return JSONResponse({"error": str(exc)}, status_code=500)
                bridge.post("idle")
            state["current_adapter"] = None
            return {"ok": True, "adapter": None, "persona": "default"}

        # Deactivation above still works on every backend ("back to Base"
        # is always a valid request); only *activating* one needs support.
        if not supports_adapters(server):
            return JSONResponse(
                {
                    "error": (
                        f"LoRA adapters are not supported by the {backend} backend — "
                        "weights are baked into the IR at conversion time"
                    )
                },
                status_code=501,
            )

        target = Path(str(raw)).expanduser()
        try:
            target = target.resolve(strict=True)
        except FileNotFoundError:
            return JSONResponse(
                {"error": f"adapter file not found: {target}"},
                status_code=400,
            )
        if target.suffix.lower() != ".gguf":
            return JSONResponse(
                {"error": f"not a .gguf adapter: {target}"},
                status_code=400,
            )

        # An adapter trained on a different base does not degrade — it
        # takes llama-server down with a shape error and an access
        # violation, leaving the user with a wall of logs and a dead pet
        # after doing nothing worse than picking a persona the UI offered.
        # Check the geometry first; the helper fails open, so an
        # unreadable file still loads exactly as it used to.
        mismatch = adapter_compat.adapter_mismatch_reason(target, server.model_path)
        if mismatch:
            log.warning("refusing incompatible adapter %s: %s", target.name, mismatch)
            return JSONResponse({"error": mismatch}, status_code=409)

        # If the requested adapter isn't currently `--lora`-loaded,
        # restart llama-server so that ONLY this adapter is loaded.
        # We deliberately don't keep a growing list of preloaded LoRAs
        # in memory — that was the old behaviour, and it meant any
        # third-party `.gguf` on disk silently rode along whether the
        # user wanted it or not. The user pays one sidecar restart
        # (~3-4s) per LoRA switch, which matches the cost of switching
        # base models and is the only honest way to keep memory tight.
        if server.adapter_id_for(target) is None:
            bridge.post("working", event="LoadAdapter", title=f"加载 {target.name}")
            try:
                await server.reload_adapters([target])
            except Exception as exc:
                bridge.post("error")
                return JSONResponse({"error": str(exc)}, status_code=500)
            bridge.post("idle")
            if server.adapter_id_for(target) is None:
                return JSONResponse(
                    {"error": f"llama-server refused adapter: {target}"},
                    status_code=500,
                )

        state["current_adapter"] = target
        return {
            "ok": True,
            "adapter": str(target),
            "persona": _persona_for(target),
        }

    @app.post("/api/classify")
    def classify_endpoint(payload: dict):
        return JSONResponse(
            {"error": f"/api/classify not implemented for the {backend} backend yet"},
            status_code=501,
        )

    # ─── Updater ───────────────────────────────────────────────────────

    @app.get("/api/update-check")
    async def update_check():
        updater.local_model_path = server.model_path or _get_active_model_path()
        return await asyncio.to_thread(updater.check)

    @app.post("/api/update-apply")
    async def update_apply():
        nonlocal startup_error
        updater.local_model_path = server.model_path or _get_active_model_path()

        async def stream():
            nonlocal startup_error
            queue: asyncio.Queue = asyncio.Queue()
            sentinel = object()
            loop = asyncio.get_running_loop()

            def producer():
                try:
                    for ev in updater.apply():
                        loop.call_soon_threadsafe(queue.put_nowait, ev)
                finally:
                    loop.call_soon_threadsafe(queue.put_nowait, sentinel)

            import threading as _t
            _t.Thread(target=producer, daemon=True).start()

            bridge.post("working", event="UpdateApply", title="正在更新模型")
            try:
                while True:
                    ev = await queue.get()
                    if ev is sentinel:
                        break
                    yield _sse(ev)
                    if ev.get("phase") == "complete":
                        try:
                            # Restart llama-server against the (potentially
                            # renamed) gguf so the new weights take effect
                            # without a full sidecar restart.
                            items = discover_models(extra_roots, backend=backend)
                            if items:
                                target = Path(items[0]["path"])
                                await server.swap_model(target)
                                updater.local_model_path = target
                                startup_error = None
                                yield _sse({"phase": "reloaded", "model": str(target)})
                        except Exception as exc:
                            startup_error = str(exc)
                            yield _sse({"phase": "reload-error", "message": str(exc)})
            finally:
                bridge.post("idle")

        return StreamingResponse(stream(), media_type="text/event-stream")

    # ─── Chat ──────────────────────────────────────────────────────────

    @app.post("/api/warmup")
    async def warmup():
        if not server.alive:
            return JSONResponse({"ok": False, "error": "llama-server not running"}, status_code=503)
        t0 = time.time()
        try:
            await server.complete_once(prompt=" ", max_tokens=1)
            return {"ok": True, "elapsed_ms": int((time.time() - t0) * 1000)}
        except Exception as exc:
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=500)

    def _lora_arr_for(req: ChatRequest) -> Optional[List[dict]]:
        """Compute the per-request `lora` array.

        - disable_adapter=true  → []   (force base for this request)
        - active adapter set    → [{id, scale: 1.0}]
        - no adapter active     → []   (force base)

        Sending an empty list is intentionally explicit: llama.cpp
        treats adapters omitted from a per-request `lora` list as scale
        0.0, so base chat never depends on whatever global adapter scale
        the server happened to inherit at startup.
        """
        if not supports_adapters(server):
            # None, not [] — "the engine has no adapter concept at all",
            # as opposed to "explicitly run this request without one".
            # llama_client only adds the field when it is not None.
            return None
        if req.disable_adapter:
            return []
        current = state["current_adapter"]
        if not current:
            return []
        idx = server.adapter_id_for(current)
        if idx is None:
            # State got out of sync (e.g. sidecar restarted without
            # re-registering this path). Fail open to base rather than
            # 500 — the user will notice the persona is gone and can
            # re-select from Settings.
            log.warning("active adapter %s missing from llama-server index", current)
            return []
        return [{"id": idx, "scale": 1.0}]

    @app.post("/api/chat")
    async def chat(req: ChatRequest):
        if not req.messages:
            return JSONResponse({"error": "messages is empty"}, status_code=400)
        if not server.alive:
            return JSONResponse(
                {"error": "llama-server not running — open Onboarding to download the model"},
                status_code=503,
            )
        lora_arr = _lora_arr_for(req)
        if req.stream:
            return StreamingResponse(
                _stream_chat(server, bridge, req, lora=lora_arr),
                media_type="text/event-stream",
            )
        return JSONResponse(await _blocking_chat(server, bridge, req, lora=lora_arr))

    @app.post("/api/state")
    def manual_state(payload: dict):
        state = str(payload.get("state") or "idle")
        bridge.post(state, event=payload.get("event"))
        return {"ok": True}

    @app.get("/")
    def index():
        return JSONResponse({
            "ok": True,
            "note": f"MiniCPM sidecar gateway ({backend} backend)",
            "endpoints": [
                "/api/health", "/api/chat", "/api/warmup",
                "/api/models", "/api/load-model",
                "/api/devices", "/api/set-device", "/api/onboarding",
                "/api/update-check", "/api/update-apply",
                "/api/adapters", "/api/load-adapter", "/api/classify",
                "/api/state",
            ],
        })

    return app


# ── Chat plumbing ───────────────────────────────────────────────────────────


async def _stream_chat(
    server: InferenceEngine,
    bridge: ClawdBridge,
    req: ChatRequest,
    *,
    lora: Optional[List[dict]] = None,
) -> AsyncGenerator[bytes, None]:
    if not req.silent:
        bridge.new_session()
        bridge.post("thinking")

    messages = _build_messages(req)

    try:
        agen = server.stream_chat(
            messages=messages,
            max_tokens=_effective_max_new_tokens(req),
            temperature=max(0.0, float(req.temperature)),
            top_p=float(req.top_p),
            top_k=int(req.top_k),
            repetition_penalty=float(req.repetition_penalty),
            enable_thinking=bool(req.thinking),
            lora=lora,
        )
    except Exception as exc:
        if not req.silent:
            bridge.post("error")
        yield _sse({"event": "error", "message": str(exc)})
        return

    yield _sse({"event": "start"})
    if not req.silent:
        bridge.post("working")

    last_pet_ping = time.time()
    # ThinkBlockFilter is the safety net: when llama-server *doesn't*
    # pre-split reasoning into reasoning_content (e.g. running against
    # a non-MiniCPM5 GGUF, or with --jinja off), <think> tags may leak
    # into the content stream. We still want to route them to the right
    # event in that case, so we run the filter only over content chunks.
    think_filter = ThinkBlockFilter(expose=req.thinking, start_inside=False)

    try:
        async for kind, piece in agen:
            if kind == "reasoning":
                # llama.cpp already split <think>...</think> for us.
                # Surface it as "think" when the caller asked for it,
                # otherwise drop silently.
                if req.thinking:
                    yield _sse({"event": "think", "content": piece})
            else:  # "content"
                for ev in think_filter.feed(piece):
                    yield _sse(ev)
            now = time.time()
            if now - last_pet_ping > 6.0:
                if not req.silent:
                    bridge.post("working")
                last_pet_ping = now
    except asyncio.CancelledError:
        if not req.silent:
            bridge.post("attention")
        raise
    except Exception as exc:
        get_logger().exception("chat stream error: %s", exc)
        if not req.silent:
            bridge.post("error")
        yield _sse({"event": "error", "message": str(exc)})
        return
    finally:
        for ev in think_filter.flush():
            yield _sse(ev)

    yield _sse({"event": "end"})
    if not req.silent:
        bridge.post("attention")


async def _blocking_chat(
    server: InferenceEngine,
    bridge: ClawdBridge,
    req: ChatRequest,
    *,
    lora: Optional[List[dict]] = None,
) -> dict:
    if not req.silent:
        bridge.new_session()
        bridge.post("thinking")
    messages = _build_messages(req)
    think_filter = ThinkBlockFilter(expose=req.thinking, start_inside=False)
    content_parts: list[str] = []
    think_parts: list[str] = []
    if not req.silent:
        bridge.post("working")
    try:
        async for kind, piece in server.stream_chat(
            messages=messages,
            max_tokens=_effective_max_new_tokens(req),
            temperature=max(0.0, float(req.temperature)),
            top_p=float(req.top_p),
            top_k=int(req.top_k),
            repetition_penalty=float(req.repetition_penalty),
            enable_thinking=bool(req.thinking),
            lora=lora,
        ):
            if kind == "reasoning":
                think_parts.append(piece)
            else:
                for ev in think_filter.feed(piece):
                    (think_parts if ev["event"] == "think" else content_parts).append(ev["content"])
        for ev in think_filter.flush():
            (think_parts if ev["event"] == "think" else content_parts).append(ev["content"])
    finally:
        if not req.silent:
            bridge.post("attention")
    return {
        "content": "".join(content_parts),
        "thinking": "".join(think_parts) if req.thinking else None,
    }


def _build_messages(req: ChatRequest) -> list[dict]:
    out: list[dict] = []
    if req.system:
        out.append({"role": "system", "content": req.system})
    for m in req.messages:
        out.append({"role": m.role, "content": m.content})
    return out


def _sse(payload: dict) -> bytes:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode("utf-8")
