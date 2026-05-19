"""Terminal chat client for MiniCPM + clawd-on-desk.

Two modes:
  1) Direct (default):   loads the model in-process. Just one terminal.
  2) Server (--server):  connects to a running server.py over HTTP/SSE.

Either mode pushes pet states (thinking → working → attention) so the
desktop pet animates while you chat.

Usage:
    # Direct, all-in-one (one terminal):
    python chat.py
    python chat.py --thinking         # show the model's <think> reasoning

    # Talk to an already-running server.py:
    python chat.py --server http://127.0.0.1:8765
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from pathlib import Path
from typing import Iterable, List, Optional

import httpx

from clawd_state import ClawdBridge

DEFAULT_MODEL_DIR = Path(__file__).resolve().parent.parent / "models" / "minicpm5-0.9b"

DEFAULT_SYSTEM_PROMPT = (
    "你是 MiniCPM，一只在用户桌面上陪伴他们的可爱桌宠 AI 助手。"
    "请用简洁、自然、温暖的中文回答用户问题；当用户用英文问你时也用英文。"
    "回答尽量直奔主题，不要过度寒暄。"
)

# ANSI for a slightly nicer terminal feel.
RESET = "\033[0m"
DIM = "\033[2m"
BOLD = "\033[1m"
PURPLE = "\033[38;5;141m"
CYAN = "\033[38;5;75m"
GREY = "\033[38;5;245m"


def banner(extra: str = "") -> None:
    print(f"{PURPLE}╭─ MiniCPM 桌宠终端聊天 ─{RESET}")
    if extra:
        print(f"{PURPLE}│{RESET} {GREY}{extra}{RESET}")
    print(f"{PURPLE}│{RESET} {GREY}/help 查看命令 · /quit 退出{RESET}")
    print(f"{PURPLE}╰{RESET}")


HELP = f"""{BOLD}命令：{RESET}
  /help                 显示帮助
  /reset                清空多轮历史
  /think on|off         切换"显示思考"
  /system <prompt>      重新设置 system prompt（不带参数则查看）
  /save <file>          保存当前对话为 JSON
  /quit, /exit, Ctrl+D  退出
