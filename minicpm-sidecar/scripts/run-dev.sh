#!/usr/bin/env bash
# Launch the gateway in dev mode.
#
# Prerequisites:
#   uv sync            # populates .venv/ (includes the OpenVINO runtime)
#
# Usage:
#   ./scripts/run-dev.sh --model /path/to/openvino-ir-dir [--port 18765]

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

cd "$ROOT"

if [[ ! -d ".venv" ]]; then
  echo "==> .venv 不存在，先跑 uv sync ..."
  if ! command -v uv >/dev/null 2>&1; then
    echo "uv 未安装。请先 curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
    exit 1
  fi
  uv sync
fi

exec ./.venv/bin/python -m gateway "$@"
