#!/usr/bin/env bash
# Clone (or refresh) the vendored llama.cpp checkout into third_party/.
#
# We pin to a specific commit on zhangtao2-1's fork because the official
# ggml-org/llama.cpp has not yet merged MiniCPM5 tokenizer support
# (see https://github.com/ggml-org/llama.cpp/pull/23384). Once upstream
# merges, switch REMOTE and REF to the official tag.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
DST="$ROOT/third_party/llama.cpp"

# ── Vendor pin ───────────────────────────────────────────────────────────────
# Override via env when the upstream is ready:
#   LLAMA_REMOTE=https://github.com/ggml-org/llama.cpp.git \
#   LLAMA_REF=v...                                          \
#   ./clone-llama.sh
REMOTE="${LLAMA_REMOTE:-https://github.com/zhangtao2-1/llama.cpp.git}"
REF="${LLAMA_REF:-c5ede29}"   # MiniCPM5 tokenizer commit from PR #23384

cyan()  { printf "\033[36m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
red()   { printf "\033[31m%s\033[0m\n" "$*" >&2; }

mkdir -p "$ROOT/third_party"

if [[ -d "$DST/.git" ]]; then
  cyan "==> 已存在 $DST，更新到 $REF"
  git -C "$DST" remote set-url origin "$REMOTE"
  git -C "$DST" fetch --depth 1 origin "$REF" || git -C "$DST" fetch origin
  git -C "$DST" checkout --detach "$REF"
else
  cyan "==> 克隆 $REMOTE @ $REF -> $DST"
  # Shallow clone is enough; we only need a buildable tree.
  git clone --depth 1 "$REMOTE" "$DST" || {
    # Some refs aren't reachable from default branch with --depth 1.
    # Fall back to a full clone in that case.
    rm -rf "$DST"
    git clone "$REMOTE" "$DST"
  }
  ( cd "$DST" && git fetch origin "$REF" 2>/dev/null || true )
  git -C "$DST" checkout --detach "$REF" || {
    red "checkout $REF 失败。请确认 REMOTE/REF 是否存在。"
    exit 1
  }
fi

green "==> llama.cpp 已就绪：$(git -C "$DST" rev-parse --short HEAD)"
