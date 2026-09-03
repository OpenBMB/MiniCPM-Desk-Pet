"""OpenVINO inference engine for Intel AIPC (Arc iGPU / AI Boost NPU).

Runs in-process, so `port` is always 0 and `lifecycle.py` does not apply —
but `stop()` must genuinely free the pipeline, since a leaked compiled
2.6B model is ~2.5 GB of a 16 GB shared budget.

`_resolve_device()` refuses an INT8 IR on the NPU. `LLMPipeline(ir, "NPU")`
constructs happily for it and only fails at `generate()`, so the check has
to happen before that call. See `IRPrecision.npu_ready` for the measurements
behind the rule; `unknown` is refused too, since it could be int8.
"""

from __future__ import annotations

import asyncio
import gc
import json
import os
import threading
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path
from typing import Any, AsyncIterator, Optional

from .log_setup import get_logger, resolve_log_dir


# ── Constants ───────────────────────────────────────────────────────────────

#: Files LLMPipeline needs. A missing tokenizer/detokenizer surfaces as a
#: confusing native throw, so we name the absent file instead.
OPENVINO_IR_FILES = (
    "openvino_model.xml",
    "openvino_model.bin",
    "openvino_tokenizer.xml",
    "openvino_detokenizer.xml",
)

#: Sidecar device vocabulary → OpenVINO's. Intel accelerators only; CPU is
#: deliberately absent.
OV_DEVICE_NAMES = {"gpu": "GPU", "npu": "NPU"}

#: Names this build no longer offers. MINICPM_DEVICE persists across versions,
#: so an upgraded machine may still have one stored; redirect to the GPU
#: rather than handing an unknown name to ov::Core.
_RETIRED_DEVICE_NAMES = frozenset({"metal", "mps", "cuda", "vulkan", "cpu"})

_DEVICE_CACHE_TTL_S = 60.0

_IR_METADATA_FILE = ".minicpm-ir.json"

#: Mirrors server.THINKING_MIN_MAX_NEW_TOKENS; kept local so this module
#: does not depend on the FastAPI layer.
HIDDEN_REASONING_FLOOR = 1280
HIDDEN_REASONING_CAP = 4096


# ── Lazy import ─────────────────────────────────────────────────────────────


def _import_genai():
    """Import `openvino_genai` on first use.

    Deferred so a default `uv sync` can still import this module and the
    frozen sidecar (which excludes the wheels) gives an actionable error.
    """
    # Must precede the first `import openvino`: openvino-telemetry reads
    # this at import time and this is a local-first app.
    os.environ.setdefault("OPENVINO_TELEMETRY_OPT_OUT", "1")
    try:
        import openvino_genai  # noqa: PLC0415  (deliberately deferred)

        return openvino_genai
    except Exception as exc:
        raise RuntimeError(
            "OpenVINO runtime not available. Install it with:\n"
            "    cd minicpm-sidecar && uv sync --extra openvino\n"
            "Note the packaged sidecar binary does not bundle OpenVINO — "
            "run the gateway from source to use this backend.\n"
            f"  (underlying error: {exc})"
        ) from exc


def _import_openvino():
    os.environ.setdefault("OPENVINO_TELEMETRY_OPT_OUT", "1")
    import openvino  # noqa: PLC0415

    return openvino


# ── IR validation + precision inspection ────────────────────────────────────


def validate_openvino_ir(path: Path) -> Optional[str]:
    """Return None when `path` is a loadable IR directory, else why not."""
    if not path.exists():
        return f"model directory does not exist: {path}"
    if not path.is_dir():
        return (
            f"the openvino backend expects a model *directory*, got a file: {path}"
        )
    missing = [name for name in OPENVINO_IR_FILES if not (path / name).is_file()]
    if missing:
        return (
            f"{path.name} is not a complete OpenVINO IR — missing "
            + ", ".join(missing)
        )
    return None


def is_openvino_ir(path: Path) -> bool:
    return validate_openvino_ir(path) is None


