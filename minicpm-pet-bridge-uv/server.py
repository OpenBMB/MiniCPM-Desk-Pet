"""MiniCPM 0.9B local chat server, bridged to the clawd-on-desk pet.

Runs an OpenAI-compatible-ish streaming chat endpoint on top of HuggingFace
transformers, plus a static chat page. While the model is generating, we push
pet states (thinking → working → attention) to the desktop pet's HTTP server so
it animates along with the conversation.

Usage:
    python server.py --model /path/to/minicpm5-0.9b --host 127.0.0.1 --port 18765

Open http://127.0.0.1:18765 in a browser.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncGenerator, List, Optional

import torch
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from transformers import AutoModelForCausalLM, AutoTokenizer, TextIteratorStreamer

from clawd_state import ClawdBridge
from updater import ModelUpdater, DEFAULT_SOURCE as DEFAULT_UPDATE_SOURCE


_real_print = print  # capture before sed-replacement victim


def _safe_print(*args, **kwargs):
    """print() that swallows BrokenPipeError so a dead parent process can't
    crash the sidecar. Happens when the Electron host gets pkill -9'd while
    we're still alive and our stdout pipe ends up writing to nowhere."""
    try:
        _real_print(*args, **kwargs)
    except (BrokenPipeError, OSError):
        # Re-target stdout to /dev/null once and stop fighting it.
        try:
            sys.stdout = open(os.devnull, "w")
            sys.stderr = open(os.devnull, "w")
        except Exception:
            pass


# ── Python-side logging ──────────────────────────────────────────────────────
#
# The Electron host already mirrors our stdout/stderr to
# `<userData>/logs/sidecar.log` (see clawd-on-desk/src/minicpm-chat.js),
# but that file is "what the parent saw", which:
#   - is gone when the sidecar runs standalone (./go.sh, manual uv run)
#   - only contains broken-pipe-safe `_safe_print` output, not exceptions
#     raised inside transformers / peft / torch
#
# This module adds a *second* file logger inside the sidecar itself:
#
#   <log dir>/sidecar-internal.log
#
# where `<log dir>` is:
#   1. $MINICPM_LOG_DIR  (set by Electron when packaged)
#   2. $XDG_STATE_HOME/minicpm-pet-bridge/  (Linux convention)
#   3. ~/Library/Logs/MiniCPM Desk Pet/sidecar/  (macOS convention)
#   4. <bridge dir>/.logs/  (dev fallback)
#
# Anything routed through `log = get_logger()` lands in BOTH the file and
# stderr. Exceptions caught around model load / generation / adapter swap
# go through `log.exception(...)` so the full traceback persists on disk.

import logging
import logging.handlers
import platform


def _resolve_log_dir() -> Path:
    env_dir = os.environ.get("MINICPM_LOG_DIR")
    if env_dir:
        return Path(env_dir).expanduser().resolve()
    if platform.system() == "Darwin":
        return Path.home() / "Library" / "Logs" / "MiniCPM Desk Pet" / "sidecar"
    xdg_state = os.environ.get("XDG_STATE_HOME")
    if xdg_state:
        return Path(xdg_state).expanduser() / "minicpm-pet-bridge"
    if platform.system() == "Linux":
        return Path.home() / ".local" / "state" / "minicpm-pet-bridge"
    if platform.system() == "Windows":
        appdata = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA")
        if appdata:
            return Path(appdata) / "MiniCPM Desk Pet" / "logs"
    return Path(__file__).resolve().parent / ".logs"


class _StderrSafeStreamHandler(logging.StreamHandler):
    """StreamHandler that survives a closed parent pipe."""

    def emit(self, record):
        try:
            super().emit(record)
        except (BrokenPipeError, OSError):
            # Same fallback strategy as `_safe_print`: stop trying.
            try:
                self.stream = open(os.devnull, "w")
            except Exception:
                pass


_LOGGER_NAME = "minicpm-sidecar"
_logger_configured = False


