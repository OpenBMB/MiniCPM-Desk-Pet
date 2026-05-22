"""Cross-platform log directory + rotating file handler setup.

The Electron host mirrors our stdout/stderr to <userData>/logs/sidecar.log,
but that is "what the parent saw" and gets truncated under broken-pipe
conditions. We open a *second* logger on disk inside the sidecar so the
full traceback for any internal exception always survives.

Log dir resolution (first hit wins):
  1. $MINICPM_LOG_DIR   (Electron sets this in packaged mode)
  2. macOS  → ~/Library/Logs/MiniCPM Desk Pet/sidecar/
  3. Linux  → $XDG_STATE_HOME/minicpm-sidecar/ or ~/.local/state/minicpm-sidecar/
  4. Win    → %LOCALAPPDATA%\\MiniCPM Desk Pet\\logs\\
  5. <gateway pkg dir>/.logs/  (dev fallback)
"""

from __future__ import annotations

import logging
import logging.handlers
import os
import platform
import sys
from pathlib import Path
from typing import Optional

_LOGGER_NAME = "minicpm.gateway"
_logger_initialized = False


def resolve_log_dir() -> Path:
    env = os.environ.get("MINICPM_LOG_DIR")
    if env:
        return Path(env).expanduser().resolve()
    system = platform.system()
    if system == "Darwin":
        return Path.home() / "Library" / "Logs" / "MiniCPM Desk Pet" / "sidecar"
    if system == "Linux":
        xdg = os.environ.get("XDG_STATE_HOME")
        base = Path(xdg).expanduser() if xdg else Path.home() / ".local" / "state"
        return base / "minicpm-sidecar"
    if system == "Windows":
        appdata = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA")
        if appdata:
            return Path(appdata) / "MiniCPM Desk Pet" / "logs"
    return Path(__file__).resolve().parent.parent / ".logs"


def init_logging(level: int = logging.INFO) -> logging.Logger:
    """Configure the gateway logger once. Subsequent calls return the same logger."""
    global _logger_initialized
    log = logging.getLogger(_LOGGER_NAME)
    if _logger_initialized:
        return log
    log.setLevel(level)
    log.propagate = False

    fmt = logging.Formatter(
        "%(asctime)s %(levelname)s [%(name)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    stream = logging.StreamHandler(sys.stderr)
    stream.setFormatter(fmt)
    log.addHandler(stream)

    try:
        log_dir = resolve_log_dir()
        log_dir.mkdir(parents=True, exist_ok=True)
        path = log_dir / "sidecar-internal.log"
        fh = logging.handlers.RotatingFileHandler(
            path, maxBytes=2 * 1024 * 1024, backupCount=2, encoding="utf-8"
        )
        fh.setFormatter(fmt)
        log.addHandler(fh)
        log.info("file logger -> %s", path)
    except Exception as exc:  # pragma: no cover - degraded but still usable
        log.warning("file logger init failed: %s", exc)

    _logger_initialized = True
    return log


def get_logger() -> logging.Logger:
    return logging.getLogger(_LOGGER_NAME) if _logger_initialized else init_logging()


def install_broken_pipe_guard() -> None:
    """Swap stdout for /dev/null on BrokenPipeError so a dead parent can't kill us."""

    real_print = print

    def safe_print(*args, **kwargs) -> None:
        try:
            real_print(*args, **kwargs)
        except (BrokenPipeError, OSError):
            try:
                sys.stdout = open(os.devnull, "w")
                sys.stderr = open(os.devnull, "w")
            except Exception:
                pass

    import builtins

    builtins.print = safe_print  # type: ignore[assignment]