@dataclass(frozen=True)
class IRPrecision:
    """What we could learn about how an IR's weights are compressed."""

    weight_format: str  # "int4" | "int8" | "fp16" | "fp32" | "unknown"
    sym: Optional[bool] = None
    group_size: Optional[int] = None
    ratio: Optional[float] = None
    source: str = "unknown"  # which file told us

    @property
    def npu_ready(self) -> bool:
        """Whether the NPU can be handed this IR.

        Measured on Core Ultra 5 225H / AI Boost, openvino 2026.3.1, NPU
        driver 32.0.100.4778, with a 2.6B model on a 16 GB machine:

          int4-sym-g128  long prompt x 256 tokens x 4 runs, all fine
          fp16           same, and roughly 2x the throughput of int4
          int8           ZE_RESULT_ERROR_OUT_OF_HOST_MEMORY at the first
                         generate(), reproducibly

        So the rule is "not int8" rather than "int4 only": symmetric INT4 is
        what the OpenVINO docs recommend for this size, but uncompressed
        weights run too. INT8 weight-only is outside the documented NPU
        matrix and is what actually fails here.

        `unknown` stays refused — an IR whose precision we cannot read could
        be int8.
        """
        if self.weight_format in ("fp16", "fp32"):
            return True
        return self.weight_format == "int4" and self.sym is True

    def describe(self) -> str:
        bits = [self.weight_format]
        if self.weight_format not in ("fp16", "fp32"):
            if self.sym is True:
                bits.append("sym")
            elif self.sym is False:
                bits.append("asym")
            if self.group_size is not None:
                bits.append(f"g{self.group_size}")
        return "-".join(bits)


def inspect_ir_precision(model_dir: Path) -> IRPrecision:
    """Best-effort read of an IR's weight compression, cheapest source first:
    our own `.minicpm-ir.json`, then optimum's `openvino_config.json`, then a
    streaming scan of the IR XML. "unknown" is treated as unsafe by callers.
    """
    log = get_logger()

    ours = model_dir / _IR_METADATA_FILE
    if ours.is_file():
        try:
            blob = json.loads(ours.read_text(encoding="utf-8"))
            return IRPrecision(
                weight_format=str(blob.get("weight_format", "unknown")).lower(),
                sym=blob.get("sym"),
                group_size=blob.get("group_size"),
                ratio=blob.get("ratio"),
                source=_IR_METADATA_FILE,
            )
        except Exception as exc:
            log.debug("could not parse %s: %s", ours, exc)

    optimum = model_dir / "openvino_config.json"
    if optimum.is_file():
        try:
            blob = json.loads(optimum.read_text(encoding="utf-8"))
            # A plain `--weight-format int8` export writes a stub with
            # dtype:"" and no bits, so only trust this when it says something.
            qc = blob.get("quantization_config") or {}
            bits = qc.get("bits") or blob.get("bits")
            raw_dtype = (qc.get("dtype") or blob.get("dtype") or "").strip().lower()
            fmt = raw_dtype or (f"int{bits}" if bits else "")
            if fmt and fmt != "unknown":
                return IRPrecision(
                    weight_format=fmt,
                    sym=qc.get("sym", blob.get("sym")),
                    group_size=qc.get("group_size", blob.get("group_size")),
                    ratio=qc.get("ratio", blob.get("ratio")),
                    source="openvino_config.json",
                )
            log.debug("%s carries no usable precision info; reading the IR", optimum)
        except Exception as exc:
            log.debug("could not parse %s: %s", optimum, exc)

    xml = model_dir / "openvino_model.xml"
    if xml.is_file():
        try:
            fmt = _scan_xml_weight_precision(xml)
            if fmt:
                # u4 is the asymmetric flavour, i4 the symmetric one.
                sym = True if fmt == "int4" and _XML_SIGNED_HINT else None
                return IRPrecision(
                    weight_format=fmt, sym=sym, source="openvino_model.xml"
                )
        except Exception as exc:
            log.debug("could not scan %s: %s", xml, exc)

    return IRPrecision(weight_format="unknown", source="nothing readable")


# `_scan_xml_weight_precision` sets this as a side channel so the caller can
# tell i4 (symmetric) from u4 (asymmetric) without re-walking the tree.
_XML_SIGNED_HINT = False

_XML_ELEMENT_TYPES = {
    "u4": "int4",
    "i4": "int4",
    "nf4": "int4",
    "u8": "int8",
    "i8": "int8",
    "f16": "fp16",
    "bf16": "fp16",
    "f32": "fp32",
}


