"""FastAPI gateway in front of llama.cpp's llama-server.

Exposes the same HTTP/SSE contract the Electron app already speaks with
the legacy PyTorch sidecar, so the renderer (clawd-on-desk/src/minicpm-chat.*)
does not need to change. The actual inference happens in the subprocess
owned by `LlamaServer`; this file is just glue.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncGenerator, List, Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from .clawd_state import ClawdBridge
from .llama_client import LlamaServer, detect_backend
from .log_setup import get_logger
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


def discover_models(roots: List[Path]) -> List[dict]:
    """Return [{name, path}] for every *.gguf file under `roots`."""
    seen: set[Path] = set()
    out: List[dict] = []
    for root in roots:
        try:
            r = root.expanduser().resolve()
        except Exception:
            continue
        if not r.exists() or r in seen:
            continue
        seen.add(r)
        if r.is_file() and r.suffix.lower() == ".gguf":
            out.append({"name": r.name, "path": str(r)})
            continue
        if not r.is_dir():
            continue
        for p in sorted(r.rglob("*.gguf")):
            if any(part.endswith(".update-staging") or part.endswith(".bak") for part in p.parts):
                continue
            out.append({"name": p.name, "path": str(p)})
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
) -> FastAPI:
    log = get_logger()
    bridge = ClawdBridge(enabled=True, debug=False)

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

    server = LlamaServer(
        model_path=initial_model,
        ctx_size=ctx_size,
        n_gpu_layers=n_gpu_layers,
        threads=threads,
        adapters=[initial_active] if initial_active else [],
    )

    # In-memory adapter state. Single source of truth for what the
    # Electron app sees as "the active LoRA". Boots from the persisted
    # choice; cleared on /api/load-adapter {path:null}; updated to a
    # new path on /api/load-adapter {path:<gguf>}. The Electron host
    # is responsible for writing the latest choice back to its prefs
    # file so the next sidecar spawn boots into the same state.
    state: dict[str, Optional[Path]] = {"current_adapter": initial_active}

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        # Don't fail boot when the model isn't on disk yet — onboarding
        # downloads it via /api/update-apply and only then calls
        # /api/load-model. The pet still wants /api/health to answer 200
        # in the meantime so the bubble doesn't show a permanent error.
        if initial_model and Path(initial_model).exists():
            try:
                await server.start()
            except Exception as exc:
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
        items = discover_models(extra_roots)
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
        backend = detect_backend()
        adapter = state["current_adapter"]
        return {
            "ok": True,
            "alive": server.alive,
            "backend": "llama.cpp",
            "accel": backend["recommended"],
            "device": backend["recommended"],  # alias used by older Electron code paths
            "dtype": "gguf",
            "model_dir": str(server.model_path) if server.model_path else None,
            "model_name": server.model_path.name if server.model_path else None,
            "adapter": str(adapter) if adapter else None,
            "persona": _persona_for(adapter) if adapter else "default",
            "llama_server": sub_health,
            "port": server.port,
        }

    @app.get("/api/devices")
    def list_devices():
        info = detect_backend()
        # Echo `current` so the renderer can highlight what's loaded.
        info["current"] = os.environ.get("MINICPM_DEVICE") or info["recommended"]
        return info

    @app.post("/api/set-device")
    async def set_device(payload: dict):
        device = str(payload.get("device") or "").strip().lower()
        if device not in ("metal", "cuda", "cpu", "mps", "auto", ""):
            return JSONResponse({"error": f"unknown device: {device!r}"}, status_code=400)
        # "mps" is the legacy name for Apple Silicon; transparently map
        # to metal for consistency with llama.cpp terminology.
        if device == "mps":
            device = "metal"
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
        return {
            "model_present": present,
            "model_dir": str(path) if path else None,
            "device": detect_backend()["recommended"],
            "dtype": "gguf",
            "adapter": str(adapter) if adapter else None,
            "persona": _persona_for(adapter) if adapter else "default",
            "stage_hint": "ready" if present else "model-download",
        }

    # ─── Model / adapter listing ───────────────────────────────────────

    @app.get("/api/models")
    def list_models():
        items = discover_models(extra_roots)
        current = str(server.model_path) if server.model_path else None
        return {
            "items": items,
            "current": current,
            "current_name": server.model_path.name if server.model_path else None,
        }

    @app.post("/api/load-model")
    async def load_model(payload: dict):
        path = str(payload.get("path") or "").strip()
        if not path:
            return JSONResponse({"error": "path is required"}, status_code=400)
        target = Path(path).expanduser().resolve()
        if not target.is_file() or target.suffix.lower() != ".gguf":
            return JSONResponse({"error": f"not a .gguf file: {target}"}, status_code=400)
        bridge.post("working", event="LoadModel", title=f"加载 {target.name}")
        try:
            await server.swap_model(target)
            updater.local_model_path = target
        except Exception as exc:
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
            # If llama-server was booted with `--lora <something>`, just
            # zeroing in-memory `current_adapter` isn't enough — the
            # pinned llama.cpp build (zhangtao2-1@c5ede29) doesn't honour
            # a per-request `lora: []` as "disable preloaded adapters"
            # the way newer upstream does, so the bias from the active
            # LoRA's weights bleeds into base chat. The only reliable
            # fix is to restart llama-server with no `--lora` flag at
            # all. Same ~3-10s cost as switching to a new LoRA, but the
            # only way to truly "unload" on this vendor pin.
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
            {"error": "/api/classify not implemented for llama.cpp backend yet"},
            status_code=501,
        )

    # ─── Updater ───────────────────────────────────────────────────────

    @app.get("/api/update-check")
    async def update_check():
        updater.local_model_path = server.model_path or _get_active_model_path()
        return await asyncio.to_thread(updater.check)

    @app.post("/api/update-apply")
    async def update_apply():
        updater.local_model_path = server.model_path or _get_active_model_path()

        async def stream():
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
                            items = discover_models(extra_roots)
                            if items:
                                target = Path(items[0]["path"])
                                await server.swap_model(target)
                                updater.local_model_path = target
                                yield _sse({"phase": "reloaded", "model": str(target)})
                        except Exception as exc:
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
        - no adapter active     → []   (force base; see note below)

        NOTE on the "no adapter active" case: we used to return None
        here, expecting llama-server to fall back to base. That's
        WRONG with our `--lora-init-without-apply` boot — the pinned
        llama.cpp build (zhangtao2-1@c5ede29) doesn't actually zero
        the global scale despite the flag name, so a missing `lora`
        field leaves nekoqa applied at scale 1.0 and the user gets a
        猫娘-flavoured response even after switching back to Base.
        Sending an empty list explicitly disables every preloaded
        adapter for THIS request, which is the bulletproof behaviour
        we want.
        """
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
            "note": "MiniCPM sidecar gateway (llama.cpp backend)",
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
    server: LlamaServer,
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
    server: LlamaServer,
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