"""


# ───────── shared session state ────────────────────────────────────────────


class Session:
    def __init__(self, system: str) -> None:
        self.system = system
        self.history: List[dict] = []
        self.thinking = False

    def messages_for_request(self) -> List[dict]:
        return list(self.history)


# ───────── direct mode (load model in-process) ─────────────────────────────


class DirectEngine:
    def __init__(self, model_dir: Path, dtype: str, device: Optional[str]) -> None:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer

        self._torch = torch
        self.model_dir = model_dir
        self.device = device or self._pick_device(torch)
        self.torch_dtype = self._pick_dtype(torch, dtype, self.device)

        print(f"{GREY}[engine] loading {model_dir.name} on {self.device} ({self._dtype_name()})...{RESET}", flush=True)
        t0 = time.time()
        self.tokenizer = AutoTokenizer.from_pretrained(str(model_dir), trust_remote_code=True)
        self.model = AutoModelForCausalLM.from_pretrained(
            str(model_dir),
            torch_dtype=self.torch_dtype,
            trust_remote_code=True,
            low_cpu_mem_usage=True,
        ).to(self.device)
        self.model.eval()
        eos = self.model.generation_config.eos_token_id
        self.eos_token_ids = list(eos) if isinstance(eos, list) else [int(eos)]
        print(f"{GREY}[engine] ready in {time.time() - t0:.1f}s{RESET}", flush=True)

    @staticmethod
    def _pick_device(torch) -> str:
        if torch.backends.mps.is_available():
            return "mps"
        if torch.cuda.is_available():
            return "cuda"
        return "cpu"

    @staticmethod
    def _pick_dtype(torch, dtype: str, device: str):
        if dtype == "float32":
            return torch.float32
        if dtype == "float16":
            return torch.float16
        if dtype == "bfloat16":
            return torch.bfloat16
        if device == "mps":
            return torch.bfloat16
        if device == "cuda":
            return torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
        return torch.float32

    def _dtype_name(self) -> str:
        return str(self.torch_dtype).replace("torch.", "")

    def stream(self, session: Session, user_msg: str) -> Iterable[dict]:
        from transformers import TextIteratorStreamer

        torch = self._torch
        chat = [{"role": "system", "content": session.system}] + session.history + [
            {"role": "user", "content": user_msg}
        ]
        text = self.tokenizer.apply_chat_template(
            chat, tokenize=False, add_generation_prompt=True, enable_thinking=session.thinking
        )
        inputs = self.tokenizer([text], return_tensors="pt").to(self.device)

        streamer = TextIteratorStreamer(self.tokenizer, skip_prompt=True, skip_special_tokens=True)
        gen_kwargs = dict(
            input_ids=inputs.input_ids,
            attention_mask=inputs.attention_mask,
            max_new_tokens=768,
            do_sample=True,
            temperature=0.6,
            top_p=0.95,
            repetition_penalty=1.05,
            eos_token_id=self.eos_token_ids,
            pad_token_id=self.tokenizer.pad_token_id or self.eos_token_ids[0],
            streamer=streamer,
        )

        def run():
            try:
                with torch.inference_mode():
                    self.model.generate(**gen_kwargs)
            except Exception as exc:
                streamer.text_queue.put(streamer.stop_signal)
                print(f"\n{GREY}[engine] generate error: {exc}{RESET}", file=sys.stderr)

        threading.Thread(target=run, daemon=True).start()

        from server import ThinkBlockFilter  # reuse the same filter
        f = ThinkBlockFilter(expose=session.thinking, start_inside=session.thinking)
        for piece in streamer:
            for ev in f.feed(piece):
                yield ev
        for ev in f.flush():
            yield ev


# ───────── server mode (talk to running FastAPI) ───────────────────────────


class ServerEngine:
    def __init__(self, base: str) -> None:
        self.base = base.rstrip("/")
        self._client = httpx.Client(timeout=httpx.Timeout(connect=3.0, read=600.0, write=10.0, pool=10.0))
        # Verify reachability up front so a bad URL fails clearly.
        try:
            r = self._client.get(f"{self.base}/api/health")
            r.raise_for_status()
            d = r.json()
            print(f"{GREY}[server] {self.base} · {d.get('device')} · {d.get('dtype')}{RESET}")
        except Exception as exc:
            sys.exit(f"[fatal] cannot reach server at {self.base}: {exc}")

    def stream(self, session: Session, user_msg: str) -> Iterable[dict]:
        body = {
            "messages": session.history + [{"role": "user", "content": user_msg}],
            "stream": True,
            "max_new_tokens": 768,
            "thinking": session.thinking,
            "system": session.system,
        }
        with self._client.stream("POST", f"{self.base}/api/chat", json=body) as resp:
            if resp.status_code != 200:
                yield {"event": "error", "content": f"HTTP {resp.status_code}"}
                return
            buffer = ""
            for chunk in resp.iter_text():
                if not chunk:
                    continue
                buffer += chunk
                while "\n\n" in buffer:
                    block, buffer = buffer.split("\n\n", 1)
                    if not block.startswith("data:"):
                        continue
                    payload = block[5:].strip()
                    if not payload:
                        continue
                    try:
                        yield json.loads(payload)
                    except json.JSONDecodeError:
                        continue


# ───────── REPL ────────────────────────────────────────────────────────────


def read_line(prompt: str) -> Optional[str]:
    try:
        return input(prompt)
    except (EOFError, KeyboardInterrupt):
        print()
        return None


def handle_command(cmd: str, session: Session) -> bool:
    """Returns True if the command was handled (and we should not send to model)."""
    parts = cmd.strip().split(maxsplit=1)
    head = parts[0]
    arg = parts[1] if len(parts) > 1 else ""
    if head in ("/quit", "/exit"):
        raise SystemExit(0)
    if head == "/help":
        print(HELP)
        return True
    if head == "/reset":
        session.history.clear()
        print(f"{GREY}[已清空对话历史]{RESET}")
        return True
    if head == "/think":
        if arg in ("on", "true", "1"):
            session.thinking = True
        elif arg in ("off", "false", "0"):
            session.thinking = False
        else:
            session.thinking = not session.thinking
        print(f"{GREY}[显示思考: {'开' if session.thinking else '关'}]{RESET}")
        return True
    if head == "/system":
        if not arg:
            print(f"{GREY}当前 system:{RESET}\n{session.system}")
        else:
            session.system = arg
            session.history.clear()
            print(f"{GREY}[已更新 system prompt 并清空历史]{RESET}")
        return True
    if head == "/save":
        if not arg:
            print(f"{GREY}用法: /save <file.json>{RESET}")
            return True
        path = Path(arg).expanduser()
        path.write_text(
            json.dumps({"system": session.system, "history": session.history}, ensure_ascii=False, indent=2),
            "utf-8",
        )
        print(f"{GREY}[已保存到 {path}]{RESET}")
        return True
    if head.startswith("/"):
        print(f"{GREY}[未知命令: {head}]{RESET}")
        return True
    return False


def repl(engine, bridge: ClawdBridge, system: str, *, default_thinking: bool = False) -> None:
    session = Session(system)
    session.thinking = default_thinking
    while True:
        line = read_line(f"{CYAN}{BOLD}你 ▶ {RESET}")
        if line is None:
            break
        line = line.strip()
        if not line:
            continue
        if line.startswith("/"):
            if handle_command(line, session):
                continue

        bridge.new_session()
        bridge.post("thinking")
        print(f"{PURPLE}🐾 ▶{RESET} ", end="", flush=True)
        bridge.post("working")
        last_ping = time.time()

        in_think = False
        content_acc = ""
        had_error = False
        try:
            for ev in engine.stream(session, line):
                kind = ev.get("event")
                content = ev.get("content", "")
                if kind == "think":
                    if not in_think:
                        print(f"{DIM}{PURPLE}[思考] {RESET}{DIM}", end="", flush=True)
                        in_think = True
                    print(content, end="", flush=True)
                elif kind == "delta":
                    if in_think:
                        print(f"{RESET}\n{PURPLE}🐾 ▶{RESET} ", end="", flush=True)
                        in_think = False
                    print(content, end="", flush=True)
                    content_acc += content
                elif kind == "error":
                    had_error = True
                    print(f"\n{GREY}[错误] {ev.get('message') or content}{RESET}")
                if time.time() - last_ping > 6:
                    bridge.post("working")
                    last_ping = time.time()
        except KeyboardInterrupt:
            print(f"\n{GREY}[已中断]{RESET}")
            bridge.post("attention")
            continue
        if in_think:
            print(RESET)
        print()  # newline after assistant turn

        if not had_error and content_acc:
            session.history.append({"role": "user", "content": line})
            session.history.append({"role": "assistant", "content": content_acc})
        bridge.post("attention" if not had_error else "error")


# ───────── main ────────────────────────────────────────────────────────────


def main() -> None:
    p = argparse.ArgumentParser(description="MiniCPM terminal chat (with desktop pet animations)")
    p.add_argument("--server", default=os.environ.get("MINICPM_SERVER"),
                   help="Connect to a running server.py at this URL (e.g. http://127.0.0.1:8765). "
                        "Default: load the model directly in this process.")
    p.add_argument("--model", default=str(DEFAULT_MODEL_DIR),
                   help=f"Model dir for direct mode (default: {DEFAULT_MODEL_DIR})")
    p.add_argument("--dtype", choices=["auto", "bfloat16", "float16", "float32"], default="auto")
    p.add_argument("--device", default=None)
    p.add_argument("--system", default=DEFAULT_SYSTEM_PROMPT)
    p.add_argument("--thinking", action="store_true", help="Default to showing <think> reasoning")
    p.add_argument("--no-pet", action="store_true", help="Disable clawd-on-desk state push")
    p.add_argument("--debug-pet", action="store_true")
    args = p.parse_args()

    bridge = ClawdBridge(enabled=not args.no_pet, debug=args.debug_pet)

    if args.server:
        engine = ServerEngine(args.server)
        banner(f"server 模式 · {args.server}")
    else:
        model_dir = Path(args.model).expanduser().resolve()
        if not (model_dir / "config.json").exists():
            sys.exit(f"[fatal] model not found: {model_dir}")
        engine = DirectEngine(model_dir, args.dtype, args.device)
        banner(f"直连模式 · {engine.device} · {engine._dtype_name()}")

    bridge.post("idle")
    try:
        repl(engine, bridge, args.system, default_thinking=args.thinking)
    finally:
        bridge.post("sleeping")
        bridge.close()
        print(f"{GREY}再见 👋{RESET}")


if __name__ == "__main__":
    main()