def _scan_xml_weight_precision(xml_path: Path) -> Optional[str]:
    """Stream `openvino_model.xml` until the first Const with a compressed
    element type, then stop. Never builds the whole DOM."""
    global _XML_SIGNED_HINT
    _XML_SIGNED_HINT = False
    for _event, elem in ET.iterparse(str(xml_path), events=("start",)):
        if elem.tag != "data":
            continue
        etype = (elem.get("element_type") or "").lower()
        mapped = _XML_ELEMENT_TYPES.get(etype)
        if mapped in ("int4", "int8"):
            _XML_SIGNED_HINT = etype.startswith("i")
            return mapped
        elem.clear()
    return None


class NpuPrecisionError(RuntimeError):
    """Raised instead of letting the NPU kill the process."""


class NoAcceleratorError(RuntimeError):
    """No Intel GPU or NPU on this machine, and CPU is not offered."""


def assert_npu_compatible(precision: IRPrecision, model_dir: Path) -> None:
    if precision.npu_ready:
        return
    if precision.weight_format == "unknown":
        detail = (
            "its weight precision could not be determined, and an INT8 IR "
            "exhausts host memory on the NPU"
        )
    else:
        detail = (
            "INT8 weight-only is outside the documented NPU matrix and "
            "reproducibly fails with ZE_RESULT_ERROR_OUT_OF_HOST_MEMORY"
        )
    raise NpuPrecisionError(
        f"{model_dir.name} is {precision.describe()} (detected via "
        f"{precision.source}) and cannot run on the NPU: {detail}.\n"
        "The NPU accepts symmetric INT4 (recommended) or uncompressed FP16. "
        "Convert one with:\n"
        "    python scripts/convert-openvino.py --source <hf-checkpoint>"
    )


# ── Device discovery ────────────────────────────────────────────────────────

_DEVICE_CACHE: Optional[tuple[float, dict]] = None


def invalidate_device_cache() -> None:
    global _DEVICE_CACHE
    _DEVICE_CACHE = None


def _normalise_ov_device(raw: Optional[str] = None, *, available: Optional[list[str]] = None) -> str:
    """`MINICPM_DEVICE` → 'gpu' or 'npu'.

    Never auto-selects the NPU: it needs a specially quantised IR and has
    reduced sampling support, so it is opt-in only.
    """
    log = get_logger()
    value = (raw if raw is not None else os.environ.get("MINICPM_DEVICE", "")).strip().lower()

    if value in _RETIRED_DEVICE_NAMES:
        log.info(
            "MINICPM_DEVICE=%r is not offered by this build (Intel GPU/NPU only); "
            "using 'gpu' instead", value,
        )
        return "gpu"

    if value in ("", "auto"):
        return "gpu"

    if value not in OV_DEVICE_NAMES:
        log.warning("unknown device %r; using 'gpu'", value)
        return "gpu"
    return value


NO_ACCELERATOR_MESSAGE = (
    "未检测到 Intel GPU 或 NPU。此版本只在 Intel AIPC 上运行，"
    "需要 Intel Arc / Xe 核显或 AI Boost NPU。\n"
    "请确认已安装 Intel 显卡驱动（30.0.101.5122 或更新）。"
)

#: `ov::Core` reported nothing at all — not even CPU, which every install has.
#: That means the plugin libraries are missing, i.e. a mis-built bundle, not a
#: hardware problem.
BROKEN_RUNTIME_MESSAGE = (
    "OpenVINO 运行时不完整：没有加载到任何推理设备，连 CPU 都没有。\n"
    "这通常意味着安装包缺少 OpenVINO 的设备插件库，而不是你的硬件有问题。\n"
    "请重新安装本应用；开发环境下重跑 `uv sync`。"
)