def setup_logging(level: int = logging.INFO) -> logging.Logger:
    """Configure (idempotently) the file + stderr logger and return it.

    Safe to call multiple times — only attaches handlers on first call.
    """
    global _logger_configured
    log = logging.getLogger(_LOGGER_NAME)
    if _logger_configured:
        return log

    log.setLevel(level)
    log.propagate = False

    fmt = logging.Formatter(
        fmt="%(asctime)s %(levelname)-5s %(name)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    # Stderr handler — mirrors what the Electron host already captures
    # into <userData>/logs/sidecar.log, so dev/packaged behaviour matches.
    stream = _StderrSafeStreamHandler(stream=sys.stderr)
    stream.setFormatter(fmt)
    log.addHandler(stream)

    # File handler — the *sidecar's own* persistent log. Rotated at 2 MB,
    # 3 backups kept so we don't grow unbounded if Electron leaves us
    # running for days.
    try:
        log_dir = _resolve_log_dir()
        log_dir.mkdir(parents=True, exist_ok=True)
        log_path = log_dir / "sidecar-internal.log"
        file_h = logging.handlers.RotatingFileHandler(
            log_path,
            maxBytes=2 * 1024 * 1024,
            backupCount=3,
            encoding="utf-8",
        )
        file_h.setFormatter(fmt)
        log.addHandler(file_h)
        # Announce so users / agents know where to look.
        _safe_print(f"[sidecar] internal log -> {log_path}", file=sys.stderr, flush=True)
    except Exception as exc:
        _safe_print(f"[sidecar] file logger setup failed: {exc}", file=sys.stderr, flush=True)

    _logger_configured = True
    return log


def get_logger() -> logging.Logger:
    """Module-level convenience accessor — calls setup_logging() lazily."""
    return setup_logging()


DEFAULT_MODEL_DIR = Path(__file__).resolve().parent.parent / "models" / "minicpm5-0.9b"
DEFAULT_MODELS_ROOT = Path(__file__).resolve().parent.parent / "models"
STATIC_DIR = Path(__file__).resolve().parent / "static"

# Two prompt templates we cycle between based on which LoRA is loaded.
DEFAULT_PROMPT_BASE = (
    "你是 MiniCPM，一只在用户桌面上陪伴他们的可爱桌宠 AI 助手。"
    "请用简洁、自然、温暖的中文回答用户问题；当用户用英文问你时也用英文。"
    "回答尽量直奔主题，不要过度寒暄。"
)

NEKO_SYSTEM_PROMPT = (
    "你是一只可爱的猫娘，名字叫宝宝，是用户桌面上的小桌宠。"
    "请用毛茸茸、撒娇、带「喵」「的说」「呜哇」等语气词的口吻，"
    "配合 (动作) 描述回应主人。回答简洁自然，不要长篇大论。"
)

# DEFAULT_SYSTEM_PROMPT is *runtime-mutable*; it tracks the active persona,
# which itself follows whichever adapter is currently loaded. Updated by
# `set_persona_for_adapter()` whenever the adapter changes.
DEFAULT_SYSTEM_PROMPT = DEFAULT_PROMPT_BASE


def set_persona_for_adapter(adapter_dir):
    """Pick the right system prompt for whichever LoRA is currently loaded."""
    global DEFAULT_SYSTEM_PROMPT
    name = ""
    try:
        name = adapter_dir.name.lower() if adapter_dir is not None else ""
    except Exception:
        name = ""
    if "neko" in name:
        DEFAULT_SYSTEM_PROMPT = NEKO_SYSTEM_PROMPT
    else:
        DEFAULT_SYSTEM_PROMPT = DEFAULT_PROMPT_BASE


def current_persona() -> str:
    return "neko" if DEFAULT_SYSTEM_PROMPT == NEKO_SYSTEM_PROMPT else "default"


# ----- Schema -----------------------------------------------------------------


class ChatMessage(BaseModel):
    role: str = Field(..., description="'system' | 'user' | 'assistant'")
    content: str


class ChatRequest(BaseModel):
    messages: List[ChatMessage]
    max_new_tokens: int = 512
    temperature: float = 0.6
    top_p: float = 0.95
    top_k: int = 0  # 0 = disabled (no top-k filtering)
    repetition_penalty: float = 1.05
    stream: bool = True
    system: Optional[str] = None
    thinking: bool = False  # If true, surface model's <think> reasoning to the client.
    silent: bool = False    # If true, skip pushing pet states (used by narration / background calls).
    disable_adapter: bool = False  # If true, run base model only (skip LoRA) for this request.


# ----- Model wrapper ----------------------------------------------------------


class ChatEngine:
    def __init__(
        self,
        model_dir: Path,
        dtype: str = "auto",
        device: Optional[str] = None,
        adapter_dir: Optional[Path] = None,
    ) -> None:
        self.device = device or self._pick_device()
        self.requested_dtype = dtype
        self.torch_dtype = self._pick_dtype(dtype)
        # Single-flight lock — one inference at a time on the local box.
        self._lock = threading.Lock()
        self._swap_lock = threading.Lock()
        self.model_dir: Path = model_dir
        self.adapter_dir: Optional[Path] = Path(adapter_dir).expanduser().resolve() if adapter_dir else None
        self.model = None
        self.tokenizer = None
        self.eos_token_ids: list[int] = []
        self.load(model_dir)

    def swap_adapter(self, adapter_dir: Optional[Path]) -> None:
        """Swap or remove the LoRA adapter at runtime.

        Easiest correctness path: drop the current model and rebuild from the
        same base + new adapter. ~3-4 s on M-series. Cheaper than juggling
        PEFT add_adapter/set_adapter for what is effectively a manual op.
        """
        with self._swap_lock:
            self.adapter_dir = Path(adapter_dir).expanduser().resolve() if adapter_dir else None
        # `load(force=True)` re-reads the same model dir; we just need to
        # have already updated `self.adapter_dir` before it runs.
        self.load(self.model_dir, force=True)

    def load(self, model_dir: Path, *, force: bool = False) -> None:
        """(Re)load weights in place. Blocks new generations during the swap.

        If `force=True`, weights are reloaded even when `model_dir` matches
        the currently loaded directory (used after an in-place update).
        """
        log = get_logger()
        with self._swap_lock:
            if not force and self.model is not None and Path(model_dir) == self.model_dir:
                log.debug("load() no-op: %s already loaded", model_dir)
                return
            log.info(
                "load start | dir=%s device=%s dtype=%s adapter=%s",
                model_dir,
                self.device,
                str(self.torch_dtype).replace("torch.", ""),
                self.adapter_dir.name if self.adapter_dir else None,
            )
            t0 = time.time()
            try:
                tokenizer = AutoTokenizer.from_pretrained(str(model_dir), trust_remote_code=True)
                # On Apple Silicon MPS, the SDPA path crashes inside MPSGraph
                # when the model uses Grouped-Query Attention (Q heads ≫ KV
                # heads) — the MPS kernel can't infer the broadcast shape of
                # `(B, n_q, T, d) @ (B, n_kv, d, T)` and raises:
                #     LLVM ERROR: Failed to infer result type(s) for mps.matmul
                # Forcing eager attention makes transformers do the
                # repeat_interleave on KV before the matmul, which stays
                # within ops MPS handles.
                attn_kwargs = {}
                if self.device == "mps":
                    attn_kwargs["attn_implementation"] = "eager"
                    log.info("load: forcing attn_implementation=eager for MPS")
                model = AutoModelForCausalLM.from_pretrained(
                    str(model_dir),
                    torch_dtype=self.torch_dtype,
                    trust_remote_code=True,
                    low_cpu_mem_usage=True,
                    **attn_kwargs,
                )
                if self.adapter_dir is not None:
                    if (self.adapter_dir / "adapter_config.json").exists():
                        log.info("load: applying LoRA adapter %s", self.adapter_dir.name)
                        from peft import PeftModel
                        model = PeftModel.from_pretrained(model, str(self.adapter_dir))
                    else:
                        log.warning(
                            "load: adapter dir has no adapter_config.json, skipping: %s",
                            self.adapter_dir,
                        )
                model = model.to(self.device)
                model.eval()
                old_model = self.model
                self.model = model
                self.tokenizer = tokenizer
                self.eos_token_ids = _coerce_eos_ids(model.generation_config.eos_token_id, tokenizer)
                self.model_dir = Path(model_dir)
                # Classifier baselines depend on the model + tokenizer pair.
                self._classify_baseline_cache = {}
                del old_model
                try:
                    if self.device == "mps":
                        torch.mps.empty_cache()
                    elif self.device == "cuda":
                        torch.cuda.empty_cache()
                except Exception:
                    pass
                log.info("load ready | took=%.1fs eos_token_ids=%s", time.time() - t0, self.eos_token_ids)
            except Exception:
                # Persist the *full* traceback to disk — without this the
                # only place a `RuntimeError: Failed to find class
                # transformers.models.minicpm5.*` shows up is the parent's
                # stderr ring buffer, which gets truncated to 1500 chars.
                log.exception("load FAILED for %s", model_dir)
                raise
            self._warmup()

    def _warmup(self) -> None:
        """Pre-compile MPS kernels for every code path the user can hit, so
        the first real generation isn't penalised with a multi-second lag.

        We exercise three distinct paths because each compiles slightly
        different kernels on first use:
          1) sampling generate (default chat: temperature > 0)
          2) greedy generate    (classifier path: temperature == 0)
          3) forward-only       (classify endpoint, if ever called)
        and run them once with the LoRA adapter active and once with it
        disabled (chat uses LoRA; classifier always disables it).
        """
        log = get_logger()
        try:
            log.info("warmup starting kernels …")
            t0 = time.time()
            text = self.tokenizer.apply_chat_template(
                [{"role": "user", "content": "你好"}],
                tokenize=False,
                add_generation_prompt=True,
                enable_thinking=False,
            )
            inputs = self.tokenizer([text], return_tensors="pt").to(self.device)
            pad_id = self.tokenizer.pad_token_id or self.eos_token_ids[0]
            has_adapter = hasattr(self.model, "disable_adapter")

            def _run_one(mode: str, *, sample: bool, with_adapter: bool):
                with torch.inference_mode():
                    if not with_adapter and has_adapter:
                        with self.model.disable_adapter():
                            self.model.generate(
                                **inputs,
                                max_new_tokens=8,
                                do_sample=sample,
                                temperature=0.6 if sample else 1.0,
                                top_p=0.9 if sample else 1.0,
                                eos_token_id=self.eos_token_ids,
                                pad_token_id=pad_id,
                            )
                    else:
                        self.model.generate(
                            **inputs,
                            max_new_tokens=8,
                            do_sample=sample,
                            temperature=0.6 if sample else 1.0,
                            top_p=0.9 if sample else 1.0,
                            eos_token_id=self.eos_token_ids,
                            pad_token_id=pad_id,
                        )

            # Chat path (sampling, with adapter if loaded).
            _run_one("chat-sampling", sample=True, with_adapter=True)
            # Classifier path (greedy, base model only).
            _run_one("classify-greedy", sample=False, with_adapter=False)
            log.info("warmup done in %.1fs", time.time() - t0)
        except Exception as exc:
            log.exception("warmup skipped: %s", exc)

    @staticmethod
    def _pick_device() -> str:
        if torch.backends.mps.is_available():
            return "mps"
        if torch.cuda.is_available():
            return "cuda"
        return "cpu"

    @staticmethod
    def _pick_dtype(dtype: str) -> torch.dtype:
        if dtype == "float32":
            return torch.float32
        if dtype == "float16":
            return torch.float16
        if dtype == "bfloat16":
            return torch.bfloat16
        # 'auto' — bf16 on Apple Silicon (MPS supports it on macOS 14+); else fp16/fp32.
        if torch.backends.mps.is_available():
            return torch.bfloat16
        if torch.cuda.is_available():
            # bf16 needs SM 8.0+ (Ampere). On Turing / Pascal cards
            # torch.cuda.is_bf16_supported() returns True via emulation but
            # generation is unusably slow, so we force fp16 there.
            try:
                major, _ = torch.cuda.get_device_capability(0)
                if major >= 8 and torch.cuda.is_bf16_supported():
                    return torch.bfloat16
                return torch.float16
            except Exception:
                return torch.float16
        # Pure CPU: stay on fp32. PyTorch CPU bf16 kernels are incomplete
        # and noticeably slower than fp32 on most laptop CPUs.
        return torch.float32

    def _build_inputs(
        self,
        messages: List[ChatMessage],
        system: Optional[str],
        enable_thinking: bool,
    ) -> "tuple[torch.Tensor, torch.Tensor]":
        chat: list[dict] = []
        if system:
            chat.append({"role": "system", "content": system})
        for m in messages:
            chat.append({"role": m.role, "content": m.content})
        text = self.tokenizer.apply_chat_template(
            chat,
            tokenize=False,
            add_generation_prompt=True,
            enable_thinking=enable_thinking,
        )
        inputs = self.tokenizer([text], return_tensors="pt")
        return inputs.input_ids.to(self.device), inputs.attention_mask.to(self.device)

    _classify_baseline_cache: dict = {}

    def _raw_classify(self, system: str, user: str, cand_tokens: list[tuple[str, int]]) -> dict:
        text = self.tokenizer.apply_chat_template(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            tokenize=False,
            add_generation_prompt=True,
            enable_thinking=False,
        )
        inputs = self.tokenizer([text], return_tensors="pt").to(self.device)
        with self._lock:
            with torch.inference_mode():
                if hasattr(self.model, "disable_adapter"):
                    with self.model.disable_adapter():
                        out = self.model(**inputs)
                else:
                    out = self.model(**inputs)
        last_logits = out.logits[0, -1, :].float()
        return {c: float(last_logits[tok].item()) for c, tok in cand_tokens}

    def classify(self, system: str, user: str, candidates: list[str], calibrate: bool = True) -> dict:
        """Constrained classification via first-token logit comparison.

        Builds a chat prompt (system + user) and runs ONE forward pass — no
        generation. For each candidate (typically a single Chinese char that
        encodes 'intent'), we score the logit of its first token; highest wins.

        With `calibrate=True` we subtract the baseline logit (same prompt
        with EMPTY user input) before comparison, neutralising the model's
        prior bias toward generally-frequent characters. Baselines are
        cached per (system, candidates) tuple so the calibration adds zero
        latency after the first call.
        """
        cand_tokens: list[tuple[str, int]] = []
        for c in candidates:
            ids = self.tokenizer(c, add_special_tokens=False).input_ids
            if not ids:
                continue
            cand_tokens.append((c, int(ids[0])))
        if not cand_tokens:
            return {"winner": None, "scores": {}}

        scores = self._raw_classify(system, user, cand_tokens)
        if not calibrate:
            winner = max(scores, key=scores.get)
            return {"winner": winner, "scores": scores}

        cache_key = (system, tuple(c for c, _ in cand_tokens))
        baseline = self._classify_baseline_cache.get(cache_key)
        if baseline is None:
            baseline = self._raw_classify(system, "", cand_tokens)
            self._classify_baseline_cache[cache_key] = baseline

        calibrated = {c: scores[c] - baseline[c] for c in scores}
        winner = max(calibrated, key=calibrated.get)
        return {"winner": winner, "scores": scores, "calibrated": calibrated, "baseline": baseline}

    def stream(
        self,
        req: ChatRequest,
    ) -> "tuple[TextIteratorStreamer, threading.Thread]":
        """Returns (streamer, generation_thread). Caller iterates the streamer."""
        system = req.system or DEFAULT_SYSTEM_PROMPT
        input_ids, attention_mask = self._build_inputs(req.messages, system, req.thinking)
        streamer = TextIteratorStreamer(
            self.tokenizer,
            skip_prompt=True,
            skip_special_tokens=True,
        )
        gen_kwargs = dict(
            input_ids=input_ids,
            attention_mask=attention_mask,
            max_new_tokens=int(max(1, min(req.max_new_tokens, 4096))),
            do_sample=req.temperature > 0,
            temperature=max(0.01, float(req.temperature)),
            top_p=float(req.top_p),
            top_k=int(req.top_k) if int(req.top_k) > 0 else 0,
            repetition_penalty=float(req.repetition_penalty),
            eos_token_id=self.eos_token_ids,
            pad_token_id=self.tokenizer.pad_token_id or self.eos_token_ids[0],
            streamer=streamer,
        )

        self._lock.acquire()

        # When the caller wants pure base-model behaviour (e.g. narration
        # summaries that should be functional, not cat-girl flavoured) and a
        # PEFT adapter is loaded, temporarily disable it for this generation.
        bypass_adapter = bool(req.disable_adapter and hasattr(self.model, "disable_adapter"))

        def _run():
            try:
                with torch.inference_mode():
                    if bypass_adapter:
                        with self.model.disable_adapter():
                            self.model.generate(**gen_kwargs)
                    else:
                        self.model.generate(**gen_kwargs)
            except Exception as exc:
                get_logger().exception("generate error: %s", exc)
                streamer.text_queue.put(streamer.stop_signal)  # unblock consumer
            finally:
                self._lock.release()

        thread = threading.Thread(target=_run, daemon=True)
        thread.start()
        return streamer, thread


def _coerce_eos_ids(value, tokenizer) -> list[int]:
    if isinstance(value, list):
        return [int(v) for v in value if v is not None]
    if isinstance(value, int):
        return [value]
    fallback = tokenizer.eos_token_id
    return [int(fallback)] if fallback is not None else []


# ----- App --------------------------------------------------------------------


def discover_models(roots: List[Path]) -> List[dict]:
    """Return [{name, path}] for every directory under `roots` containing config.json."""
    seen: set[Path] = set()
    out: List[dict] = []
    for root in roots:
        try:
            root = root.expanduser().resolve()
        except Exception:
            continue
        if not root.is_dir():
            continue
        if root in seen:
            continue
        seen.add(root)
        # 1) the root itself, if it looks like a model
        if (root / "config.json").exists():
            out.append({"name": root.name, "path": str(root)})
            continue
        # 2) immediate subdirectories
        try:
            entries = sorted(p for p in root.iterdir() if p.is_dir())
        except Exception:
            entries = []
        for entry in entries:
            if (entry / "config.json").exists():
                out.append({"name": entry.name, "path": str(entry)})
    return out


def build_app(
    engine: ChatEngine,
    bridge: ClawdBridge,
    models_roots: List[Path],
    update_source: str,
) -> FastAPI:
    updater = ModelUpdater(engine.model_dir, source=update_source)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        bridge.post("idle", title="MiniCPM 桌宠")
        try:
            yield
        finally:
            bridge.post("sleeping")
            bridge.close()

    app = FastAPI(title="MiniCPM Pet Bridge", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.post("/api/warmup")
    def warmup():
        """Cheap forward pass to fault model weights back into RAM/VRAM
        after an idle period.

        macOS aggressively pages out idle processes' memory; the first
        request after several minutes of inactivity then takes 1-3s
        instead of 0.1s. The Electron app fires this when the user opens
        the chat bubble, so by the time they finish typing the model is
        warm again. Single-token greedy generate, runs without any
        adapter to keep it constant-time regardless of LoRA state.
        """
        try:
            t0 = time.time()
            text = engine.tokenizer.apply_chat_template(
                [{"role": "user", "content": "."}],
                tokenize=False,
                add_generation_prompt=True,
                enable_thinking=False,
            )
            inputs = engine.tokenizer([text], return_tensors="pt").to(engine.device)
            pad_id = engine.tokenizer.pad_token_id or engine.eos_token_ids[0]
            with engine._lock:  # type: ignore[attr-defined]
                with torch.inference_mode():
                    has_adapter = hasattr(engine.model, "disable_adapter")
                    if has_adapter:
                        with engine.model.disable_adapter():
                            engine.model.generate(
                                **inputs,
                                max_new_tokens=1,
                                do_sample=False,
                                eos_token_id=engine.eos_token_ids,
                                pad_token_id=pad_id,
                            )
                    else:
                        engine.model.generate(
                            **inputs,
                            max_new_tokens=1,
                            do_sample=False,
                            eos_token_id=engine.eos_token_ids,
                            pad_token_id=pad_id,
                        )
            elapsed_ms = int((time.time() - t0) * 1000)
            return {"ok": True, "elapsed_ms": elapsed_ms}
        except Exception as exc:
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=500)

    @app.get("/api/health")
    def health():
        return {
            "ok": True,
            "device": engine.device,
            "dtype": str(engine.torch_dtype).replace("torch.", ""),
            "model_dir": str(engine.model_dir),
            "model_name": engine.model_dir.name,
            "adapter": str(engine.adapter_dir) if engine.adapter_dir else None,
            "persona": current_persona(),
        }

    @app.get("/api/devices")
    def list_devices():
        """List inference backends the host can run on.

        Returns a stable schema the Electron Onboarding UI consumes:
            available   : ordered candidates the host actually supports
            recommended : highest-quality option (mps > cuda > cpu)
            current     : whatever the running engine has loaded
            reasons     : human-readable hint per option (locale: zh)
        """
        available: List[str] = []
        reasons: dict = {}
        try:
            if torch.backends.mps.is_available():
                available.append("mps")
                reasons["mps"] = "Apple Silicon GPU (Metal)"
        except Exception:
            pass
        try:
            if torch.cuda.is_available():
                available.append("cuda")
                name = torch.cuda.get_device_name(0)
                reasons["cuda"] = f"CUDA · {name}"
        except Exception:
            pass
        available.append("cpu")
        reasons["cpu"] = "纯 CPU 推理，速度较慢但任何机器都能跑"
        recommended = available[0] if available else "cpu"
        return {
            "available": available,
            "recommended": recommended,
            "current": engine.device,
            "reasons": reasons,
        }

    @app.post("/api/set-device")
    async def set_device(payload: dict):
        """Persist the user's manual device override.

        Writes MINICPM_DEVICE for the current process so subsequent
        engine reloads honour it. The Electron side is expected to
        restart the sidecar after this returns, since `engine.device`
        is decided at construction time.
        """
        device = str(payload.get("device") or "").strip().lower()
        if device not in ("mps", "cuda", "cpu", "auto", ""):
            return JSONResponse({"error": f"unknown device: {device!r}"}, status_code=400)
        if device:
            os.environ["MINICPM_DEVICE"] = device
        else:
            os.environ.pop("MINICPM_DEVICE", None)
        return {"ok": True, "device": device or "auto", "note": "restart sidecar to take effect"}

    @app.get("/api/onboarding")
    def onboarding():
        """Single-shot status snapshot for the first-launch wizard.

        The Electron Onboarding window polls this between steps. We
        report whether the model is present and the engine is warm.
        Heavy stages (download / warmup) drive their own progress via
        /api/update-apply SSE and /api/warmup latency respectively;
        this endpoint is just the truth source for stage transitions.
        """
        model_present = (engine.model_dir / "config.json").exists()
        return {
            "model_present": model_present,
            "model_dir": str(engine.model_dir),
            "device": engine.device,
            "dtype": str(engine.torch_dtype).replace("torch.", ""),
            "adapter": str(engine.adapter_dir) if engine.adapter_dir else None,
            "persona": current_persona(),
            "stage_hint": "ready" if model_present else "model-download",
        }

    @app.get("/api/models")
    def list_models():
        items = discover_models(models_roots)
        current = str(engine.model_dir)
        return {
            "items": items,
            "current": current,
            "current_name": engine.model_dir.name,
        }

    @app.get("/api/update-check")
    async def update_check():
        # Bind the updater to whichever model is currently loaded so the
        # local revision compared against the remote tracks the active model.
        updater.local_model_dir = engine.model_dir
        return await asyncio.to_thread(updater.check)

    @app.post("/api/update-apply")
    async def update_apply():
        updater.local_model_dir = engine.model_dir

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

            threading.Thread(target=producer, daemon=True).start()

            bridge.post("working", event="UpdateApply", title="正在更新模型")
            try:
                while True:
                    ev = await queue.get()
                    if ev is sentinel:
                        break
                    yield _sse(ev)
                    if ev.get("phase") == "complete":
                        # Reload weights from disk so the running engine picks
                        # up the new revision without forcing a server restart.
                        try:
                            from functools import partial
                            await asyncio.to_thread(partial(engine.load, engine.model_dir, force=True))
                            yield _sse({"phase": "reloaded"})
                        except Exception as exc:
                            yield _sse({"phase": "reload-error", "message": str(exc)})
            finally:
                bridge.post("idle")

        return StreamingResponse(stream(), media_type="text/event-stream")

    @app.post("/api/classify")
    async def classify_endpoint(payload: dict):
        """Constrained intent classification. Body:
            {system: str, user: str, candidates: ["列","切","关","查","新","状","聊"]}
        Returns:
            {winner: "切", scores: {"列": -2.3, "切": -0.1, ...}}
        Single forward pass, no generation — typically <300 ms on M-series.
        """
        system = str(payload.get("system") or "")
        user = str(payload.get("user") or "")
        candidates = payload.get("candidates")
        if not isinstance(candidates, list) or not candidates:
            return JSONResponse({"error": "candidates is required"}, status_code=400)
        try:
            r = await asyncio.to_thread(engine.classify, system, user, [str(c) for c in candidates])
            return r
        except Exception as exc:
            return JSONResponse({"error": str(exc)}, status_code=500)

    @app.get("/api/adapters")
    def list_adapters():
        """List PEFT adapter directories the user can switch to.

        Scans <repo-root>/adapters/ for subdirs that contain adapter_config.json.
        """
        roots = [Path(__file__).resolve().parent.parent / "adapters"]
        items: list[dict] = []
        seen: set[Path] = set()
        for root in roots:
            try:
                root = root.expanduser().resolve()
            except Exception:
                continue
            if not root.is_dir() or root in seen:
                continue
            seen.add(root)
            for entry in sorted(p for p in root.iterdir() if p.is_dir()):
                if (entry / "adapter_config.json").exists():
                    items.append({"name": entry.name, "path": str(entry)})
        current = str(engine.adapter_dir) if engine.adapter_dir else None
        return {
            "items": items,
            "current": current,
            "current_name": Path(current).name if current else None,
        }

    @app.post("/api/load-adapter")
    async def load_adapter(payload: dict):
        """Switch (or disable) the LoRA adapter.

        Body: {"path": "<dir>"} to load, or {"path": null} / {} to disable.
        """
        raw = payload.get("path")
        target: Optional[Path] = None
        if isinstance(raw, str) and raw.strip():
            target = Path(raw).expanduser().resolve()
            if not (target / "adapter_config.json").exists():
                return JSONResponse(
                    {"error": f"not a PEFT adapter dir: {target}"},
                    status_code=400,
                )
        bridge.post(
            "working",
            event="LoadAdapter",
            title=f"加载 {target.name if target else 'base'}",
        )
        try:
            await asyncio.to_thread(engine.swap_adapter, target)
        except Exception as exc:
            bridge.post("error")
            return JSONResponse({"error": str(exc)}, status_code=500)
        # Sync the system prompt with the new adapter so the chat persona
        # matches whichever LoRA is now loaded.
        set_persona_for_adapter(engine.adapter_dir)
        bridge.post("idle")
        return {
            "ok": True,
            "adapter": str(engine.adapter_dir) if engine.adapter_dir else None,
            "adapter_name": engine.adapter_dir.name if engine.adapter_dir else None,
            "persona": current_persona(),
        }

    @app.post("/api/load-model")
    async def load_model(payload: dict):
        path = str(payload.get("path") or "").strip()
        if not path:
            return JSONResponse({"error": "path is required"}, status_code=400)
        target = Path(path).expanduser().resolve()
        if not (target / "config.json").exists():
            return JSONResponse({"error": f"not a HF model dir: {target}"}, status_code=400)
        bridge.post("working", event="LoadModel", title=f"加载 {target.name}")
        try:
            await asyncio.to_thread(engine.load, target)
        except Exception as exc:
            bridge.post("error")
            return JSONResponse({"error": str(exc)}, status_code=500)
        bridge.post("idle")
        return {"ok": True, "model_dir": str(engine.model_dir), "model_name": engine.model_dir.name}

    @app.post("/api/chat")
    async def chat(req: ChatRequest):
        if not req.messages:
            return JSONResponse({"error": "messages is empty"}, status_code=400)
        if req.stream:
            return StreamingResponse(_stream_chat(engine, bridge, req), media_type="text/event-stream")
        return JSONResponse(await asyncio.to_thread(_blocking_chat, engine, bridge, req))

    @app.post("/api/state")
    def manual_state(payload: dict):
        state = str(payload.get("state") or "idle")
        bridge.post(state, event=payload.get("event"))
        return {"ok": True}

    # The browser test page and its asset directory are optional. In dev
    # checkouts they sit at minicpm-pet-bridge/static/, but PyInstaller
    # builds may ship without them (the real UI is the Electron app).
    # Mounting StaticFiles against a missing directory raises at boot,
    # which previously crashed the entire sidecar — see crash dump
    # `sidecar-crash-2026-05-20T12-25-19-030Z.log`. Skip gracefully if
    # the directory isn't present.
    if STATIC_DIR.is_dir():
        @app.get("/")
        def index():
            return FileResponse(str(STATIC_DIR / "index.html"))

        app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
    else:
        @app.get("/")
        def index():
            return JSONResponse({
                "ok": True,
                "note": "browser test page not shipped in this build; use the Electron app instead",
                "endpoints": [
                    "/api/health", "/api/chat", "/api/warmup", "/api/devices",
                    "/api/onboarding", "/api/adapters", "/api/load-adapter",
                ],
            })
    return app


async def _stream_chat(engine: ChatEngine, bridge: ClawdBridge, req: ChatRequest) -> AsyncGenerator[bytes, None]:
    if not req.silent:
        bridge.new_session()
        bridge.post("thinking")
    try:
        streamer, thread = await asyncio.to_thread(engine.stream, req)
    except Exception as exc:
        if not req.silent:
            bridge.post("error")
        yield _sse({"event": "error", "message": str(exc)})
        return

    yield _sse({"event": "start"})
    if not req.silent:
        bridge.post("working")

    last_pet_ping = time.time()
    # When thinking is enabled, the chat template pre-fills "<think>\n" into
    # the prompt, so the model's first token is *inside* a think block.
    think_filter = ThinkBlockFilter(expose=req.thinking, start_inside=req.thinking)
    try:
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue()
        sentinel = object()

        def producer():
            try:
                for piece in streamer:
                    loop.call_soon_threadsafe(queue.put_nowait, piece)
            finally:
                loop.call_soon_threadsafe(queue.put_nowait, sentinel)

        threading.Thread(target=producer, daemon=True).start()

        while True:
            piece = await queue.get()
            if piece is sentinel:
                break
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
    finally:
        for ev in think_filter.flush():
            yield _sse(ev)
        thread.join(timeout=0.1)

    yield _sse({"event": "end"})
    if not req.silent:
        bridge.post("attention")


class ThinkBlockFilter:
    """Splits the model stream into reasoning (<think>...) and content events.

    The MiniCPM chat template wraps reasoning in <think>...</think>. We hold any
    text that *might* be the start of a tag until we know for sure, then emit it
    as either `event: think` (when expose=True) or drop it (when expose=False).
    Plain text outside the tag is emitted as `event: delta`.
    """

    OPEN_TAG = "<think>"
    CLOSE_TAG = "</think>"

    def __init__(self, *, expose: bool, start_inside: bool = False) -> None:
        self.expose = expose
        self._buf = ""
        self._mode = "inside" if start_inside else "outside"

    def feed(self, piece: str) -> list[dict]:
        self._buf += piece
        return list(self._drain())

    def flush(self) -> list[dict]:
        out = list(self._drain(final=True))
        if self._buf:
            ev = "think" if (self._mode == "inside" and self.expose) else "delta"
            if self._mode == "inside" and not self.expose:
                pass  # drop
            else:
                out.append({"event": ev, "content": self._buf})
            self._buf = ""
        return out

    def _drain(self, *, final: bool = False):
        while self._buf:
            if self._mode == "outside":
                idx = self._buf.find(self.OPEN_TAG)
                if idx < 0:
                    safe_len = self._safe_emit_len(self._buf, self.OPEN_TAG)
                    if safe_len <= 0:
                        if final:
                            if self._buf:
                                yield {"event": "delta", "content": self._buf}
                                self._buf = ""
                        return
                    out, self._buf = self._buf[:safe_len], self._buf[safe_len:]
                    if out:
                        yield {"event": "delta", "content": out}
                    return
                if idx > 0:
                    out, self._buf = self._buf[:idx], self._buf[idx:]
                    yield {"event": "delta", "content": out}
                self._buf = self._buf[len(self.OPEN_TAG):]
                self._mode = "inside"
            else:  # inside <think>
                idx = self._buf.find(self.CLOSE_TAG)
                if idx < 0:
                    safe_len = self._safe_emit_len(self._buf, self.CLOSE_TAG)
                    if safe_len <= 0:
                        return
                    out, self._buf = self._buf[:safe_len], self._buf[safe_len:]
                    if out and self.expose:
                        yield {"event": "think", "content": out}
                    return
                head, self._buf = self._buf[:idx], self._buf[idx + len(self.CLOSE_TAG):]
                if head and self.expose:
                    yield {"event": "think", "content": head}
                self._mode = "outside"
                # Eat exactly one trailing "\n\n" the template inserts after </think>
                if self._buf.startswith("\n\n"):
                    self._buf = self._buf[2:]
                elif self._buf.startswith("\n"):
                    self._buf = self._buf[1:]

    @staticmethod
    def _safe_emit_len(buf: str, tag: str) -> int:
        """Return how many chars of `buf` we can safely emit without crossing
        a partial occurrence of `tag` at the buffer tail."""
        max_keep = len(tag) - 1
        for keep in range(min(max_keep, len(buf)), 0, -1):
            if tag.startswith(buf[-keep:]):
                return len(buf) - keep
        return len(buf)


def _blocking_chat(engine: ChatEngine, bridge: ClawdBridge, req: ChatRequest) -> dict:
    if not req.silent:
        bridge.new_session()
        bridge.post("thinking")
    streamer, thread = engine.stream(req)
    if not req.silent:
        bridge.post("working")
    think_filter = ThinkBlockFilter(expose=req.thinking, start_inside=req.thinking)
    content_parts: list[str] = []
    think_parts: list[str] = []
    for piece in streamer:
        for ev in think_filter.feed(piece):
            (think_parts if ev["event"] == "think" else content_parts).append(ev["content"])
    for ev in think_filter.flush():
        (think_parts if ev["event"] == "think" else content_parts).append(ev["content"])
    thread.join(timeout=0.1)
    if not req.silent:
        bridge.post("attention")
    return {
        "content": "".join(content_parts),
        "thinking": "".join(think_parts) if req.thinking else None,
    }


def _sse(payload: dict) -> bytes:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode("utf-8")


# ----- CLI --------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(description="MiniCPM local chat + clawd-on-desk bridge")
    parser.add_argument(
        "--model",
        default=os.environ.get("MINICPM_MODEL_DIR") or os.environ.get("MINICPM_MODEL") or str(DEFAULT_MODEL_DIR),
        help=(
            "Initial model directory. Reads MINICPM_MODEL_DIR (preferred, used by the "
            "packaged Electron app) then MINICPM_MODEL, falling back to "
            f"{DEFAULT_MODEL_DIR}."
        ),
    )
    parser.add_argument("--models-root", action="append", default=None,
                        help="Directory to scan for model subfolders. Can be passed multiple times. "
                             f"Default: {DEFAULT_MODELS_ROOT}")
    parser.add_argument("--host", default="127.0.0.1")
    # Default port avoids 8765 (Apache CouchDB / Bitcoin Cash test / etc.)
    # to dodge common collisions on developer machines. Override with
    # MINICPM_PORT env (the Electron app sets this automatically) or
    # --port on the command line.
    parser.add_argument("--port", type=int, default=int(os.environ.get("MINICPM_PORT") or 18765))
    parser.add_argument("--dtype", choices=["auto", "bfloat16", "float16", "float32"], default="auto")
    parser.add_argument(
        "--device",
        default=(os.environ.get("MINICPM_DEVICE") or None),
        help="Force device (mps/cuda/cpu). Reads MINICPM_DEVICE env (set by Settings → 加速器 in the Electron app) when not provided.",
    )
    parser.add_argument("--no-pet", action="store_true", help="Disable clawd-on-desk state push")
    parser.add_argument("--debug-pet", action="store_true")
    parser.add_argument("--update-source", default=os.environ.get("MINICPM_UPDATE_SOURCE", DEFAULT_UPDATE_SOURCE),
                        help="Source for model updates: mock://<path> or hf://<repo_id>")
    parser.add_argument("--adapter", default=os.environ.get("MINICPM_ADAPTER"),
                        help="Optional LoRA adapter dir to apply on top of the base model")
    parser.add_argument("--persona", choices=["default", "neko"],
                        default=os.environ.get("MINICPM_PERSONA", "default"),
                        help="Which built-in system prompt to use")
    args = parser.parse_args()

    # Initialise the disk logger as early as possible so the rest of main
    # (model discovery, adapter resolution, engine boot) all hit the file.
    log = setup_logging()
    log.info(
        "sidecar starting | argv=%s python=%s platform=%s",
        sys.argv[1:],
        sys.version.split()[0],
        platform.platform(),
    )

    # "auto" is the wire-level value for "let the engine pick"; the
    # engine's _pick_device() expects None for the same intent.
    if isinstance(args.device, str) and args.device.lower() in ("", "auto"):
        args.device = None

    model_dir = Path(args.model).expanduser().resolve()
    if not (model_dir / "config.json").exists():
        log.error("model not found at %s — aborting", model_dir)
        sys.exit(f"[fatal] model not found: {model_dir}")

    roots_env = os.environ.get("MINICPM_MODELS_ROOT", "")
    cli_roots = [Path(p) for p in (args.models_root or [])]
    env_roots = [Path(p) for p in roots_env.split(":") if p]
    roots = cli_roots + env_roots + [DEFAULT_MODELS_ROOT, model_dir.parent]

    adapter_dir = Path(args.adapter).expanduser().resolve() if args.adapter else None
    if adapter_dir and not adapter_dir.exists():
        log.warning("adapter dir not found, ignoring: %s", adapter_dir)
        adapter_dir = None

    # Pick the right persona prompt for whichever adapter (if any) is loaded.
    if args.persona == "neko":
        # Forced override regardless of adapter name.
        global DEFAULT_SYSTEM_PROMPT
        DEFAULT_SYSTEM_PROMPT = NEKO_SYSTEM_PROMPT
    else:
        set_persona_for_adapter(adapter_dir)
    log.info("persona = %s", current_persona())

    try:
        engine = ChatEngine(model_dir, dtype=args.dtype, device=args.device, adapter_dir=adapter_dir)
    except Exception:
        # Already logged with traceback inside ChatEngine.load(); we
        # propagate here only to short-circuit the rest of main(). The
        # `log.exception` in load() has already persisted the trace.
        raise
    bridge = ClawdBridge(enabled=not args.no_pet, debug=args.debug_pet)

    import uvicorn  # imported here so --help works without uvicorn installed
    app = build_app(engine, bridge, roots, args.update_source)
    log.info("server listening on http://%s:%s", args.host, args.port)
    uvicorn.run(app, host=args.host, port=args.port, log_level="info", access_log=False)


if __name__ == "__main__":
    main()
