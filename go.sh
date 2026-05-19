#!/usr/bin/env bash
# go.sh — 一键安装 + 启动 MiniCPM 桌宠 (uv 版本)
#
# 第一次跑：检查依赖、装 uv (如缺)、uv sync、npm install、启动桌宠
# 之后再跑：所有 sync/install 都是 idempotent 的,瞬间跳过,直接启动
#
# Usage:
#   ./go.sh           # 安装 + 启动 (前台)
#   ./go.sh setup     # 只装依赖,不启动
#   ./go.sh start     # 跳过依赖检查直接启动
#   ./go.sh doctor    # 检查环境但什么都不做

set -e
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_DIR="$HERE/minicpm-pet-bridge-uv"
APP_DIR="$HERE/clawd-on-desk"
MODEL_DIR="$HERE/models/minicpm5-0.9b"

cyan() { printf "\033[36m%s\033[0m\n" "$*"; }
red()  { printf "\033[31m%s\033[0m\n" "$*" >&2; }
green(){ printf "\033[32m%s\033[0m\n" "$*"; }
yellow(){ printf "\033[33m%s\033[0m\n" "$*"; }

# fnm-installed node lives outside /usr/local on most setups, so make
# sure we can see it on every script run (idempotent no-op if missing).
load_fnm_env() {
  local fnm_dir="${FNM_DIR:-$HOME/.local/share/fnm}"
  if [[ -x "$fnm_dir/fnm" ]]; then
    export PATH="$fnm_dir:$PATH"
    eval "$("$fnm_dir/fnm" env --shell bash 2>/dev/null)" || true
  fi
}

# Auto-install Node 18+ when missing or too old.
# Strategy:
#   1. Try Homebrew (fastest, standard on macOS dev machines)
#   2. Fall back to fnm — single static binary, no sudo, no shell rc edits
ensure_node() {
  load_fnm_env

  if command -v node >/dev/null 2>&1; then
    local ver
    ver=$(node -v | sed 's/^v\([0-9]*\).*/\1/')
    if [[ -n "$ver" && "$ver" -ge 18 ]]; then
      green "    ✓ Node $(node -v)"
      return 0
    fi
    yellow "    Node 版本 $(node -v) < 18,需要升级"
  else
    yellow "    Node 未安装,自动装一个..."
  fi

  # Path A: Homebrew if present (clean, system-wide)
  if command -v brew >/dev/null 2>&1; then
    cyan "    使用 Homebrew 安装 Node 22 (LTS)..."
    if brew install node@22; then
      brew link --overwrite --force node@22 || true
      if command -v node >/dev/null 2>&1; then
        green "    ✓ Node $(node -v) (brew)"
        return 0
      fi
    fi
    yellow "    Homebrew 安装失败,改用 fnm..."
  fi

  # Path B: fnm (no sudo, no brew needed, no shell rc pollution)
  if ! command -v fnm >/dev/null 2>&1; then
    cyan "    安装 fnm (Node 版本管理器,无 sudo)..."
    curl -fsSL https://fnm.vercel.app/install | bash -s -- --skip-shell
  fi
  load_fnm_env
  if ! command -v fnm >/dev/null 2>&1; then
    red "fnm 自动安装失败。请手动安装 Node 18+: https://nodejs.org/"
    exit 1
  fi

  cyan "    fnm install 22 (这会下载 ~30MB 的 Node 22)..."
  fnm install 22
  fnm use 22
  fnm default 22 || true
  load_fnm_env  # re-eval so PATH includes the new node version

  if ! command -v node >/dev/null 2>&1; then
    red "Node 安装后仍找不到。检查 ~/.local/share/fnm/ 或重启终端再试。"
    exit 1
  fi
  green "    ✓ Node $(node -v) (fnm)"
}

