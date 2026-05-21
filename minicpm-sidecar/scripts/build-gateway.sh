#!/usr/bin/env bash
# Build the gateway into a single-file PyInstaller binary.
#
# Output:
#   ../bin/<os>-<arch>/minicpm-sidecar[.exe]

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

cyan()  { printf "\033[36m%s\033[0m\n" "$*"; }
red()   { printf "\033[31m%s\033[0m\n" "$*" >&2; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }

# Triple names match electron-builder's `${os}-${arch}` expansion.
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  TARGET="mac-arm64";   EXE="" ;;
  Darwin-x86_64) TARGET="mac-x64";     EXE="" ;;
  Linux-x86_64)  TARGET="linux-x64";   EXE="" ;;
  Linux-aarch64) TARGET="linux-arm64"; EXE="" ;;
  *)
    red "不支持的 host: $(uname -s) $(uname -m)。Windows 用 PyInstaller GUI 或在 WSL 内跑。"
    exit 1
    ;;
esac

cyan "==> Gateway target: $TARGET"

if [[ ! -d "$ROOT/.venv" ]]; then
  if ! command -v uv >/dev/null 2>&1; then
    red "uv 未安装。先 curl -LsSf https://astral.sh/uv/install.sh | sh"
    exit 1
  fi
  cyan "==> uv sync (首次安装 gateway 依赖)..."
  ( cd "$ROOT" && uv sync )
fi

if [[ ! -x "$ROOT/.venv/bin/pyinstaller" ]]; then
  cyan "==> 安装 PyInstaller..."
  ( cd "$ROOT" && uv pip install "pyinstaller>=6.0" )
fi

cyan "==> 清理上次产物..."
rm -rf "$ROOT/build/build" "$ROOT/build/dist"

cyan "==> 运行 PyInstaller..."
( cd "$ROOT/build" && "$ROOT/.venv/bin/pyinstaller" \
    gateway.spec \
    --distpath "$ROOT/build/dist" \
    --workpath "$ROOT/build/build" \
    --clean \
    --noconfirm )

OUT="$ROOT/bin/$TARGET"
mkdir -p "$OUT"
SRC_BIN="$ROOT/build/dist/minicpm-sidecar${EXE}"
if [[ ! -f "$SRC_BIN" ]]; then
  red "PyInstaller 没找到产物：$SRC_BIN"
  exit 1
fi
cp -f "$SRC_BIN" "$OUT/"

green "==> OK -> $OUT/minicpm-sidecar${EXE}"
green "    试跑: $OUT/minicpm-sidecar${EXE} --help"
