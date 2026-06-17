#!/usr/bin/env bash
# go.sh — [开发者快捷脚本] 一键起开发模式的 MiniCPM 桌宠
#
# ┌────────────────────────────────────────────────────────────────┐
# │  这是给「开发者」用的，不是给最终用户的。                       │
# │  普通用户请直接下载 dmg/exe 安装包，安装后跟着 Onboarding 走。 │
# │                                                                │
# │  ./go.sh 做的事：                                              │
# │  1) 装 Node / uv 依赖                                          │
# │  2) 下载官方 llama.cpp release 里的 llama-server               │
# │  3) uv sync 给 gateway 装 fastapi/uvicorn 等轻量 deps           │
# │  4) npm install + npm start 起 Electron（dev 模式）            │
# │                                                                │
# │  打包好的 .app / .dmg / .exe 已经内置 minicpm-sidecar 二进制，│
# │  不依赖本脚本。                                                │
# └────────────────────────────────────────────────────────────────┘
#
# Usage:
#   ./go.sh                # 安装 + 启动 (前台)
#   ./go.sh setup          # 只装依赖,不启动
#   ./go.sh start          # 跳过依赖检查直接启动
#   ./go.sh doctor         # 检查环境但什么都不做
#   ./go.sh fetch-llama    # 重新下载官方 llama-server
#   ./go.sh build          # 出整套安装包 (mac arm64 dmg)

set -e
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIDECAR_DIR="$HERE/minicpm-sidecar"
APP_DIR="$HERE/clawd-on-desk"
MODELS_DIR="$HERE/models"

cyan()   { printf "\033[36m%s\033[0m\n" "$*"; }
red()    { printf "\033[31m%s\033[0m\n" "$*" >&2; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }

# ── fnm-installed node lives outside /usr/local on most setups, so make
#    sure we can see it on every script run (idempotent no-op if missing).
load_fnm_env() {
  local fnm_dir="${FNM_DIR:-$HOME/.local/share/fnm}"
  if [[ -x "$fnm_dir/fnm" ]]; then
    export PATH="$fnm_dir:$PATH"
    eval "$("$fnm_dir/fnm" env --shell bash 2>/dev/null)" || true
  fi
}

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

  if ! command -v fnm >/dev/null 2>&1; then
    cyan "    安装 fnm (Node 版本管理器,无 sudo)..."
    curl -fsSL https://fnm.vercel.app/install | bash -s -- --skip-shell
  fi
  load_fnm_env
  if ! command -v fnm >/dev/null 2>&1; then
    red "fnm 自动安装失败。请手动安装 Node 18+: https://nodejs.org/"
    exit 1
  fi

  cyan "    fnm install 22..."
  fnm install 22
  fnm use 22
  fnm default 22 || true
  load_fnm_env

  if ! command -v node >/dev/null 2>&1; then
    red "Node 安装后仍找不到。检查 ~/.local/share/fnm/ 或重启终端再试。"
    exit 1
  fi
  green "    ✓ Node $(node -v) (fnm)"
}

ensure_uv() {
  if command -v uv >/dev/null 2>&1; then
    green "    ✓ uv $(uv --version)"
    return 0
  fi
  if [[ -x "$HOME/.local/bin/uv" ]]; then
    export PATH="$HOME/.local/bin:$PATH"
    green "    ✓ uv $(uv --version) (~/.local/bin)"
    return 0
  fi
  yellow "    uv 未安装,自动安装..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
  if ! command -v uv >/dev/null 2>&1; then
    red "uv 自动安装失败。请手动安装: curl -LsSf https://astral.sh/uv/install.sh | sh"
    exit 1
  fi
  green "    ✓ uv $(uv --version) (新装)"
}

check_environment() {
  cyan "==> 检查环境..."

  if [[ "$(uname)" != "Darwin" && "$(uname)" != "Linux" ]]; then
    yellow "    Windows 用户请用 PowerShell：scripts\\go.ps1 (后续提供)"
  fi

  ensure_node
  ensure_uv

  if [[ ! -f "$SIDECAR_DIR/pyproject.toml" ]]; then
    red "找不到 $SIDECAR_DIR/pyproject.toml,你是不是没解压完整?"
    exit 1
  fi
  green "    ✓ minicpm-sidecar/"

  if [[ ! -f "$APP_DIR/package.json" ]]; then
    red "找不到 $APP_DIR/package.json"
    exit 1
  fi
  green "    ✓ clawd-on-desk/"
}