def detect_devices() -> dict:
    """Devices this build offers, for `/api/devices`.

    Only GPU and NPU: this is the Intel AIPC build, and OpenVINO's CPU
    plugin is deliberately not exposed.

    Cached for a minute: `ov.Core()` costs 100-300 ms and the Settings
    panel polls this endpoint.
    """
    global _DEVICE_CACHE
    now = time.monotonic()
    if _DEVICE_CACHE and (now - _DEVICE_CACHE[0]) < _DEVICE_CACHE_TTL_S:
        return dict(_DEVICE_CACHE[1])

    log = get_logger()
    reasons: dict[str, str] = {}
    available: list[str] = []
    error: Optional[str] = None

    saw_any_device = False
    try:
        ov = _import_openvino()
        raw_devices = ov.Core().available_devices
        saw_any_device = bool(raw_devices)
        seen = set()
        for raw in raw_devices:
            # "GPU.0"/"GPU.1" both collapse to our single "gpu" bucket.
            short = raw.split(".", 1)[0].strip().lower()
            if short in OV_DEVICE_NAMES and short not in seen:
                seen.add(short)
                available.append(short)
    except Exception as exc:
        error = str(exc)
        log.warning("openvino device probe failed: %s", exc)

    if "gpu" in available:
        reasons["gpu"] = "Intel Arc / Xe 核显（推荐，支持完整采样）"
    if "npu" in available:
        reasons["npu"] = (
            "Intel AI Boost NPU（低功耗）。需要对称 INT4 模型，"
            "且采样受限，人格表现可能不如 GPU。"
        )

    ordered = [d for d in ("gpu", "npu") if d in available]
    recommended = ordered[0] if ordered else "gpu"
    current = _normalise_ov_device()

    info = {
        "available": ordered,
        "recommended": recommended,
        "current": current if current in ordered else recommended,
        "experimental": [d for d in ("npu",) if d in ordered],
        "reasons": reasons,
        # False means the runtime is broken, not that the machine lacks one.
        "runtime_ok": saw_any_device,
    }
    if error:
        info["error"] = error

    _DEVICE_CACHE = (now, info)
    return dict(info)


# ── Stop tokens ─────────────────────────────────────────────────────────────


