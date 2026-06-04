"""local-chat server: 长生命周期进程，保持 OpenVINO 模型热加载。

职责：
- 监听 Named Pipe (\\.\pipe\local-chat)
- 后台线程下载/加载模型
- 保持模型常驻内存，处理后续推理请求
- 响应 status / request / shutdown 操作
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
import traceback
from multiprocessing.connection import Client, Listener
from pathlib import Path
from typing import Optional

# ── 编码配置 ──────────────────────────────────────────────────────────────────

def _configure_stream_encoding(stream) -> None:
    reconfigure = getattr(stream, "reconfigure", None)
    if callable(reconfigure):
        reconfigure(encoding="utf-8")

_configure_stream_encoding(sys.stdout)
_configure_stream_encoding(sys.stderr)

# ── 常量 ──────────────────────────────────────────────────────────────────────

SKILL_NAME = "local-minicpm-pet-openvino"
PIPE_ADDRESS = r"\\.\pipe\local-minicpm-pet-openvino"
AUTHKEY = b"local-minicpm-pet-openvino"

OPENVINO_ROOT = Path(os.environ.get("USERPROFILE", "~")) / ".openvino"
MODELS_DIR = OPENVINO_ROOT / "models"
LOG_DIR = OPENVINO_ROOT / "log"

# ── 日志 ──────────────────────────────────────────────────────────────────────

LOG_DIR.mkdir(parents=True, exist_ok=True)
_log_file = LOG_DIR / f"{SKILL_NAME}-server-py-{time.strftime('%Y%m%d-%H%M%S')}.log"


def log(msg: str):
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] [server pid={os.getpid()}] {msg}"
    print(line, flush=True)
    with open(_log_file, "a", encoding="utf-8") as f:
        f.write(line + "\n")


# ── 状态 ──────────────────────────────────────────────────────────────────────

class ServerState:
    def __init__(self):
        self.state = "starting"  # starting/downloading/loading/running/error
        self.error: Optional[str] = None
        self.progress: str = ""
        self.pipe = None
        self.tokenizer = None
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
    # 从 temp 目录读 info.json 或从原始位置
    info_candidates = [
        OPENVINO_ROOT / "temp" / SKILL_NAME / "info.json",
        Path(__file__).resolve().parent.parent / "info.json",
    ]
    for p in info_candidates:
        if p.exists():
            with open(p, "r", encoding="utf-8") as f:
                return json.load(f)
    return {"models": []}


def _check_model_ready(model_dir: Path, required_files: list) -> bool:
    """检查模型文件是否完整。"""
    if not model_dir.exists():
        return False
    for rf in required_files:
        if not (model_dir / rf).exists():
            return False
    return True


def _download_model(model_info: dict) -> Path:
    """从 ModelScope 下载模型。"""
    _state.state = "downloading"
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
    snapshot_download(
        model_id,
        local_dir=str(partial_dir),
    )

    # 验证完整性
    required = model_info.get("required_files", [])
    if not _check_model_ready(partial_dir, required):
        raise RuntimeError(f"Model download incomplete, missing files in {partial_dir}")

    # 原子重命名
    if target_dir.exists():
        import shutil
        shutil.rmtree(target_dir)
    partial_dir.rename(target_dir)
    log(f"Model ready: {target_dir}")
    return target_dir


def _load_model(model_dir: Path):
    """加载 OpenVINO 模型到内存。"""
    _state.state = "loading"
    log(f"Loading model from {model_dir}")

    import openvino_genai

    device = _pick_device()
    _state.pipe = openvino_genai.LLMPipeline(str(model_dir), device)
    _state.tokenizer = _state.pipe.get_tokenizer()
    log(f"Model loaded on {device}")


def _ensure_models():
    """后台线程：下载并加载模型。"""
    try:
        info = _get_info()
        models = info.get("models", [])
        if not models:
            raise RuntimeError("No models configured in info.json")

        model_info = models[0]
        model_dir = _download_model(model_info)
        _load_model(model_dir)
        _state.state = "running"
        log("Server ready")
    except Exception as e:
        _state.state = "error"
        _state.error = str(e)
        log(f"Model init failed: {e}\n{traceback.format_exc()}")


# ── 推理 ──────────────────────────────────────────────────────────────────────

def _do_inference(prompt: str, thinking: bool = False) -> dict:
    """执行推理并返回结果。"""
    import openvino_genai

    if not _state.pipe or not _state.tokenizer:
        return {"ok": False, "error": "模型未加载"}

    messages = [{"role": "user", "content": prompt}]
    tokenized_prompt = _state.tokenizer.apply_chat_template(
        messages,
        add_generation_prompt=True,
        extra_context={"enable_thinking": thinking},
    )

    config = openvino_genai.GenerationConfig()
    config.max_new_tokens = 1024 if thinking else 512
    config.do_sample = True
    config.temperature = 0.9 if thinking else 0.7
    config.top_p = 0.95

    result = _state.pipe.generate(tokenized_prompt, config)
    text = result.texts[0] if hasattr(result, "texts") else str(result)

    # 分离 think 块
    thinking_content = None
    answer_content = text

    if thinking and "<think>" in text:
        think_start = text.find("<think>")
        think_end = text.find("</think>")
        if think_start != -1 and think_end != -1:
            thinking_content = text[think_start + len("<think>"):think_end].strip()
            answer_content = text[think_end + len("</think>"):].strip()

    return {
        "ok": True,
        "content": answer_content,
        "thinking": thinking_content,
    }


# ── Pipe 请求处理 ─────────────────────────────────────────────────────────────

def _handle_request(msg: dict) -> dict:
    op = msg.get("op", "")

    if op == "status":
        resp = {
            "ok": True,
            "state": _state.state,
            "pid": os.getpid(),
            "uptime_s": _state.uptime_s,
        }
        if _state.error:
            resp["error"] = _state.error
        if _state.progress:
            resp["progress"] = _state.progress
        return resp

    if op == "request":
        if _state.state != "running":
            return {"ok": False, "error": f"Server not ready (state={_state.state})"}
        prompt = msg.get("prompt", "")
        thinking = msg.get("thinking", False)
        if not prompt:
            return {"ok": False, "error": "Empty prompt"}
        try:
            return _do_inference(prompt, thinking=thinking)
        except Exception as e:
            log(f"Inference error: {e}")
            return {"ok": False, "error": str(e)}

    if op == "shutdown":
        timeout = msg.get("timeout", 10.0)
        log(f"Shutdown requested (timeout={timeout}s)")
        threading.Timer(0.5, lambda: os._exit(0)).start()
        return {"ok": True, "state": "shutting_down"}

    return {"ok": False, "error": f"Unknown op: {op}"}


# ── 主循环 ────────────────────────────────────────────────────────────────────

def main():
    log(f"Server starting, pipe={PIPE_ADDRESS}")

    # 后台加载模型
    init_thread = threading.Thread(target=_ensure_models, daemon=True)
    init_thread.start()

    # 监听 Named Pipe
    listener = Listener(PIPE_ADDRESS, authkey=AUTHKEY)
    log("Listening on pipe")

    try:
        while True:
            try:
                conn = listener.accept()
                msg = conn.recv()
                resp = _handle_request(msg)
                conn.send(resp)
                conn.close()
            except EOFError:
                continue
            except Exception as e:
                log(f"Connection error: {e}")
                continue
    except KeyboardInterrupt:
        pass
    finally:
        listener.close()
        log("Server stopped")


if __name__ == "__main__":
    main()
