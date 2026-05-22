# PyInstaller spec for the gateway.
#
# Build:
#   ../scripts/build-gateway.sh
#
# Produces:
#   <repo>/minicpm-sidecar/bin/<os>-<arch>/minicpm-sidecar[.exe]
#
# This is intentionally lean: no torch, no transformers, no peft. The
# only Python deps are FastAPI + uvicorn + httpx + huggingface_hub, all
# of which are well-behaved under PyInstaller. Bundle size lands in the
# tens of MB instead of the 700 MB the legacy torch sidecar weighed in at.

# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_submodules
from pathlib import Path

HERE = Path(SPECPATH).resolve()
ROOT = HERE.parent          # minicpm-sidecar/
PKG = ROOT / "gateway"

hidden = []
hidden += collect_submodules("uvicorn")
hidden += collect_submodules("uvicorn.protocols")
hidden += collect_submodules("uvicorn.loops")
hidden += [
    "uvicorn.logging",
    "uvicorn.lifespan.on",
    "fastapi",
    "starlette",
    "starlette.routing",
    "pydantic",
    "pydantic.deprecated.decorator",
    "httpx",
    "httpcore",
    "anyio._backends._asyncio",
    "huggingface_hub",
]

a = Analysis(
    [str(PKG / "__main__.py")],
    pathex=[str(ROOT)],
    binaries=[],
    datas=[],
    hiddenimports=hidden,
    hookspath=[],
    runtime_hooks=[],
    excludes=[
        "matplotlib",
        "scipy",
        "tkinter",
        "PyQt5",
        "PyQt6",
        "PySide2",
        "PySide6",
        "IPython",
        "notebook",
        "torch",
        "transformers",
        "peft",
        "accelerate",
        "sentencepiece",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="minicpm-sidecar",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    # Onefile: easier to drop next to llama-server in resources/sidecar-bin/.
    onefile=True,
)
