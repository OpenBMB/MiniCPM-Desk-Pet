"""CLI entry point for the gateway.

Invoked one of three ways:
  · python -m gateway --port 18765 --model /path/to/openvino-ir-dir
  · ./minicpm-sidecar --port 18765 --model ...      (PyInstaller binary)
  · uvicorn gateway.server:build_app  --factory     (not used; we drive
    uvicorn programmatically so the CLI matches the legacy bridge flags
    the Electron host already passes through.)
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import uvicorn

# Absolute imports so this module works both as `python -m gateway`
# (where __package__ is set) AND as the PyInstaller entry script
# (where __package__ is empty and relative imports raise).
from gateway.lifecycle import ParentWatchdog, hard_exit
from gateway.log_setup import init_logging, install_broken_pipe_guard
from gateway.server import build_app


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="minicpm-sidecar", add_help=True)
    p.add_argument("--host", default=os.environ.get("MINICPM_HOST", "127.0.0.1"))
    p.add_argument("--port", type=int, default=int(os.environ.get("MINICPM_PORT", "18765")))
    p.add_argument(
        "--model",
        default=os.environ.get("MINICPM_MODEL_DIR") or os.environ.get("MINICPM_MODEL", ""),
        help="OpenVINO IR directory (or a directory containing exactly one)",
    )
    p.add_argument("--ctx-size", type=int, default=int(os.environ.get("MINICPM_CTX", "4096")))
    return p.parse_args(argv)


def _resolve_model_arg(raw: str) -> Path | None:
    """An OpenVINO model is a directory, never a single file."""
    if not raw:
        return None
    p = Path(raw).expanduser()
    if not p.exists():
        return p  # the user may still pick one from onboarding
    if not p.is_dir():
        return None
    if (p / "openvino_model.xml").is_file():
        return p
    found = sorted(p.glob("*/openvino_model.xml"))
    return found[0].parent if found else None


def _resolve_parent_pid() -> int:
    """Pick the pid the watchdog should treat as "our launcher".

    Prefer the explicit env var (`MINICPM_PARENT_PID`) the Electron host
    sets to its own pid when spawning us — that survives the PyInstaller
    bootloader → python re-exec hop, where `os.getppid()` would point at
    the bootloader instead of Electron.

    Falls back to `os.getppid()` for dev runs (`python -m gateway ...`)
    where there's no Electron host setting the env.
    """
    raw = (os.environ.get("MINICPM_PARENT_PID") or "").strip()
    if raw:
        try:
            return int(raw)
        except ValueError:
            pass
    return os.getppid()


def main(argv: list[str] | None = None) -> int:
    args = parse_args(list(sys.argv[1:] if argv is None else argv))
    init_logging()
    install_broken_pipe_guard()

    # Start the parent watchdog before binding any ports. If our launcher
    # (Electron) is already gone by the time we get here, the watchdog
    # fires inline and we exit before claiming :18765 — avoids polluting
    # the next sidecar boot with a half-initialised gateway.
    parent_pid = _resolve_parent_pid()
    ParentWatchdog(parent_pid).start()

    app = build_app(
        initial_model=_resolve_model_arg(args.model),
        ctx_size=args.ctx_size,
    )

    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        log_level="info",
        # Reload is intentionally off — this is a packaged sidecar, not a
        # web framework.
        reload=False,
        access_log=False,
    )
    # Unwinding normally would run DLL_PROCESS_DETACH and deadlock; see
    # lifecycle.hard_exit. Nothing is left to clean up.
    hard_exit(0)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
