"""local-chat client: 短生命周期 CLI，通过 Named Pipe 与 server.py 通信。

职责：
- 同步运行时脚本到 temp 目录
- 通过 server-dog 确保 server 运行
- 发送对话请求并格式化输出
- 处理模型下载超时（exit code 3 + pending-request）
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import time
from multiprocessing.connection import Client
from pathlib import Path

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
DOG_PIPE_ADDRESS = r"\\.\pipe\skill-server-dog"
AUTHKEY = b"local-minicpm-pet-openvino"

OPENVINO_ROOT = Path(os.environ.get("USERPROFILE", "~")) / ".openvino"
TEMP_DIR = OPENVINO_ROOT / "temp" / SKILL_NAME
LOG_DIR = OPENVINO_ROOT / "log"
PENDING_REQUEST_PATH = OPENVINO_ROOT / f"{SKILL_NAME}-pending-request.json"

DOWNLOAD_WAIT_TIMEOUT = 480  # 8 minutes
ERROR_RETRY_MAX = 3
CONNECT_TIMEOUT = 60


def _detect_claw_name() -> str:
    """检测宿主进程名称。"""
    for name in ("Marvis", "WorkBuddy", "MiniCPM"):
        if os.environ.get(f"{name.upper()}_PID"):
            return name
    return "standalone"


def _get_info() -> dict:
    info_path = Path(__file__).resolve().parent.parent / "info.json"
    with open(info_path, "r", encoding="utf-8") as f:
        return json.load(f)


def _get_venv_python() -> str:
    info = _get_info()
    venv_name = info["venv_name"]
    return str(OPENVINO_ROOT / "venv" / venv_name / "Scripts" / "python.exe")


# ── 运行时脚本同步 ────────────────────────────────────────────────────────────

def _file_hash(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def _sync_runtime_scripts() -> bool:
    """同步 scripts/ 到 temp 目录，返回是否有变更。"""
    scripts_dir = Path(__file__).resolve().parent
    TEMP_DIR.mkdir(parents=True, exist_ok=True)
    changed = False

    for src_file in scripts_dir.glob("*.py"):
        dst_file = TEMP_DIR / src_file.name
        if dst_file.exists() and _file_hash(src_file) == _file_hash(dst_file):
            continue
        shutil.copy2(src_file, dst_file)
        changed = True

    return changed


# ── server-dog 交互 ───────────────────────────────────────────────────────────

def _request_server_start() -> bool:
    """通过 server-dog 请求启动 server。"""
    info = _get_info()
    payload = {
        "op": "start_server",
        "skill_name": SKILL_NAME,
        "server_path": str(TEMP_DIR / "server.py"),
        "venv_python": _get_venv_python(),
        "pipe_address": PIPE_ADDRESS,
        "authkey": AUTHKEY.decode("latin-1"),
        "mem_need_gb": info["mem_need_gb"],
        "server_alive_timeout": info.get("server_alive_timeout", 300),
        "claw_name": _detect_claw_name(),
    }
    try:
        conn = Client(DOG_PIPE_ADDRESS, authkey=b"skill-server-dog")
        conn.send(payload)
        resp = conn.recv()
        conn.close()
        return resp.get("ok", False)
    except Exception:
        return False


def _send_keepalive():
    """向 server-dog 发送 keepalive。"""
    try:
        conn = Client(DOG_PIPE_ADDRESS, authkey=b"skill-server-dog")
        conn.send({"op": "keepalive", "skill_name": SKILL_NAME})
        conn.recv()
        conn.close()
    except Exception:
        pass


# ── Server 通信 ───────────────────────────────────────────────────────────────

def _connect_server(timeout: float = CONNECT_TIMEOUT):
    """连接 server pipe，带重试。"""
    deadline = time.time() + timeout
    last_err = None
    while time.time() < deadline:
        try:
            conn = Client(PIPE_ADDRESS, authkey=AUTHKEY)
            return conn
        except Exception as e:
            last_err = e
            time.sleep(1)
    raise ConnectionError(f"无法连接 server (超时 {timeout}s): {last_err}")


def _get_status() -> dict:
    conn = _connect_server(timeout=10)
    conn.send({"op": "status"})
    resp = conn.recv()
    conn.close()
    return resp


def _wait_ready() -> str:
    """等待 server 就绪，返回最终状态。"""
    start = time.time()
    while time.time() - start < DOWNLOAD_WAIT_TIMEOUT:
        try:
            status = _get_status()
            state = status.get("state", "unknown")
            if state == "running":
                return "running"
            if state == "error":
                print(f"错误: server 初始化失败: {status.get('error', '未知错误')}", file=sys.stderr)
                return "error"
            if state == "downloading":
                progress = status.get("progress", "")
                print(f"\r模型下载中... {progress}", end="", flush=True)
            elif state == "loading":
                print("\r模型加载中...", end="", flush=True)
        except Exception:
            time.sleep(2)
            continue
        time.sleep(3)

    print("\n提示: 模型仍在下载中。", file=sys.stderr)
    return "timeout"


def _send_request(prompt: str, thinking: bool = False) -> dict:
    conn = _connect_server()
    conn.send({
        "op": "request",
        "prompt": prompt,
        "thinking": thinking,
    })
    resp = conn.recv()
    conn.close()
    return resp


# ── 主逻辑 ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(prog=f"{SKILL_NAME}-client")
    parser.add_argument("--prompt", type=str, default="")
    parser.add_argument("--thinking", action="store_true")
    parser.add_argument("--no-thinking", action="store_true")
    parser.add_argument("--continue", dest="cont", action="store_true")
    args = parser.parse_args()

    # 处理 --continue
    if args.cont:
        if not PENDING_REQUEST_PATH.exists():
            print("没有待续传的请求。", file=sys.stderr)
            sys.exit(1)
        with open(PENDING_REQUEST_PATH, "r", encoding="utf-8") as f:
            pending = json.load(f)
        args.prompt = pending.get("prompt", "")
        args.thinking = pending.get("thinking", False)
        PENDING_REQUEST_PATH.unlink(missing_ok=True)

    if not args.prompt:
        print("错误: 请提供对话内容。", file=sys.stderr)
        sys.exit(1)

    thinking = args.thinking and not args.no_thinking

    # 同步脚本
    scripts_changed = _sync_runtime_scripts()

    # 尝试连接或通过 server-dog 启动 server
    try:
        status = _get_status()
        if scripts_changed and status.get("state") == "running":
            # 脚本有变更，需要重启 server
            conn = _connect_server(timeout=10)
            conn.send({"op": "shutdown", "timeout": 10.0})
            conn.recv()
            conn.close()
            time.sleep(2)
            _request_server_start()
    except ConnectionError:
        _request_server_start()

    _send_keepalive()

    # 等待 server 就绪
    state = _wait_ready()
    if state == "error":
        sys.exit(1)
    if state == "timeout":
        # 保存 pending request
        PENDING_REQUEST_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(PENDING_REQUEST_PATH, "w", encoding="utf-8") as f:
            json.dump({"prompt": args.prompt, "thinking": thinking}, f, ensure_ascii=False)
        print(f"\n模型正在下载, 请用命令 'scripts\\run.ps1 --continue' 继续运行", file=sys.stderr)
        sys.exit(3)

    # 发送请求
    for attempt in range(ERROR_RETRY_MAX):
        try:
            resp = _send_request(args.prompt, thinking=thinking)
            break
        except Exception as e:
            if attempt < ERROR_RETRY_MAX - 1:
                # 重试：shutdown 后重启
                try:
                    conn = _connect_server(timeout=5)
                    conn.send({"op": "shutdown", "timeout": 5.0})
                    conn.recv()
                    conn.close()
                except Exception:
                    pass
                time.sleep(2)
                _request_server_start()
                _wait_ready()
            else:
                print(f"错误: 通信失败: {e}", file=sys.stderr)
                sys.exit(2)

    if not resp.get("ok"):
        print(f"错误: {resp.get('error', '未知错误')}", file=sys.stderr)
        sys.exit(1)

    # 输出结果
    if thinking and resp.get("thinking"):
        print("[思考过程]")
        print(resp["thinking"])
        print()

    print("[回答]")
    print(resp.get("content", ""))


if __name__ == "__main__":
    main()