def resolve_stop_token_ids(model_dir: Path) -> set[int]:
    """Collect every EOS id the checkpoint declares.

    MiniCPM5 declares two — `</s>` (1) and `<|im_end|>` (130073) — and
    `GenerationConfig` only carries a scalar `eos_token_id`. Miss the
    second one and every single turn runs to `max_new_tokens`, happily
    continuing past the end of its own reply with `<|im_start|>user…`.
    """
    ids: set[int] = set()
    for name in ("generation_config.json", "config.json"):
        blob_path = model_dir / name
        if not blob_path.is_file():
            continue
        try:
            blob = json.loads(blob_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        raw = blob.get("eos_token_id")
        if isinstance(raw, int):
            ids.add(raw)
        elif isinstance(raw, (list, tuple)):
            ids.update(int(x) for x in raw if isinstance(x, int))
    return ids


# ── The engine ──────────────────────────────────────────────────────────────

_SENTINEL = object()

#: Kept in sync with think_filter.ThinkBlockFilter.OPEN_TAG by the tests.
_OPEN_TAG = "<think>"


def _ensure_open_tag(lead: str) -> str:
    """Prepend the opening <think> only if the stream did not supply one."""
    return lead if lead.startswith(_OPEN_TAG) else _OPEN_TAG + "\n" + lead


class OpenVinoEngine:
    """In-process inference backed by `openvino_genai.LLMPipeline`."""

    def __init__(
        self,
        *,
        model_path: Optional[Path],
        ctx_size: int = 4096,
    ) -> None:
        self.model_path: Optional[Path] = Path(model_path) if model_path else None
        self.ctx_size = int(ctx_size)
        # No child process, but `/api/health` still reports a port.
        self.port = 0

        self.device = "gpu"
        self.device_fallback: Optional[str] = None
        self.precision: Optional[IRPrecision] = None

        self._pipe: Any = None
        self._tokenizer: Any = None
        self._genai: Any = None
        self._stop_token_ids: set[int] = set()
        self._greedy_only = False
        self._supports_extra_context = True
        self._cache_dir: Optional[Path] = None

        # asyncio locks, not threading: both are held across `await`s.
        self._lifecycle_lock = asyncio.Lock()
        # LLMPipeline is not re-entrant, and the pet really does overlap
        # requests (the narrator posts while the bubble streams).
        self._gen_lock = asyncio.Lock()
        self._threads: set[threading.Thread] = set()
        self._stop_all = threading.Event()

    # ── Lifecycle ──────────────────────────────────────────────────────

    @property
    def alive(self) -> bool:
        return self._pipe is not None

    async def start(self) -> None:
        log = get_logger()
        async with self._lifecycle_lock:
            if self._pipe is not None:
                log.debug("openvino pipeline already loaded")
                return
            if not self.model_path:
                raise RuntimeError("model_path is empty; refusing to load OpenVINO IR")

            reason = validate_openvino_ir(self.model_path)
            if reason:
                raise RuntimeError(reason)

            self._genai = _import_genai()
            self.precision = inspect_ir_precision(self.model_path)
            self.device = self._resolve_device()
            self._greedy_only = self.device == "npu" and not _env_flag(
                "MINICPM_OV_NPU_SAMPLING"
            )
            self._stop_token_ids = resolve_stop_token_ids(self.model_path)

            log.info(
                "loading OpenVINO IR %s on %s (%s)",
                self.model_path.name, self.device.upper(), self.precision.describe(),
            )
            started = time.monotonic()
            # Compilation is a 10-120s CPU-bound native call; blocking the
            # loop here would stall /api/health for its duration.
            await asyncio.to_thread(self._build_pipeline)
            log.info(
                "OpenVINO pipeline ready in %.1fs (stop tokens: %s)",
                time.monotonic() - started,
                sorted(self._stop_token_ids) or "none declared",
            )

    def _resolve_device(self) -> str:
        """Pick a device and refuse the combination that kills the process."""
        log = get_logger()
        info = detect_devices()
        available = info.get("available") or []

        # With CPU off the menu, no accelerator is a hard failure — say so
        # instead of letting LLMPipeline throw something native.
        if not available:
            raise NoAcceleratorError(
                NO_ACCELERATOR_MESSAGE if info.get("runtime_ok")
                else BROKEN_RUNTIME_MESSAGE
            )

        device = _normalise_ov_device()

        if device not in available:
            log.warning(
                "requested device %r is not available (%s); using %r",
                device, ", ".join(available), info.get("recommended"),
            )
            self.device_fallback = f"{device} unavailable"
            device = str(info.get("recommended"))

        if device == "npu":
            precision = self.precision or IRPrecision("unknown")
            if not precision.npu_ready:
                if "gpu" in available and _env_flag("MINICPM_OV_NPU_FALLBACK", default=True):
                    self.device_fallback = (
                        f"the NPU cannot run {precision.describe()} weights"
                    )
                    log.warning(
                        "%s — falling back to GPU. Set MINICPM_OV_NPU_FALLBACK=0 "
                        "to make this a hard error instead.",
                        self.device_fallback,
                    )
                    return "gpu"
                assert_npu_compatible(precision, self.model_path or Path("."))
        return device

    def _build_pipeline(self) -> None:
        """Runs on a worker thread. Everything native lives here."""
        config: dict[str, Any] = {}

        cache_dir = os.environ.get("MINICPM_OV_CACHE_DIR")
        self._cache_dir = (
            Path(cache_dir).expanduser()
            if cache_dir
            else resolve_log_dir().parent / "ov-cache"
        )
        try:
            self._cache_dir.mkdir(parents=True, exist_ok=True)
            # Without this every boot recompiles the model: 10-60s on the
            # GPU, 30-120s on the NPU, every single time the pet starts.
            config["CACHE_DIR"] = str(self._cache_dir)
        except Exception as exc:
            get_logger().warning("could not create OV cache dir: %s", exc)

        if self.device == "npu":
            # Static-shape pipeline: without a bound the prompt is silently
            # truncated at 1024 tokens and long histories produce garbage.
            config["MAX_PROMPT_LEN"] = _env_int(
                "MINICPM_OV_MAX_PROMPT_LEN", default=min(self.ctx_size, 2048)
            )
            config["MIN_RESPONSE_LEN"] = _env_int(
                "MINICPM_OV_MIN_RESPONSE_LEN", default=512
            )

        assert self.model_path is not None
        self._pipe = self._genai.LLMPipeline(
            str(self.model_path), OV_DEVICE_NAMES[self.device], **config
        )
        self._tokenizer = self._pipe.get_tokenizer()
        self._supports_extra_context = self._probe_extra_context()

    def _probe_extra_context(self) -> bool:
        """Older genai builds reject `extra_context=`; find out once."""
        try:
            self._tokenizer.apply_chat_template(
                [{"role": "user", "content": "x"}],
                add_generation_prompt=True,
                extra_context={"enable_thinking": False},
            )
            return True
        except TypeError:
            get_logger().info(
                "openvino_genai tokenizer has no extra_context=; will inject "
                "the <think> markers manually"
            )
            return False
        except Exception:
            # Any other failure is not about the signature; assume support
            # and let the real call report it.
            return True

    async def stop(self, *, timeout: float = 5.0) -> None:
        log = get_logger()
        self._stop_all.set()
        try:
            await asyncio.to_thread(self._join_threads, timeout)
            async with self._lifecycle_lock:
                if self._pipe is not None:
                    log.info("releasing OpenVINO pipeline")
                # Not dropping this leaks ~2.5 GB across a model swap.
                self._pipe = None
                self._tokenizer = None
                await asyncio.to_thread(gc.collect)
        finally:
            self._stop_all.clear()

    def _join_threads(self, timeout: float) -> None:
        for thread in list(self._threads):
            thread.join(timeout=timeout)
            self._threads.discard(thread)

    async def swap_model(self, model_path: Path) -> None:
        await self.stop()
        self.model_path = Path(model_path)
        self.device_fallback = None
        await self.start()

    # ── Health ─────────────────────────────────────────────────────────

    async def health(self) -> Optional[dict]:
        if self._pipe is None:
            return None
        info = {
            "status": "ok",
            "backend": "openvino",
            "device": OV_DEVICE_NAMES.get(self.device, self.device),
            "precision": self.precision.describe() if self.precision else "unknown",
            "cache_dir": str(self._cache_dir) if self._cache_dir else None,
            "greedy_only": self._greedy_only,
        }
        if self.device_fallback:
            info["device_fallback"] = self.device_fallback
        return info

    # ── Inference ──────────────────────────────────────────────────────

    def _generation_config(
        self,
        *,
        max_tokens: int,
        temperature: float,
        top_p: float,
        top_k: int,
        repetition_penalty: float,
        enable_thinking: bool = True,
    ) -> Any:
        cfg = self._genai.GenerationConfig()
        # MiniCPM5 always opens a <think> block, so thinking=false only
        # *hides* the reasoning — it still spends budget. Without a floor a
        # sampled reply can exhaust the allowance before </think> and leave
        # an empty bubble.
        budget = int(max_tokens)
        if not enable_thinking:
            budget = min(HIDDEN_REASONING_CAP, max(budget, HIDDEN_REASONING_FLOOR))
        cfg.max_new_tokens = budget
        sampling = temperature > 0.0 and not self._greedy_only
        cfg.do_sample = bool(sampling)
        if sampling:
            cfg.temperature = float(temperature)
            cfg.top_p = float(top_p)
            if top_k and top_k > 0:
                cfg.top_k = int(top_k)
            cfg.repetition_penalty = float(repetition_penalty)
        if self._stop_token_ids:
            cfg.stop_token_ids = set(self._stop_token_ids)
        return cfg

    def _render_prompt(self, messages: list[dict], *, enable_thinking: bool) -> str:
        """Render the chat prompt.

        Note the asymmetry: `enable_thinking=True` is passed through, but
        `False` is expressed by *omitting* the kwarg rather than sending
        `{"enable_thinking": False}`.

        Sending False makes the template emit a pre-closed empty block
        (`<think>\\n\\n</think>\\n\\n`). MiniCPM5 opens a fresh <think> after
        it anyway — and that malformed double block sends it rambling.
        Measured on this checkpoint, 3 sampled runs each:

            omit the kwarg   110-119 chars of reasoning,  5.9-9.1 s
            enable_thinking=False   571-871 chars,       24.9-40.4 s

        Same hidden reasoning either way, 5x the cost. So "don't think" is
        implemented as "say nothing about thinking, then drop whatever
        reasoning shows up" — which is exactly what ThinkBlockFilter with
        expose=False does downstream.
        """
        if self._supports_extra_context and enable_thinking:
            return self._tokenizer.apply_chat_template(
                messages,
                add_generation_prompt=True,
                extra_context={"enable_thinking": True},
            )
        # The template guards on `{%- if enable_thinking is defined %}`, so
        # an undefined kwarg emits no marker at all.
        return self._tokenizer.apply_chat_template(messages, add_generation_prompt=True)

    async def stream_chat(
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
    ) -> AsyncIterator[tuple[str, str]]:
        pipe = self._pipe
        if pipe is None:
            raise RuntimeError("OpenVINO pipeline not loaded; call start() first")

        genai = self._genai
        run_status, stop_status = _streaming_status(genai)

        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue()
        cancelled = threading.Event()

        prompt = self._render_prompt(messages, enable_thinking=enable_thinking)
        config = self._generation_config(
            max_tokens=max_tokens,
            temperature=temperature,
            top_p=top_p,
            top_k=top_k,
            repetition_penalty=repetition_penalty,
            enable_thinking=enable_thinking,
        )

        def _streamer(subword: str):
            # call_soon_threadsafe, not a blocking queue read on an executor
            # thread: no parked pool slot, and the consumer stays cancellable.
            loop.call_soon_threadsafe(queue.put_nowait, ("content", subword))
            if cancelled.is_set() or self._stop_all.is_set():
                return stop_status
            return run_status

        def _worker():
            try:
                pipe.generate(prompt, config, streamer=_streamer)
            except BaseException as exc:  # surfaced to the consumer below
                loop.call_soon_threadsafe(queue.put_nowait, exc)
            finally:
                loop.call_soon_threadsafe(queue.put_nowait, _SENTINEL)

        # Decide from the stream rather than assuming: the model emits its
        # own <think>, so injecting unconditionally doubles it — but never
        # injecting would leak the chain of thought if that ever changes.
        lead = "" if enable_thinking else None

        async with self._gen_lock:
            worker = threading.Thread(target=_worker, name="ov-generate", daemon=True)
            self._threads.add(worker)
            worker.start()
            try:
                while True:
                    item = await queue.get()
                    if item is _SENTINEL:
                        if lead:  # stream ended mid-decision
                            yield ("content", _ensure_open_tag(lead))
                        break
                    if isinstance(item, BaseException):
                        raise item
                    if lead is not None:
                        lead += item[1]
                        if len(lead) < len(_OPEN_TAG) and _OPEN_TAG.startswith(lead):
                            continue  # still ambiguous — keep looking
                        yield ("content", _ensure_open_tag(lead))
                        lead = None
                        continue
                    yield item
            finally:
                # Client hung up: stop rather than burning battery on tokens
                # nobody will read.
                cancelled.set()
                await asyncio.to_thread(worker.join, 10.0)
                self._threads.discard(worker)

    async def complete_once(
        self, *, prompt: str, max_tokens: int = 1, temperature: float = 0.0
    ) -> dict:
        """One-token generate, for /api/warmup.

        Worth more here than on llama.cpp: it forces the first kernel JIT
        off the user's first real message.
        """
        pipe = self._pipe
        if pipe is None:
            raise RuntimeError("OpenVINO pipeline not loaded; call start() first")

        cfg = self._genai.GenerationConfig()
        cfg.max_new_tokens = int(max_tokens)
        cfg.do_sample = False

        started = time.monotonic()
        async with self._gen_lock:
            result = await asyncio.to_thread(pipe.generate, prompt, cfg)
        text = getattr(result, "texts", None)
        return {
            "content": text[0] if text else str(result),
            "backend": "openvino",
            "device": OV_DEVICE_NAMES.get(self.device, self.device),
            "elapsed_ms": round((time.monotonic() - started) * 1000, 2),
        }


# ── Small helpers ───────────────────────────────────────────────────────────


def _streaming_status(genai: Any) -> tuple[Any, Any]:
    """openvino_genai switched its streamer callback from bool to an enum;
    support both so we are not pinned to one patch release."""
    status = getattr(genai, "StreamingStatus", None)
    if status is not None:
        try:
            return status.RUNNING, status.STOP
        except AttributeError:
            pass
    return False, True


def _env_flag(name: str, *, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() not in ("0", "false", "no", "off")


def _env_int(name: str, *, default: int) -> int:
    try:
        return int(os.environ[name])
    except (KeyError, ValueError):
        return default