ensure_llama_server() {
  cyan "==> 检查 llama-server..."
  local triple
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64)  triple="mac-arm64" ;;
    Darwin-x86_64) triple="mac-x64" ;;
    Linux-x86_64)  triple="linux-x64" ;;
    Linux-aarch64) triple="linux-arm64" ;;
    *)             triple="unknown" ;;
  esac
  local bin="$SIDECAR_DIR/bin/$triple/llama-server"
  if [[ -x "$bin" ]]; then
    green "    ✓ llama-server 已存在 ($bin)"
    return 0
  fi
  cyan "    首次下载官方 llama.cpp release 里的 llama-server..."
  ( cd "$SIDECAR_DIR" && ./scripts/fetch-llama-release.sh )
  green "    ✓ llama-server 已就绪"
}

install_python_deps() {
  cyan "==> Gateway 依赖 (uv sync)..."
  if [[ -d "$SIDECAR_DIR/.venv" && -f "$SIDECAR_DIR/.venv/bin/python" ]]; then
    green "    ✓ .venv 已存在,跳过 sync (跑 ./go.sh setup --force-sync 强制重装)"
  else
    cyan "    首次安装,只需几十 MB（fastapi + uvicorn + httpx + huggingface_hub）..."
    ( cd "$SIDECAR_DIR" && uv sync )
    green "    ✓ Gateway deps installed"
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

# LoRA 适配器权重 (.gguf) 不在 git 里,首次/缺失时从 Hugging Face 拉取
# (脚本幂等:本地已有有效文件即跳过)。
#   $1 == "required" → 失败即终止 (打包路径,缺文件会出残包)
#   否则             → 尽力而为 (dev 启动,拉不到也能先用 Base 人格)
fetch_adapters() {
  cyan "==> LoRA 适配器权重 (Hugging Face,缺失才下载)..."
  load_fnm_env
  if ! command -v node >/dev/null 2>&1; then
    yellow "    ⚠ Node 不在 PATH,跳过适配器下载"
    return 0
  fi
  if ( cd "$APP_DIR" && node scripts/fetch-adapters.js ); then
    return 0
  fi
  if [[ "${1:-}" == "required" ]]; then
    red "    适配器下载失败,打包会缺少猫娘人格。检查网络后重试。"
    exit 1
  fi
  yellow "    ⚠ 适配器下载失败;桌宠可先用 Base 人格,稍后 npm run fetch:adapters 重试。"
}

start_pet() {
  cyan "==> 启动桌宠..."
  load_fnm_env
  if ! command -v node >/dev/null 2>&1; then
    red "Node 不在 PATH 中。先跑一次 ./go.sh setup,或重启终端。"
    exit 1
  fi
  # Hint the Electron host where to find the sidecar source and Python.
  export MINICPM_SIDECAR_DIR="$SIDECAR_DIR"
  export MINICPM_PYTHON="$SIDECAR_DIR/.venv/bin/python"
  # If the dev hasn't dropped a .gguf into <repo>/models/ yet, the sidecar
  # boots in "waiting for model" mode and Onboarding will offer to
  # download one.
  if [[ -d "$MODELS_DIR" ]]; then
    export MINICPM_MODEL_DIR="$MODELS_DIR"
  fi
  green "    MINICPM_SIDECAR_DIR=$MINICPM_SIDECAR_DIR"
  green "    MINICPM_PYTHON=$MINICPM_PYTHON"
  [[ -n "${MINICPM_MODEL_DIR:-}" ]] && green "    MINICPM_MODEL_DIR=$MINICPM_MODEL_DIR"
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
    ensure_llama_server
    install_python_deps
    install_npm_deps
    fetch_adapters
    green ""
    green "✅ 安装完成。下一步: ./go.sh start"
    ;;
  start)
    start_pet
    ;;
  fetch-llama|build-llama)
    check_environment
    if [[ "$cmd" == "build-llama" ]]; then
      yellow "    build-llama 现在只是兼容别名；将下载官方 llama.cpp release。"
    fi
    ( cd "$SIDECAR_DIR" && ./scripts/fetch-llama-release.sh )
    ;;
  run|"")
    check_environment
    ensure_llama_server
    install_python_deps
    install_npm_deps
    fetch_adapters
    start_pet
    ;;
  build)
    # 一站式：下载官方 llama-server + PyInstaller 编 gateway →
    # electron-builder 出 dmg。输出位于 clawd-on-desk/dist/*.dmg。
    check_environment
    ensure_llama_server
    install_python_deps
    install_npm_deps
    fetch_adapters required
    cyan "==> 编 gateway + 准备 sidecar-bin..."
    ( cd "$SIDECAR_DIR" && ./scripts/build-all.sh )
    cyan "==> 打包 Electron 应用 (electron-builder)..."
    cd "$APP_DIR" && npx electron-builder --mac --arm64 -c.mac.target=dmg
    green "==> 完成。dmg 位于 $APP_DIR/dist/"
    ;;
  *)
    red "未知命令: $cmd"
    red "用法: ./go.sh [doctor|setup|start|run|build|fetch-llama]"
    exit 1
    ;;
esac
