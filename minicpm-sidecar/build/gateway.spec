# PyInstaller spec for the gateway.
#
# Build:
#   ../scripts/build-gateway.sh
#
# Produces:
#   <repo>/minicpm-sidecar/bin/<os>-<arch>/minicpm-sidecar/
#
# No torch, no transformers, no peft — but the OpenVINO runtime IS bundled,
# because it is the only inference engine this build has. That puts the
# output around 300 MB.

# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_all, collect_submodules
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
]
# collect_all, NOT collect_submodules: the device plugins (intel_gpu_plugin,
# intel_npu_plugin) are native DLLs loaded at runtime by name, so walking
# Python modules alone yields a binary that reports no GPU/NPU on hardware
# that has both.
ov_datas, ov_binaries, ov_hidden = [], [], []
for _pkg in ("openvino", "openvino_genai", "openvino_tokenizers"):
    _d, _b, _h = collect_all(_pkg)
    ov_datas += _d
    ov_binaries += _b
    ov_hidden += _h
hidden += ov_hidden

a = Analysis(
    [str(PKG / "__main__.py")],
    pathex=[str(ROOT)],
    binaries=ov_binaries,
    datas=ov_datas,
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
        # Conversion-time only — convert-openvino.py shells out for these.
        "nncf",
        "optimum",
        "onnx",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
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
)

# onedir, not onefile: onefile would unpack ~300 MB to a temp directory on
# every launch (measured ~14 s) and the pet spawns this on app start.
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="minicpm-sidecar",
)
