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
    # v1: kept for compat — currently a no-op since llama.cpp lacks PEFT.
    # The renderer still sends it for narrator calls; harmless.
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
    server = LlamaServer(
        model_path=initial_model,
        ctx_size=ctx_size,
        n_gpu_layers=n_gpu_layers,
        threads=threads,
    )

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
        return {
            "ok": True,
            "alive": server.alive,
            "backend": "llama.cpp",
            "accel": backend["recommended"],
            "device": backend["recommended"],  # alias used by older Electron code paths
            "dtype": "gguf",
            "model_dir": str(server.model_path) if server.model_path else None,
            "model_name": server.model_path.name if server.model_path else None,
            "adapter": None,
            "persona": "default",
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
        return {
            "model_present": present,
            "model_dir": str(path) if path else None,
            "device": detect_backend()["recommended"],
            "dtype": "gguf",
            "adapter": None,
            "persona": "default",
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

    # Adapter endpoints are stubs in v1 — kept so the Electron Settings
    # tab can render "no adapters yet" without 404 errors.

    @app.get("/api/adapters")
    def list_adapters():
        return {"items": [], "current": None, "current_name": None}

    @app.post("/api/load-adapter")
    def load_adapter(payload: dict):
        return JSONResponse(
            {"error": "LoRA adapters not supported in this build; landing in v2."},
            status_code=501,
        )

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

    @app.post("/api/chat")
    async def chat(req: ChatRequest):
        if not req.messages:
            return JSONResponse({"error": "messages is empty"}, status_code=400)
        if not server.alive:
            return JSONResponse(
                {"error": "llama-server not running — open Onboarding to download the model"},
                status_code=503,
            )
        if req.stream:
            return StreamingResponse(_stream_chat(server, bridge, req), media_type="text/event-stream")
        return JSONResponse(await _blocking_chat(server, bridge, req))

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


async def _blocking_chat(server: LlamaServer, bridge: ClawdBridge, req: ChatRequest) -> dict:
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
