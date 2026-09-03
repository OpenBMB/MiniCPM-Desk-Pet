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

> 本分支的推理后端是 OpenVINO（Intel GPU / NPU，进程内），没有 llama.cpp 也没有 CPU 兜底。sidecar 结构与构建方式以 [`minicpm-sidecar/README.md`](../../minicpm-sidecar/README.md) 为准。

This skill walks the agent through deploying the MiniCPM-Desk-Pet project on a colleague's machine **from source**. The project has 2 moving parts: the FastAPI `gateway` (which runs OpenVINO in-process) and the Electron `clawd-on-desk` app. The machine must have an Intel GPU or NPU — there is no CPU fallback.

## Quick assessment first

Before doing anything, check what state the colleague's machine is in:

```bash
# Are we in the repo root?
ls README.md go.sh clawd-on-desk minicpm-sidecar 2>&1 | head -5

# What's already installed?
command -v node && node -v          # need 18+
command -v uv && uv --version       # go.sh installs if missing
python -c "import openvino as ov; print(ov.Core().available_devices)"  # need GPU and/or NPU
```

If the user isn't in the repo root, `cd` to wherever they cloned it first.

## Critical prerequisite: an OpenVINO IR

A model here is a **directory** (`openvino_model.xml` + `.bin` + the tokenizer pair), and nothing downloads it for you. Without one the gateway boots in "waiting for model" mode and Onboarding asks for a directory.

**Check first**:

```bash
ls -d models/ov/*/ 2>&1
```

If missing, two ways to obtain one:

1. **Convert a checkpoint** (~5–15 min, needs network for the HF download):

   ```bash
   cd minicpm-sidecar
   python scripts/convert-openvino.py --source openbmb/MiniCPM5-1B
   ```

   The default profile is symmetric INT4 / group-size 128, which runs on both the GPU and the NPU.

2. **Copy one from a teammate** (`scp -r` — it is a directory, not a file):

   ```bash
   scp -r teammate@host:/path/to/MiniCPM5-2.6B-int4-sym-g128 ./models/ov/
   ```

## Install path (what go.sh does)

```bash
./go.sh
```

`go.sh` is idempotent. It will:

1. Check Node 18+ (auto-install via brew or fnm if missing)
2. Auto-install `uv` if missing (`curl install.sh`)
3. `uv sync` in `minicpm-sidecar/` (~100 MB: fastapi / uvicorn / httpx / openvino-genai — no torch)
4. `npm install` in `clawd-on-desk/` (~1 minute, first time only)
5. Export `MINICPM_SIDECAR_DIR` + `MINICPM_PYTHON` + `MINICPM_MODEL_DIR`
6. `npm start` to launch Electron

If only the dependency-install part is needed (no launch yet):

```bash
./go.sh setup
```

Environment-check only (no install, no launch):

```bash
./go.sh doctor
```

## Verifying the deploy

Once Electron starts, you should see:

1. **Menu bar icon** — paw, top-right
2. **Floating pet** — sitting on the desktop, can be dragged
3. **Sidecar log** in terminal — `[sidecar]` lines, eventually `OpenVINO pipeline ready` + gateway listening on `:18765`

Quick sanity check (in another terminal):

```bash
curl -s http://127.0.0.1:18765/api/health | python3 -m json.tool
```

Expected `ok: true`, `backend: "openvino"`, and `accel` of `gpu` or `npu`.

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

### Sidecar log says 未检测到 Intel GPU 或 NPU

This build has no CPU fallback. Confirm the hardware and the graphics driver:

```bash
cd minicpm-sidecar
uv run python -c "import openvino as ov; print(ov.Core().available_devices)"
```

If only `['CPU']` comes back, the machine cannot run this build.

### Sidecar log says the NPU needs a symmetric INT4 IR

Handing the NPU an INT8 IR would kill the process outright (openvino#35641), so it is refused up front. Re-convert with the default preset, or run on the GPU.

### Sidecar log says `model not found`

The gateway couldn't locate an IR directory. Drop one into `models/ov/` or override:

```bash
MINICPM_MODEL_DIR=/abs/path/to/dir ./go.sh start
# or point directly at one file via Onboarding's "选本地模型"
```

### Pet starts but "气泡聊天没反应 / 卡住"

Probably the sidecar didn't come up. In the `clawd-on-desk` terminal, look for `[sidecar]` lines.

- If gateway can't find Python: ensure `minicpm-sidecar/.venv/bin/python` exists (`cd minicpm-sidecar && uv sync`)
- If the pipeline failed to compile: check memory (a 2.6B INT4 IR needs ~2 GB resident; INT8 needs ~3 GB)

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
./go.sh setup     # re-syncs deps
./go.sh start
```

`uv sync` and `npm install` are idempotent — no-op if nothing changed.

## What "success" looks like

The deploy is done when:

- Pet visible on desktop
- `curl -s http://127.0.0.1:18765/api/health` returns `ok:true`
- Click pet → bubble pops up → type a message → reply within a few seconds
- In Cursor: ask Cursor anything → after Cursor finishes → pet says a one-line reaction (proves cursor-hook is wired)
- `Settings → 🐾 MiniCPM` shows current model + adapter status

If any of these fail, walk back through the corresponding "Common failure" section above.
