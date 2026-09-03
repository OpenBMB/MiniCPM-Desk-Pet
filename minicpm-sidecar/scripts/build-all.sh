#!/usr/bin/env bash
# One-shot build: package the gateway into ../bin/<os>-<arch>/.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"$HERE/build-gateway.sh"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  TARGET="mac-arm64" ;;
  Darwin-x86_64) TARGET="mac-x64" ;;
  Linux-x86_64)  TARGET="linux-x64" ;;
  Linux-aarch64) TARGET="linux-arm64" ;;
  *) TARGET="unknown" ;;
esac

ROOT="$(cd "$HERE/.." && pwd)"
printf "\n\033[32m==> 所有产物位于：%s\033[0m\n" "$ROOT/bin/$TARGET"
ls -la "$ROOT/bin/$TARGET" || true
