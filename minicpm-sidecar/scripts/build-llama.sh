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
REPO_ROOT="$(cd "$ROOT/.." && pwd)"
SRC="$REPO_ROOT/llama.cpp"
BUILD="$SRC/build"

cyan()  { printf "\033[36m%s\033[0m\n" "$*"; }
red()   { printf "\033[31m%s\033[0m\n" "$*" >&2; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }

if [[ ! -e "$SRC/.git" ]]; then
  red "$SRC 不存在。请先初始化 submodule：git submodule update --init llama.cpp"
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
    ACCEL="${LLAMA_ACCEL:-vulkan}"
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
  # cpp-httplib (vendored in llama.cpp) auto-links OpenSSL when
  # find_package(OpenSSL) succeeds, producing a binary that depends on
  # libcrypto/libssl. We don't need HTTPS for the 127.0.0.1-only sidecar.
  #
  # Failure modes if this flag is missing:
  #   - Windows: vcpkg's libcrypto-3-x64.dll isn't bundled into bin/win-x64/,
  #     so the user gets STATUS_DLL_NOT_FOUND at first launch.
  #   - macOS: Homebrew's openssl@3 dylib gets embedded by absolute path
  #     (`/opt/homebrew/opt/openssl@3/lib/lib{ssl,crypto}.3.dylib`). End
  #     users without Homebrew (or on Intel Mac, or with openssl at a
  #     different prefix) hit dyld "Library not loaded" and the sidecar
  #     reports "Llama Server is not running".
  # Hard-disable discovery for parity across platforms.
  -DCMAKE_DISABLE_FIND_PACKAGE_OpenSSL=ON
)

case "$ACCEL" in
  metal)
    CMAKE_FLAGS+=( -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON )
    ;;
  vulkan)
    CMAKE_FLAGS+=( -DGGML_VULKAN=ON )
    ;;
  cuda)
    CMAKE_FLAGS+=( -DGGML_CUDA=ON )
    ;;
  cpu)
    CMAKE_FLAGS+=( -DGGML_METAL=OFF -DGGML_CUDA=OFF -DGGML_VULKAN=OFF )
    ;;
  *)
    red "未知 LLAMA_ACCEL=$ACCEL（应为 metal/vulkan/cuda/cpu）"
    exit 1
    ;;
esac

# Vulkan 后端需要 SPIRV-Headers 的 CMake config。LunarG SDK 把它放在
# $VULKAN_SDK/share/cmake/ 或子目录下；显式加进 CMAKE_PREFIX_PATH 兜底。
if [[ "$ACCEL" == "vulkan" && -n "${VULKAN_SDK:-}" ]]; then
  cyan "==> Using VULKAN_SDK: $VULKAN_SDK"
  CMAKE_FLAGS+=( "-DCMAKE_PREFIX_PATH=$VULKAN_SDK" )
fi

cyan "==> Target: $TARGET   Accel: $ACCEL"
cyan "==> Source: $SRC"

if ! command -v cmake >/dev/null 2>&1; then
  red "找不到 cmake。请先安装：brew install cmake / apt install cmake"
  exit 1
fi

mkdir -p "$BUILD"
# Drop any stale CMake cache so flag toggles (e.g. -DCMAKE_DISABLE_FIND_PACKAGE_OpenSSL)
# definitely take effect. Without this, a previously-configured tree that
# found OpenSSL keeps the libssl/libcrypto link edges forever and the
# resulting binary still hardcodes /opt/homebrew/opt/openssl@3/... .
if [[ -f "$BUILD/CMakeCache.txt" ]]; then
  cyan "==> 清理 CMake 缓存（确保 OpenSSL 等可选包关闭生效）"
  rm -f "$BUILD/CMakeCache.txt"
  rm -rf "$BUILD/CMakeFiles"
fi
cyan "==> cmake configure"
cmake -S "$SRC" -B "$BUILD" "${CMAKE_FLAGS[@]}"

JOBS="${LLAMA_JOBS:-$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)}"
if [[ -n "${CI:-}" && "$JOBS" -gt 4 ]]; then
  JOBS=4
fi
cyan "==> cmake build llama-server (-j$JOBS)"
cmake --build "$BUILD" --target llama-server --config Release -j"$JOBS"

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

# ── Anti-regression: verify the binary has no absolute-path Homebrew /
#    vcpkg deps that won't exist on the user's machine. The recurring
#    failure mode is cpp-httplib sneaking OpenSSL back in, producing a
#    binary that depends on /opt/homebrew/opt/openssl@3/lib/lib{ssl,crypto}.3.dylib
#    and crashing at first launch on any user without that exact prefix.
cyan "==> 校验 llama-server 动态链接（防 OpenSSL / Homebrew 绝对路径回归）"
case "$(uname -s)" in
  Darwin)
    if ! command -v otool >/dev/null 2>&1; then
      red "缺少 otool，无法校验链接。请安装 Xcode Command Line Tools。"
      exit 1
    fi
    DEPS="$(otool -L "$OUT/llama-server" | tail -n +2 || true)"
    BAD="$(printf '%s\n' "$DEPS" | grep -Ei '/(opt/homebrew|usr/local/opt|usr/local/Cellar|opt/local)/' || true)"
    if [[ -n "$BAD" ]]; then
      red "==> 构建产物仍然依赖宿主机 Homebrew/MacPorts 路径，用户机器上会启动失败："
      printf '%s\n' "$BAD" >&2
      red "请确认 -DCMAKE_DISABLE_FIND_PACKAGE_OpenSSL=ON 等关闭可选包的 flag 已生效，"
      red "并删除 $BUILD 重新干净构建。"
      exit 1
    fi
    SSL_BAD="$(printf '%s\n' "$DEPS" | grep -Ei 'libssl|libcrypto|openssl' || true)"
    if [[ -n "$SSL_BAD" ]]; then
      red "==> 构建产物仍然链接了 OpenSSL，用户机器上大概率缺库："
      printf '%s\n' "$SSL_BAD" >&2
      exit 1
    fi
    ;;
  Linux)
    if command -v ldd >/dev/null 2>&1; then
      SSL_BAD="$(ldd "$OUT/llama-server" 2>/dev/null | grep -Ei 'libssl|libcrypto' || true)"
      if [[ -n "$SSL_BAD" ]]; then
        red "==> 构建产物仍然链接了 OpenSSL："
        printf '%s\n' "$SSL_BAD" >&2
        exit 1
      fi
    fi
    ;;
esac

green "==> OK -> $OUT/$(basename "$SERVER")"
green "    试跑: $OUT/llama-server --version"
