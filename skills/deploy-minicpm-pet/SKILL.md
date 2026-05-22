---
name: deploy-minicpm-pet
description: >-
  [开发者向] 帮 contributor / 开发者从源码 dev 模式跑通 MiniCPM-Desk-Pet。
  普通用户应直接下载 dmg 安装包，跟着 Onboarding 引导走，不应触发本 skill。
  Use when a developer clones the repo and wants to run it from source, or asks to
  "部署桌宠 (从源码)", "跑起来 MiniCPM dev 模式", or hits errors during go.sh / npm start / uv sync.
---

# Deploying MiniCPM-Desk-Pet (开发者从源码)

> **重要**：这个 Skill 只针对开发者。普通最终用户走的是 **下载 dmg → Onboarding** 流程，不应使用本 Skill。如果对方只是想"用一下这个应用"，请引导他们去 [Releases](https://github.com/OpenBMB/MiniCPM-Desk-Pet/releases) 下载 dmg。

> v0.8 起推理后端从 PyTorch / transformers 切换到 llama.cpp。本 Skill 已按 v0.9 平铺布局更新；如果遇到引用 `minicpm-pet-bridge*` 的旧文档，请以 [docs/llama-cpp-migration.md](../../docs/llama-cpp-migration.md) 为准。

This skill walks the agent through deploying the MiniCPM-Desk-Pet project on a colleague's machine **from source**. The project has 3 moving parts that need to come up in the right order: `llama-server` (compiled from vendored llama.cpp), the FastAPI `gateway`, and the Electron `clawd-on-desk` app.

## Quick assessment first

Before doing anything, check what state the colleague's machine is in:

```bash
# Are we in the repo root?
ls README.md go.sh clawd-on-desk minicpm-sidecar 2>&1 | head -5

# What's already installed?
command -v node && node -v          # need 18+
command -v uv && uv --version       # go.sh installs if missing
command -v cmake && cmake --version # go.sh installs if missing (needed for llama-server)
```

If the user isn't in the repo root, `cd` to wherever they cloned it first.

## Critical prerequisite: GGUF model

The model weight (~600 MB – 1 GB GGUF) is **NOT** in the repo. Without it, the gateway boots in "waiting for model" mode and Onboarding prompts the user to download one.

**Check first**:

```bash
ls -la models/*.gguf 2>&1
```

If missing, three ways to obtain it:

1. **Already have a `.gguf` locally** (most likely if the colleague worked on MiniCPM before):

   ```bash
   mkdir -p models
   ln -s /absolute/path/to/your/minicpm5-0.9b.Q4_K_M.gguf models/
   ```

2. **Let Onboarding download** — just run `./go.sh` and follow the wizard's "Download model" step (~2–5 minutes from Hugging Face).

3. **From a teammate's machine** (`scp`):

   ```bash
   scp teammate@host:/path/to/minicpm5-0.9b.Q4_K_M.gguf ./models/
   ```

The gateway accepts both a `.gguf` file path and a directory containing `.gguf` files.

## Install path (uv + cmake, what go.sh uses)

```bash
./go.sh
```

`go.sh` is idempotent. It will:

1. Check Node 18+ (auto-install via brew or fnm if missing)
2. Auto-install `uv` if missing (`curl install.sh`)
3. Auto-install `cmake` if missing (brew / apt)
4. First-time: clone vendored `llama.cpp` + `cmake` build `llama-server` (~5–10 min)
5. `uv sync` in `minicpm-sidecar/` (a few dozen MB: fastapi / uvicorn / httpx / huggingface_hub — no torch)
6. `npm install` in `clawd-on-desk/` (~1 minute, first time only)
7. Export `MINICPM_SIDECAR_DIR` + `MINICPM_PYTHON` + `MINICPM_MODEL_DIR`
8. `npm start` to launch Electron

If only the dependency-install part is needed (no launch yet):

```bash
./go.sh setup
```

Environment-check only (no install, no launch):

```bash
./go.sh doctor
```

Force a rebuild of `llama-server` (after pulling a new vendor pin):

```bash
./go.sh build-llama
```

## Verifying the deploy

Once Electron starts, you should see:

1. **Menu bar icon** — paw, top-right
2. **Floating pet** — sitting on the desktop, can be dragged
3. **Sidecar log** in terminal — `[sidecar]` lines, eventually `llama-server` ready + gateway listening on `:18765`

Quick sanity check (in another terminal):

```bash
curl -s http://127.0.0.1:18765/api/health | python3 -m json.tool
```

Expected `ok: true` plus reported backend (`metal` on Apple Silicon, `cuda`, or `cpu`).

Then click the pet (or `⌘⇧M`), type "你好" — pet should think and reply within a few seconds.

## Common deploy failures & fixes

### `Cannot find module 'electron'` / `npm start` fails immediately

```bash
cd clawd-on-desk && npm install
```

### `ModuleNotFoundError: fastapi` (or uvicorn / httpx)

```bash
cd minicpm-sidecar && uv sync
```

### `llama-server: command not found` / `bin/<triple>/llama-server` missing

The vendored llama.cpp didn't build. Re-run:

```bash
./go.sh build-llama
```

If cmake errors out, check `cmake --version` (need 3.20+) and re-install via brew / apt.

### Sidecar log says `model not found` / `No GGUF files in MODEL_DIR`

The gateway couldn't locate a `.gguf`. Drop one into `models/` or override:

```bash
MINICPM_MODEL_DIR=/abs/path/to/dir ./go.sh start
# or point directly at one file via Onboarding's "选本地模型"
```

### Pet starts but "气泡聊天没反应 / 卡住"

Probably the sidecar didn't come up. In the `clawd-on-desk` terminal, look for `[sidecar]` lines.

- If gateway can't find Python: ensure `minicpm-sidecar/.venv/bin/python` exists (`cd minicpm-sidecar && uv sync`)
- If `llama-server` crashed during model load: check memory (Q4_K_M needs ~1 GB RAM resident; F16 needs ~2 GB)

### `port 18765 in use` (or `23333`)

Old sidecar / clawd HTTP server didn't die cleanly:

```bash
lsof -ti:18765 | xargs -r kill -9   # sidecar
lsof -ti:23333 | xargs -r kill -9   # clawd HTTP server
```

### Cursor / Claude / Codex hook didn't auto-register

This is supposed to happen on first launch. Re-trigger via Settings → 🐾 MiniCPM, or restart the pet. Manual fallback (Claude as example):

```bash
cd clawd-on-desk
node -e "require('./hooks/install.js').installAll({silent:false})"
```

## Updating someone else's already-deployed install

If a teammate already has an older checkout and wants the latest:

```bash
git pull
./go.sh setup     # re-syncs deps + rebuilds llama-server if vendor pin changed
./go.sh start
```

`uv sync`, `npm install`, and `cmake` are idempotent — no-op if nothing changed.

## What "success" looks like

The deploy is done when:

- Pet visible on desktop
- `curl -s http://127.0.0.1:18765/api/health` returns `ok:true`
- Click pet → bubble pops up → type a message → reply within a few seconds
- In Cursor: ask Cursor anything → after Cursor finishes → pet says a one-line reaction (proves cursor-hook is wired)
- `Settings → 🐾 MiniCPM` shows current model + adapter status

If any of these fail, walk back through the corresponding "Common failure" section above.
