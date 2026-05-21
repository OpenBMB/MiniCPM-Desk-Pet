# PyInstaller spec for the MiniCPM sidecar.
#
# Build:
#   ./build/build-sidecar.sh
#
# Produces a self-contained directory at
#   clawd-on-desk/dist/sidecar/<os>-<arch>/minicpm-sidecar/
#
# that electron-builder picks up via extraResources and ships inside
# the dmg / nsis / AppImage so the end user never needs a Python
# interpreter installed.
#
# trust_remote_code=True paths in transformers can cause PyInstaller to
# miss modules that are imported lazily by the model's modeling_*.py;
# we surface them via collect_submodules and a few explicit hidden
# imports.

# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_submodules, collect_data_files
from pathlib import Path

HERE = Path(SPECPATH).resolve()
BRIDGE = (HERE.parent / "minicpm-pet-bridge-uv").resolve()

hidden = []
hidden += collect_submodules("transformers.models")
hidden += collect_submodules("transformers.generation")
hidden += collect_submodules("peft.tuners")
hidden += collect_submodules("accelerate.utils")
# These tend to be pulled lazily through trust_remote_code.
hidden += [
    "sentencepiece",
    "tokenizers",
    "safetensors",
    "huggingface_hub",
    "httpx",
    "uvicorn",
    "uvicorn.logging",
    "uvicorn.loops.auto",
    "uvicorn.protocols",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.websockets.auto",
    "fastapi",
    "pydantic",
]

datas = []
datas += collect_data_files("transformers", include_py_files=False)
datas += collect_data_files("tokenizers")
datas += collect_data_files("sentencepiece", include_py_files=False)
# Bundle our helper modules next to server.py so PyInstaller's analyzer
# can resolve them even without an installable package.
datas += [
    (str(BRIDGE / "clawd_state.py"), "."),
    (str(BRIDGE / "updater.py"), "."),
]
# Ship the optional browser test page so /static keeps working when
# someone curls the sidecar directly. server.py treats this as optional
# and falls back to a JSON description if the dir is missing.
_static = BRIDGE / "static"
if _static.is_dir():
    datas += [(str(_static / "index.html"), "static")]

a = Analysis(
    [str(BRIDGE / "server.py")],
    pathex=[str(BRIDGE)],
    binaries=[],
    datas=datas,
    hiddenimports=hidden,
    hookspath=[],
    runtime_hooks=[],
    # Strip heavy modules we never use to keep the bundle as lean as
    # possible. torch / transformers / peft itself is the dominant cost
    # and not safe to exclude.
    excludes=[
        "matplotlib",
        "scipy.misc",
        "tkinter",
        "PyQt5",
        "PyQt6",
        "PySide2",
        "PySide6",
        "PIL.ImageTk",
        "IPython",
        "notebook",
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

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="minicpm-sidecar",
)
