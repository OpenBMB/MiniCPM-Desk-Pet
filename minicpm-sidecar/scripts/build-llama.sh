#!/usr/bin/env bash
# Build llama-server for the current host platform.
#
# Output:
#   bin/<os>-<arch>/llama-server[.exe]
#   bin/<os>-<arch>/*.dylib|*.so   (any runtime libs llama-server needs)
#
# Honors:
#   LLAMA_ACCEL = metal | cuda | cpu   (default: auto by platform)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SRC="$ROOT/third_party/llama.cpp"
BUILD="$SRC/build"

cyan()  { printf "\033[36m%s\033[0m\n" "$*"; }
red()   { printf "\033[31m%s\033[0m\n" "$*" >&2; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }

if [[ ! -d "$SRC" ]]; then
  red "$SRC 不存在。先跑 scripts/clone-llama.sh。"
  exit 1
fi

# ── Pick target triple + cmake flags ────────────────────────────────────────
# Triple names match electron-builder's `${os}-${arch}` expansion so the
# packager can drop our bin/<triple>/ straight into extraResources.
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)
    TARGET="mac-arm64"
    ACCEL="${LLAMA_ACCEL:-metal}"
    ;;
  Darwin-x86_64)
    TARGET="mac-x64"
    ACCEL="${LLAMA_ACCEL:-cpu}"
    ;;
  Linux-x86_64)
    TARGET="linux-x64"
    ACCEL="${LLAMA_ACCEL:-cpu}"
    ;;
  Linux-aarch64)
    TARGET="linux-arm64"
    ACCEL="${LLAMA_ACCEL:-cpu}"
    ;;
  *)
    red "不支持的 host: $(uname -s) $(uname -m)。Windows 请用 build-llama.ps1。"
    exit 1
    ;;
esac

CMAKE_FLAGS=(
  -DBUILD_SHARED_LIBS=OFF
  -DLLAMA_BUILD_TESTS=OFF
  -DLLAMA_BUILD_EXAMPLES=OFF
  -DLLAMA_BUILD_TOOLS=ON
  -DLLAMA_CURL=OFF
)

case "$ACCEL" in
  metal)
    CMAKE_FLAGS+=( -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON )
    ;;
  cuda)
    CMAKE_FLAGS+=( -DGGML_CUDA=ON )
    ;;
  cpu)
    CMAKE_FLAGS+=( -DGGML_METAL=OFF -DGGML_CUDA=OFF )
    ;;
  *)
    red "未知 LLAMA_ACCEL=$ACCEL（应为 metal/cuda/cpu）"
    exit 1
    ;;
esac

cyan "==> Target: $TARGET   Accel: $ACCEL"
cyan "==> Source: $SRC"

if ! command -v cmake >/dev/null 2>&1; then
  red "找不到 cmake。请先安装：brew install cmake / apt install cmake"
  exit 1
fi

mkdir -p "$BUILD"
cyan "==> cmake configure"
cmake -S "$SRC" -B "$BUILD" "${CMAKE_FLAGS[@]}"

cyan "==> cmake build llama-server"
cmake --build "$BUILD" --target llama-server --config Release -j

# llama.cpp puts the binary somewhere predictable; try both layouts.
SERVER=""
for cand in \
  "$BUILD/bin/llama-server" \
  "$BUILD/tools/server/llama-server" \
  "$BUILD/llama-server" \
; do
  [[ -x "$cand" ]] && SERVER="$cand" && break
done

if [[ -z "$SERVER" ]]; then
  red "构建似乎成功但没找到 llama-server。请检查 $BUILD/bin"
  exit 1
fi

OUT="$ROOT/bin/$TARGET"
mkdir -p "$OUT"
cp -f "$SERVER" "$OUT/"
# Also copy any sibling .dylib/.so that the static-with-shared-lib build
# might emit (Metal kernels can land as a separate .metallib).
for ext in dylib so metallib; do
  find "$BUILD" -maxdepth 3 -name "*.$ext" -exec cp -f {} "$OUT/" \; 2>/dev/null || true
done

green "==> OK -> $OUT/$(basename "$SERVER")"
green "    试跑: $OUT/llama-server --version"
