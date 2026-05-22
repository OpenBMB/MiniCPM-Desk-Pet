"""CLI entry point for the gateway.

Invoked one of three ways:
  · python -m gateway --port 18765 --model /path/to/x.gguf
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
from gateway.log_setup import init_logging, install_broken_pipe_guard
from gateway.server import build_app
from gateway.updater import DEFAULT_SOURCE


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="minicpm-sidecar", add_help=True)
    p.add_argument("--host", default=os.environ.get("MINICPM_HOST", "127.0.0.1"))
    p.add_argument("--port", type=int, default=int(os.environ.get("MINICPM_PORT", "18765")))
    p.add_argument(
        "--model",
        default=os.environ.get("MINICPM_MODEL_DIR") or os.environ.get("MINICPM_MODEL", ""),
        help=".gguf file to load (or directory containing exactly one)",
    )
    p.add_argument(
        "--update-source",
        default=os.environ.get("MINICPM_UPDATE_SOURCE", DEFAULT_SOURCE),
    )
    p.add_argument("--ctx-size", type=int, default=int(os.environ.get("MINICPM_CTX", "4096")))
    p.add_argument("--gpu-layers", type=int, default=int(os.environ.get("MINICPM_GPU_LAYERS", "-1")))
    p.add_argument(
        "--threads",
        type=int,
        default=int(os.environ["MINICPM_THREADS"]) if os.environ.get("MINICPM_THREADS") else 0,
    )
    return p.parse_args(argv)


def _resolve_model_arg(raw: str) -> Path | None:
    if not raw:
        return None
    p = Path(raw).expanduser()
    if not p.exists():
        return p  # will be picked up when /api/update-apply finishes
    if p.is_file():
        return p
    if p.is_dir():
        # Pick the first .gguf inside if a directory was provided (matches
        # the legacy behaviour where Electron passed a model *directory*).
        ggufs = sorted(p.rglob("*.gguf"))
        if ggufs:
            return ggufs[0]
        return None
    return None


def main(argv: list[str] | None = None) -> int:
    args = parse_args(list(sys.argv[1:] if argv is None else argv))
    init_logging()
    install_broken_pipe_guard()

    model_path = _resolve_model_arg(args.model)

    app = build_app(
        initial_model=model_path,
        update_source=args.update_source,
        ctx_size=args.ctx_size,
        n_gpu_layers=args.gpu_layers,
        threads=(args.threads or None),
    )

    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        log_level="info",
        # Reload is intentionally off — this is a packaged sidecar, not a
        # web framework, and any uvicorn watcher conflicts with the
        # llama-server subprocess we own.
        reload=False,
        access_log=False,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
