# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MiniCPM Desk Pet is a local-first desktop pet powered by MiniCPM. It combines an Electron desktop pet app (forked from clawd-on-desk) with an OpenVINO inference sidecar. Users get a floating chat companion that runs entirely on-device.

**This branch is the Intel AIPC variant.** OpenVINO is the only inference engine and the only supported devices are the Intel GPU (Arc / Xe) and the AI Boost NPU — there is no llama.cpp path and no CPU fallback. It reacts to coding-agent activity from Claude Code, Codex, Cursor, Gemini, Copilot, Kiro, CodeBuddy, and others.

## Repository Structure

```
MiniCPM-Desk-Pet/
├── clawd-on-desk/          ← Electron desktop pet (vendored fork, AGPL-3.0)
│   ├── src/                   146 source files — main process, renderer, settings, state machine
│   ├── hooks/                 Agent hook scripts (Claude, Codex, Cursor, Gemini, etc.)
│   ├── agents/                Agent registry + log monitors
│   ├── themes/                Built-in theme packs
│   └── test/                  Node built-in test runner tests
├── minicpm-sidecar/        ← OpenVINO inference + thin FastAPI gateway
│   ├── gateway/               Python gateway (FastAPI/uvicorn/openvino-genai, no torch)
│   ├── scripts/               Gateway build + HF→OpenVINO IR conversion
│   └── tests/                 pytest suite
├── models/ov/              ← OpenVINO IR directories (gitignored)
└── go.sh                   ← Dev launcher and build entry point
```

## Development Commands

### Quick Start (dev mode)

```bash
./go.sh              # Install all deps + start Electron pet in foreground
./go.sh doctor       # Check environment (node 18+, uv, sidecar)
./go.sh setup        # Install deps only, don't start
./go.sh start        # Skip dependency checks, just start
./go.sh build        # Full packaged build (mac arm64 dmg)
```

### Tests

```bash
# Electron host (Node built-in test runner)
cd clawd-on-desk && npm test

# Python gateway
cd minicpm-sidecar && uv run pytest -q
```

Both suites must pass before opening a PR.

### Building

```bash
# Full build: sidecar binary + electron-builder dmg
./go.sh build

# Repack dmg without rebuilding sidecar
cd clawd-on-desk && npm run build:mac:repack

# Signed + Apple-notarized dmg (requires .env.apple-notarize.local)
cd clawd-on-desk && npm run build:mac:notarize

# Regenerate app icons from the master source
python3 clawd-on-desk/scripts/generate-icons.py

# Platform-specific builds (from clawd-on-desk/)
npm run build:win:x64
npm run build:win:arm64
npm run build:mac
npm run build:linux
```

### Debugging

```bash
# Sidecar health check
curl -s http://127.0.0.1:18765/api/health | python3 -m json.tool

# Kill stale processes
lsof -ti:18765 | xargs -r kill -9   # sidecar port
lsof -ti:23333 | xargs -r kill -9   # clawd HTTP server

# Force re-show onboarding
MINICPM_FORCE_ONBOARDING=1 ./go.sh start
```

## Architecture

### Two-Process Model

1. **Electron host** (`clawd-on-desk/`): Desktop pet UI, hook management, state machine, settings, chat bubble, onboarding wizard.
2. **Inference sidecar** (`minicpm-sidecar/`): A FastAPI gateway that runs `openvino_genai.LLMPipeline` **in-process** — no child server. It handles model lifecycle, device selection, and chat completions. No PyTorch; the OpenVINO runtime is a native wheel.

### Electron Event Flow

Hook/log events → `src/server.js` → `src/state.js` (state machine) → IPC → `src/renderer.js` (animation)

- Desktop pet uses a **dual-window model**: render window for display, input window for pointer events and drag
- HTTP server runs on `127.0.0.1:23333-23337`; runtime port written to `~/.clawd/runtime.json`
- Sidecar API runs on `127.0.0.1:18765`

### Settings System

`src/prefs.js` → `src/settings-controller.js` (sole writer) → `src/settings-store.js` (immutable snapshots). Side effects in `src/settings-actions.js`. Do not bypass `settings-controller.js`.

### Agent Integration

Each coding agent integrates via hooks, log monitors, or plugins. `src/agent-gate.js` controls per-agent enable/disable. Hook scripts may only depend on Node built-ins plus shared utilities in the hooks directory (`server-config.js`, `shared-process.js`, `json-utils.js`, `codex-subagent-fields.js`).

### Onboarding

3-stage state machine: environment check (Intel GPU/NPU detection) → pick an OpenVINO IR directory → warm-up. There is no bundled downloader; the user converts a checkpoint with `minicpm-sidecar/scripts/convert-openvino.py` and points the wizard at the result. Sentinel file at `<userData>/minicpm-onboarding.json`. Key files: `src/minicpm-onboarding.js` (main process), `src/minicpm-onboarding-renderer.js` (renderer).

## Conventions

- **Commit style**: [Conventional Commits](https://www.conventionalcommits.org/) — `feat:`, `fix:`, `refactor:`, `chore:`, `docs:`. Optional scope, e.g. `feat(sidecar): add endpoint`.
- **License**: AGPL-3.0-only. The `clawd-on-desk/` directory is a vendored fork — keep upstream conventions and avoid unnecessary divergence.
- **Resource paths**: Always use `path.join(__dirname, ...)`.
- **Hook registration**: Only append to existing Claude hook arrays, never overwrite.
- **Assets**: To edit release assets, copy to `assets/source/` first; don't edit originals of unknown provenance. App icon master is `assets/source/icon-master.png`; regenerate all icon assets via `python3 scripts/generate-icons.py`. Icons must be full-bleed square (opaque into corners) so macOS Tahoe tiles them correctly.
- **Windows builds**: Must produce separate x64/ARM64 installers (`nsis.buildUniversalInstaller: false`).

## Key Constraints

- `clawd-on-desk/` AGENTS.md contains detailed runtime constraints and high-risk gotchas — read it before modifying state machine, permissions, window management, or hook logic.
- The sidecar gateway is intentionally dependency-light (no torch/transformers). Inference runs on the OpenVINO runtime, a native wheel; the conversion tooling that does need torch is shelled out to a throwaway environment by `scripts/convert-openvino.py`.
- **A model is a directory** (`openvino_model.xml` + `.bin` + the tokenizer pair), never a single file.
- **The NPU only accepts symmetric INT4.** Handing it anything else does not raise — it kills the process with an uncatchable `0xC0000005` (openvino#35641), so `openvino_client` verifies IR precision before constructing the pipeline and fails closed.
- Packaging: the frozen sidecar is a PyInstaller **onedir** bundle (~301 MB) because onefile re-extracts the OpenVINO runtime on every launch (~14 s). The spec must use `collect_all`, not `collect_submodules` — the latter misses the native device plugins and yields a binary that reports no GPU/NPU on hardware that has both.
- Windows on Intel Core Ultra is the primary tested platform for this branch. macOS and Linux have no Intel NPU and generally no supported GPU, so they are effectively unsupported here.
