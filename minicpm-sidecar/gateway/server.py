"""FastAPI gateway in front of the OpenVINO inference engine.

Exposes the same HTTP/SSE contract the Electron app already speaks, so
the renderer (clawd-on-desk/src/minicpm-chat.*) stays simple. The actual
inference happens in `openvino_client.OpenVinoEngine`, in-process, on an
Intel Arc/Xe iGPU or an AI Boost NPU; this file is just glue.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncGenerator, List, Optional

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from .clawd_state import ClawdBridge
from .log_setup import get_logger
from . import openvino_client
from .think_filter import ThinkBlockFilter


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


#: How often the pet gets a "still working" push while a reply streams.
_PET_PING_S = 6.0
#: How often we check whether the bubble is still listening.
_DISCONNECT_POLL_S = 1.0


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


def discover_models(roots: List[Path]) -> List[dict]:
    """Return [{name, path, kind}] for every OpenVINO IR under `roots`.

    A model here is a *directory* holding `openvino_model.xml` and its
    tokenizer pair, not a single file.
    """
    seen: set[Path] = set()
    emitted: set[Path] = set()
    out: List[dict] = []

    def _emit(path: Path) -> None:
        # Dedupe on the *result*, not just the root: nested roots are
        # normal (MINICPM_MODEL_DIR's parent plus <repo>/models, say), and
        # rglob from the outer one re-finds everything in the inner one.
        if path in emitted:
            return
        emitted.add(path)
        out.append({"name": path.name, "path": str(path), "kind": "openvino"})

    for root in roots:
        try:
            r = root.expanduser().resolve()
        except Exception:
            continue
        if not r.exists() or r in seen or not r.is_dir():
            continue
        seen.add(r)

        if openvino_client.is_openvino_ir(r):
            _emit(r)
            continue
        for xml in sorted(r.rglob("openvino_model.xml")):
            d = xml.parent
            if _is_staging(d) or not openvino_client.is_openvino_ir(d):
                continue
            _emit(d)
    return out


def _default_model_roots() -> List[Path]:
    """Locations to scan for IR directories when no explicit
    MINICPM_MODEL_DIR is set. The Electron host passes `--model`
    explicitly so this is only used by direct CLI / dev runs."""
    here = Path(__file__).resolve().parent.parent
    return [
        Path.home() / "Library" / "Application Support" / "Clawd on Desk" / "models",
        Path.home() / ".local" / "share" / "Clawd on Desk" / "models",
        here / "models",
        here.parent / "models",
        here.parent / "models" / "ov",
    ]


# ── App factory ──────────────────────────────────────────────────────────────


def build_app(
    *,
    initial_model: Optional[Path],
    ctx_size: int = 4096,
) -> FastAPI:
    log = get_logger()
    bridge = ClawdBridge(enabled=True, debug=False)

    # In-process pipeline: no child process, no port of its own.
    server = openvino_client.OpenVinoEngine(
        model_path=initial_model,
        ctx_size=ctx_size,
    )

    startup_error: Optional[str] = None

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        nonlocal startup_error
        # Don't fail boot when the model isn't on disk yet — onboarding
        # picks an IR directory and only then does /api/load-model fire.
        if initial_model and Path(initial_model).exists():
            try:
                await server.start()
                startup_error = None
            except Exception as exc:
                startup_error = str(exc)
                log.exception("initial engine start failed: %s", exc)
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

    def _get_active_model_path() -> Optional[Path]:
        if server.model_path:
            return server.model_path
        if initial_model:
            return Path(initial_model)
        items = discover_models(extra_roots)
        return Path(items[0]["path"]) if items else None

    # ─── Health / introspection ────────────────────────────────────────

    @app.get("/api/health")
    async def health():
        sub_health = await server.health()
        devices = openvino_client.detect_devices()
        requested = devices.get("current") or devices["recommended"]
        # The device the engine resolved to, not the one asked for: an IR the
        # NPU cannot take degrades to the GPU at load time.
        actual = server.device if server.alive else requested
        return {
            "ok": True,
            "alive": server.alive,
            "backend": "openvino",
            "accel": actual,
            "device": actual,  # alias used by older Electron code paths
            "requested_device": requested,
            "device_fallback": server.device_fallback,
            "dtype": "openvino-ir",
            "model_dir": str(server.model_path) if server.model_path else None,
            "model_name": server.model_path.name if server.model_path else None,
            "engine": sub_health,
            "port": server.port,
            "startup_error": startup_error,
        }

    @app.get("/api/devices")
    def list_devices():
        return openvino_client.detect_devices()

    @app.post("/api/set-device")
    async def set_device(payload: dict):
        device = str(payload.get("device") or "").strip().lower()

        if device not in ("gpu", "npu", "auto", ""):
            return JSONResponse({"error": f"unknown device: {device!r}"}, status_code=400)
        available = openvino_client.detect_devices().get("available") or []
        if device and device != "auto" and device not in available:
            return JSONResponse(
                {"error": f"device not available on this machine: {device!r}"},
                status_code=400,
            )
        if device == "npu":
            # The engine refuses at load time too, but catching it here turns
            # a dead sidecar into a toast the user can act on.
            target = server.model_path
            if target:
                precision = openvino_client.inspect_ir_precision(Path(target))
                if not precision.npu_ready:
                    # Keep the wording in step with assert_npu_compatible.
                    return JSONResponse(
                        {
                            "error": (
                                f"the loaded model is {precision.describe()}, which the "
                                "NPU cannot run. It accepts symmetric INT4 (recommended) "
                                "or uncompressed FP16 — convert one with "
                                "scripts/convert-openvino.py"
                            )
                        },
                        status_code=400,
                    )
        openvino_client.invalidate_device_cache()

        if device:
            os.environ["MINICPM_DEVICE"] = device
        else:
            os.environ.pop("MINICPM_DEVICE", None)
        return {"ok": True, "device": device or "auto", "note": "restart sidecar to take effect"}

    @app.get("/api/onboarding")
    def onboarding():
        path = _get_active_model_path()
        present = path.exists() if path else False
        devices = openvino_client.detect_devices()
        requested = devices.get("current") or devices["recommended"]
        return {
            "model_present": present,
            "model_dir": str(path) if path else None,
            "device": server.device if server.alive else requested,
            "dtype": "openvino-ir",
            "accelerators": devices.get("available") or [],
            "stage_hint": "ready" if present else "model-pick",
        }

    # ─── Model listing ─────────────────────────────────────────────────

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
        nonlocal startup_error
        path = str(payload.get("path") or "").strip()
        if not path:
            return JSONResponse({"error": "path is required"}, status_code=400)
        target = Path(path).expanduser().resolve()
        reason = openvino_client.validate_openvino_ir(target)
        if reason:
            return JSONResponse({"error": reason}, status_code=400)
        bridge.post("working", event="LoadModel", title=f"加载 {target.name}")
        try:
            await server.swap_model(target)
            startup_error = None
        except Exception as exc:
            startup_error = str(exc)
            bridge.post("error")
            return JSONResponse({"error": str(exc)}, status_code=500)
        bridge.post("idle")
        return {"ok": True, "model_dir": str(target), "model_name": target.name}

    @app.post("/api/classify")
    def classify_endpoint(payload: dict):
        return JSONResponse({"error": "/api/classify not implemented"}, status_code=501)

    # ─── Chat ──────────────────────────────────────────────────────────

    @app.post("/api/warmup")
    async def warmup():
        if not server.alive:
            return JSONResponse({"ok": False, "error": "engine not running"}, status_code=503)
        t0 = time.time()
        try:
            await server.complete_once(prompt=" ", max_tokens=1)
            return {"ok": True, "elapsed_ms": int((time.time() - t0) * 1000)}
        except Exception as exc:
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=500)

    @app.post("/api/chat")
    async def chat(req: ChatRequest, request: Request):
        if not req.messages:
            return JSONResponse({"error": "messages is empty"}, status_code=400)
        if not server.alive:
            return JSONResponse(
                {"error": "engine not running — pick an OpenVINO model to get started"},
                status_code=503,
            )
        if req.stream:
            return StreamingResponse(
                _stream_chat(server, bridge, req, request),
                media_type="text/event-stream",
            )
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
            "note": "MiniCPM sidecar gateway (OpenVINO)",
            "endpoints": [
                "/api/health", "/api/chat", "/api/warmup",
                "/api/models", "/api/load-model",
                "/api/devices", "/api/set-device", "/api/onboarding",
                "/api/classify", "/api/state",
            ],
        })

    return app


# ── Chat plumbing ───────────────────────────────────────────────────────────


async def _stream_chat(
    server: "openvino_client.OpenVinoEngine",
    bridge: ClawdBridge,
    req: ChatRequest,
    request: Optional[Request] = None,
) -> AsyncGenerator[bytes, None]:
    # Whatever happens below, exactly one terminal state has to reach the pet
    # or its animation sticks.
    terminal = "attention"
    if not req.silent:
        bridge.new_session()
        bridge.post("thinking")

    try:
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
            terminal = "error"
            yield _sse({"event": "error", "message": str(exc)})
            return

        yield _sse({"event": "start"})
        if not req.silent:
            bridge.post("working")

        think_filter = ThinkBlockFilter(expose=req.thinking, start_inside=False)
        last_pet_ping = time.time()
        last_liveness_check = time.time()
        hung_up = False

        try:
            async for kind, piece in agen:
                if kind == "reasoning":
                    if req.thinking:
                        yield _sse({"event": "think", "content": piece})
                else:  # "content"
                    for ev in think_filter.feed(piece):
                        yield _sse(ev)

                now = time.time()
                # Poll for the client going away ourselves: starlette's
                # http.disconnect never arrived in testing, and `send()`
                # swallows writes to a dead socket.
                if request is not None and now - last_liveness_check > _DISCONNECT_POLL_S:
                    last_liveness_check = now
                    if await request.is_disconnected():
                        get_logger().info(
                            "chat client disconnected; stopping generation"
                        )
                        hung_up = True
                        break
                if now - last_pet_ping > _PET_PING_S:
                    if not req.silent:
                        bridge.post("working")
                    last_pet_ping = now
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            get_logger().exception("chat stream error: %s", exc)
            terminal = "error"
            yield _sse({"event": "error", "message": str(exc)})
            return
        finally:
            # `async for` does not close the generator; without this the
            # engine sits suspended with its worker thread still decoding.
            await agen.aclose()

        for ev in think_filter.flush():
            yield _sse(ev)
        if not hung_up:
            yield _sse({"event": "end"})
    finally:
        if not req.silent:
            bridge.post(terminal)


async def _blocking_chat(
    server: "openvino_client.OpenVinoEngine",
    bridge: ClawdBridge,
    req: ChatRequest,
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
