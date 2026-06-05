"""OpenVINO 推理 HTTP 服务，替代 llama-server + sidecar gateway。

监听 127.0.0.1:18765，提供与桌宠前端完全兼容的 API：
- GET  /api/health          健康检查（桌宠前端 + 设置面板轮询）
- POST /api/chat            桌宠对话接口（SSE 流式，前端主要调用入口）
- POST /v1/chat/completions OpenAI 兼容接口（备用）
- POST /api/shutdown        优雅关闭
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import threading
import time
import traceback
from pathlib import Path
from typing import Optional

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

# ── 编码配置 ──────────────────────────────────────────────────────────────────

def _configure_stream_encoding(stream) -> None:
    reconfigure = getattr(stream, "reconfigure", None)
    if callable(reconfigure):
        reconfigure(encoding="utf-8")

_configure_stream_encoding(sys.stdout)
_configure_stream_encoding(sys.stderr)

# ── 常量 ──────────────────────────────────────────────────────────────────────

SKILL_NAME = "local-minicpm-pet-openvino"
SERVER_HOST = "127.0.0.1"
SERVER_PORT = 18765
MODEL_NAME = "MiniCPM5-1B-OpenVINO"

OPENVINO_ROOT = Path(os.environ.get("USERPROFILE", "~")) / ".openvino"
MODELS_DIR = OPENVINO_ROOT / "models"
LOG_DIR = OPENVINO_ROOT / "log"

# ── 日志 ──────────────────────────────────────────────────────────────────────

LOG_DIR.mkdir(parents=True, exist_ok=True)
_log_file = LOG_DIR / f"{SKILL_NAME}-server-{time.strftime('%Y%m%d-%H%M%S')}.log"


def log(msg: str):
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] [server pid={os.getpid()}] {msg}"
    print(line, flush=True)
    with open(_log_file, "a", encoding="utf-8") as f:
        f.write(line + "\n")


# ── 状态 ──────────────────────────────────────────────────────────────────────

class ServerState:
    def __init__(self):
        self.status = "starting"  # starting/downloading/loading/ok/error
        self.error: Optional[str] = None
        self.progress: str = ""
        self.pipe = None
        self.tokenizer = None
        self.model_dir: Optional[str] = None
        self.device: str = "CPU"
        self.start_time = time.time()

    @property
    def uptime_s(self) -> int:
        return int(time.time() - self.start_time)


_state = ServerState()

# ── 设备选择 ──────────────────────────────────────────────────────────────────

def _pick_device() -> str:
    try:
        import openvino as ov
        devices = ov.Core().available_devices
        for d in devices:
            if "GPU" in d:
                log(f"Detected GPU device: {d}")
                return d
        log("No GPU found, using CPU")
        return "CPU"
    except Exception as e:
        log(f"Device detection failed: {e}, fallback to CPU")
        return "CPU"


# ── 模型管理 ──────────────────────────────────────────────────────────────────

def _get_info() -> dict:
    info_candidates = [
        Path(__file__).resolve().parent.parent / "info.json",
        OPENVINO_ROOT / "temp" / SKILL_NAME / "info.json",
    ]
    for p in info_candidates:
        if p.exists():
            with open(p, "r", encoding="utf-8") as f:
                return json.load(f)
    return {"models": []}


def _check_model_ready(model_dir: Path, required_files: list) -> bool:
    if not model_dir.exists():
        return False
    for rf in required_files:
        if not (model_dir / rf).exists():
            return False
    return True


def _download_model(model_info: dict) -> Path:
    _state.status = "downloading"
    model_id = model_info["model_id"]
    dir_name = model_info["dir_name"]
    target_dir = MODELS_DIR / dir_name
    partial_dir = MODELS_DIR / f"{dir_name}.partial"

    if _check_model_ready(target_dir, model_info.get("required_files", [])):
        log(f"Model already present: {target_dir}")
        return target_dir

    log(f"Downloading model: {model_id} -> {partial_dir}")
    MODELS_DIR.mkdir(parents=True, exist_ok=True)

    from modelscope import snapshot_download
    snapshot_download(model_id, local_dir=str(partial_dir))

    required = model_info.get("required_files", [])
    if not _check_model_ready(partial_dir, required):
        raise RuntimeError(f"Model download incomplete, missing files in {partial_dir}")

    if target_dir.exists():
        import shutil
        shutil.rmtree(target_dir)
    partial_dir.rename(target_dir)
    log(f"Model ready: {target_dir}")
    return target_dir


def _load_model(model_dir: Path):
    _state.status = "loading"
    log(f"Loading model from {model_dir}")

    import openvino_genai

    device = _pick_device()
    _state.pipe = openvino_genai.LLMPipeline(str(model_dir), device)
    _state.tokenizer = _state.pipe.get_tokenizer()
    _state.model_dir = str(model_dir)
    _state.device = device
    log(f"Model loaded on {device}")


def _ensure_models():
    try:
        info = _get_info()
        models = info.get("models", [])
        if not models:
            raise RuntimeError("No models configured in info.json")

        model_info = models[0]
        model_dir = _download_model(model_info)
        _load_model(model_dir)
        _state.status = "ok"
        log("Server ready")
    except Exception as e:
        _state.status = "error"
        _state.error = str(e)
        log(f"Model init failed: {e}\n{traceback.format_exc()}")


# ── 推理 ──────────────────────────────────────────────────────────────────────

def _do_inference(messages: list, thinking: bool = False, max_tokens: int = 512) -> dict:
    import openvino_genai

    if not _state.pipe or not _state.tokenizer:
        raise RuntimeError("模型未加载")

    tokenized_prompt = _state.tokenizer.apply_chat_template(
        messages,
        add_generation_prompt=True,
        extra_context={"enable_thinking": thinking},
    )

    config = openvino_genai.GenerationConfig()
    config.max_new_tokens = max_tokens
    config.do_sample = True
    config.temperature = 0.9 if thinking else 0.7
    config.top_p = 0.95

    result = _state.pipe.generate(tokenized_prompt, config)
    text = result.texts[0] if hasattr(result, "texts") else str(result)

    thinking_content = None
    answer_content = text

    if thinking and "<think>" in text:
        think_start = text.find("<think>")
        think_end = text.find("</think>")
        if think_start != -1 and think_end != -1:
            thinking_content = text[think_start + len("<think>"):think_end].strip()
            answer_content = text[think_end + len("</think>"):].strip()

    return {
        "content": answer_content,
        "thinking": thinking_content,
    }


# ── FastAPI 应用 ──────────────────────────────────────────────────────────────

app = FastAPI(title="MiniCPM OpenVINO Server")


@app.get("/api/health")
def health():
    """桌宠前端和设置面板轮询此端点判断服务状态。"""
    resp = {
        "ok": _state.status == "ok",
        "status": _state.status,
        "alive": _state.status == "ok",
        "pid": os.getpid(),
        "uptime_s": _state.uptime_s,
        "model_name": MODEL_NAME,
        "model_dir": _state.model_dir,
        "device": _state.device,
        "persona": "default",
        "adapter": None,
        "llama_server": {"status": "ok" if _state.status == "ok" else _state.status},
    }
    if _state.error:
        resp["error"] = _state.error
    if _state.progress:
        resp["progress"] = _state.progress
    return resp


# ── /api/chat — 桌宠前端主要调用入口（SSE 流式）─────────────────────────────

class ChatRequest(BaseModel):
    messages: list[dict]
    stream: bool = True
    max_new_tokens: int = 768
    temperature: float = 0.6
    top_p: float = 0.95
    top_k: int = 0
    repetition_penalty: float = 1.05
    thinking: bool = False
    silent: bool = False
    disable_adapter: bool = False


@app.post("/api/chat")
async def api_chat(req: ChatRequest):
    """桌宠前端对话接口，返回 SSE 流式响应。"""
    if _state.status != "ok":
        error_event = json.dumps({"event": "error", "message": f"Model not ready (status={_state.status})"})
        return StreamingResponse(
            iter([f"data: {error_event}\n\n"]),
            media_type="text/event-stream",
        )

    messages = req.messages
    thinking = req.thinking
    max_tokens = req.max_new_tokens
    if thinking and max_tokens < 1280:
        max_tokens = 1280

    try:
        result = _do_inference(messages, thinking=thinking, max_tokens=max_tokens)
    except Exception as e:
        log(f"Inference error: {e}")
        error_event = json.dumps({"event": "error", "message": str(e)})
        return StreamingResponse(
            iter([f"data: {error_event}\n\n"]),
            media_type="text/event-stream",
        )

    def generate_sse():
        # Emit thinking content if present
        if thinking and result["thinking"]:
            chunks = _split_into_chunks(result["thinking"], 20)
            for chunk in chunks:
                yield f"data: {json.dumps({'event': 'think', 'content': chunk})}\n\n"

        # Emit answer content
        answer = result["content"] or ""
        chunks = _split_into_chunks(answer, 20)
        for chunk in chunks:
            yield f"data: {json.dumps({'event': 'delta', 'content': chunk})}\n\n"

    return StreamingResponse(generate_sse(), media_type="text/event-stream")


def _split_into_chunks(text: str, chunk_size: int) -> list[str]:
    """Split text into character-level chunks to simulate streaming."""
    if not text:
        return []
    chunks = []
    for i in range(0, len(text), chunk_size):
        chunks.append(text[i:i + chunk_size])
    return chunks


# ── /v1/chat/completions — OpenAI 兼容接口（备用）────────────────────────────

class ChatMessage(BaseModel):
    role: str
    content: str


class ChatCompletionRequest(BaseModel):
    model: str = "minicpm5-1b-openvino"
    messages: list[ChatMessage]
    max_tokens: int = 512
    temperature: float = 0.7
    stream: bool = False


@app.post("/v1/chat/completions")
def chat_completions(req: ChatCompletionRequest):
    if _state.status != "ok":
        raise HTTPException(
            status_code=503,
            detail=f"Model not ready (status={_state.status})"
        )

    if req.stream:
        raise HTTPException(status_code=501, detail="Use /api/chat for streaming")

    messages = [{"role": m.role, "content": m.content} for m in req.messages]
    thinking = req.temperature > 0.8

    try:
        result = _do_inference(messages, thinking=thinking, max_tokens=req.max_tokens)
    except Exception as e:
        log(f"Inference error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

    return {
        "id": f"chatcmpl-{int(time.time())}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": req.model,
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": result["content"],
            },
            "finish_reason": "stop",
        }],
    }


# ── /api/adapters — 桌宠前端查询适配器列表（返回空）─────────────────────────

@app.get("/api/adapters")
def list_adapters():
    """OpenVINO 后端不支持 LoRA 适配器，返回空列表。"""
    return {"items": [], "current": None}


# ── /api/update-check — 桌宠前端检查更新（返回无更新）─────────────────────────

@app.get("/api/update-check")
def update_check():
    return {"available": False, "local_revision": "openvino-1.0", "remote_revision": "openvino-1.0"}


@app.post("/api/shutdown")
def shutdown():
    log("Shutdown requested via API")
    threading.Timer(1.0, lambda: os._exit(0)).start()
    return {"ok": True, "message": "Shutting down in 1s"}


# ── 入口 ─────────────────────────────────────────────────────────────────────

def main():
    log(f"Starting HTTP server on {SERVER_HOST}:{SERVER_PORT}")

    init_thread = threading.Thread(target=_ensure_models, daemon=True)
    init_thread.start()

    uvicorn.run(app, host=SERVER_HOST, port=SERVER_PORT, log_level="warning")


if __name__ == "__main__":
    main()