check_environment() {
  cyan "==> 检查环境..."

  # 1. macOS check
  if [[ "$(uname)" != "Darwin" ]]; then
    yellow "    目前只在 macOS (Apple Silicon) 上验证过,其它平台请自行确认。"
  else
    green "    ✓ macOS"
  fi

  # 2. Node.js (auto-install if missing)
  ensure_node

  # 3. uv (auto-install if missing)
  if ! command -v uv >/dev/null 2>&1; then
    # 检查 ~/.local/bin (uv 默认安装位置,可能没在 PATH)
    if [[ -x "$HOME/.local/bin/uv" ]]; then
      export PATH="$HOME/.local/bin:$PATH"
      green "    ✓ uv $(uv --version) (~/.local/bin)"
    else
      yellow "    uv 未安装,正在自动安装..."
      curl -LsSf https://astral.sh/uv/install.sh | sh
      export PATH="$HOME/.local/bin:$PATH"
      if ! command -v uv >/dev/null 2>&1; then
        red "uv 自动安装失败。请手动安装: curl -LsSf https://astral.sh/uv/install.sh | sh"
        exit 1
      fi
      green "    ✓ uv $(uv --version) (新装)"
    fi
  else
    green "    ✓ uv $(uv --version)"
  fi

  # 4. Bridge dir (uv version)
  if [[ ! -f "$BRIDGE_DIR/pyproject.toml" ]]; then
    red "找不到 $BRIDGE_DIR/pyproject.toml,你是不是没解压完整?"
    exit 1
  fi
  green "    ✓ minicpm-pet-bridge-uv/"

  # 5. App dir
  if [[ ! -f "$APP_DIR/package.json" ]]; then
    red "找不到 $APP_DIR/package.json"
    exit 1
  fi
  green "    ✓ clawd-on-desk/"

  # 6. Model
  if [[ ! -f "$MODEL_DIR/config.json" ]]; then
    red ""
    red "找不到 base 模型: $MODEL_DIR/config.json"
    red ""
    red "解决方法 (任选其一):"
    red "  1. 从老 v0.1 安装目录拷贝整个 models/minicpm5-0.9b/ 过来"
    red "  2. 从 Hugging Face 下载:"
    red "       cd $HERE && \\"
    red "       hf download openbmb/MiniCPM5-0.9B --local-dir models/minicpm5-0.9b"
    red ""
    exit 1
  fi
  green "    ✓ models/minicpm5-0.9b/"
}

install_python_deps() {
  cyan "==> Python 依赖 (uv sync)..."
  if [[ -d "$BRIDGE_DIR/.venv" && -f "$BRIDGE_DIR/.venv/bin/python" ]]; then
    # uv sync 是 idempotent 的,但跳过这一步能省 ~1s 启动开销
    green "    ✓ .venv 已存在,跳过 sync (跑 ./go.sh setup --force-sync 强制重装)"
  else
    cyan "    首次安装,这要 ~1-3 分钟 (下载 torch + transformers)..."
    ( cd "$BRIDGE_DIR" && uv sync )
    green "    ✓ Python deps installed"
  fi
}

install_npm_deps() {
  cyan "==> Electron 依赖 (npm install)..."
  if [[ -d "$APP_DIR/node_modules" ]]; then
    green "    ✓ node_modules 已存在,跳过"
  else
    ( cd "$APP_DIR" && npm install --no-audit --no-fund )
    green "    ✓ npm deps installed"
  fi
}

start_pet() {
  cyan "==> 启动桌宠..."
  # Make sure node + npm are on PATH (fnm-installed node needs explicit
  # env injection per shell). No-op if node was installed via brew.
  load_fnm_env
  if ! command -v node >/dev/null 2>&1; then
    red "Node 不在 PATH 中。先跑一次 ./go.sh setup,或重启终端。"
    exit 1
  fi
  export MINICPM_BRIDGE_DIR="$BRIDGE_DIR"
  export MINICPM_PYTHON="$BRIDGE_DIR/.venv/bin/python"
  # macOS 26 + torch 2.6: the MPS metal kernel for fused SDPA SIGABRTs on
  # MiniCPM's GQA broadcast matmul (16h Q × 2h KV). Force the eager
  # attention path to keep warmup / inference stable. Respect any value
  # the user already set (they may want to test other impls).
  : "${MINICPM_ATTN_IMPL:=eager}"
  export MINICPM_ATTN_IMPL
  green "    MINICPM_BRIDGE_DIR=$MINICPM_BRIDGE_DIR"
  green "    MINICPM_PYTHON=$MINICPM_PYTHON"
  green "    MINICPM_ATTN_IMPL=$MINICPM_ATTN_IMPL"
  echo
  green "桌宠启动中... 关闭终端 (Ctrl+C) 即停止。"
  cd "$APP_DIR" && exec npm start
}

cmd="${1:-run}"
case "$cmd" in
  doctor)
    check_environment
    green ""
    green "✅ 环境就绪,可直接 ./go.sh 启动。"
    ;;
  setup)
    check_environment
    install_python_deps
    install_npm_deps
    green ""
    green "✅ 安装完成。下一步: ./go.sh start"
    ;;
  start)
    start_pet
    ;;
  run|"")
    check_environment
    install_python_deps
    install_npm_deps
    start_pet
    ;;
  *)
    red "未知命令: $cmd"
    red "用法: ./go.sh [doctor|setup|start|run]"
    exit 1
    ;;
esac
