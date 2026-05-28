# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MiniCPM Desk Pet is a local-first desktop pet powered by MiniCPM. It combines an Electron desktop pet app (forked from clawd-on-desk) with a llama.cpp inference sidecar. Users get a floating chat companion that runs entirely on-device after the initial model download.

The app supports macOS (Apple Silicon primary), Windows (x64 with Vulkan), and Linux. It reacts to coding-agent activity from Claude Code, Codex, Cursor, Gemini, Copilot, Kiro, CodeBuddy, and others.

## Repository Structure

```
MiniCPM-Desk-Pet/
├── clawd-on-desk/          ← Electron desktop pet (vendored fork, AGPL-3.0)
│   ├── src/                   146 source files — main process, renderer, settings, state machine
│   ├── hooks/                 Agent hook scripts (Claude, Codex, Cursor, Gemini, etc.)
│   ├── agents/                Agent registry + log monitors
│   ├── themes/                Built-in theme packs
│   └── test/                  Node built-in test runner tests
├── minicpm-sidecar/        ← llama.cpp inference + thin FastAPI gateway
│   ├── gateway/               Python gateway (FastAPI/uvicorn/httpx, no torch)
│   ├── scripts/               Build and fetch scripts for llama-server
│   └── tests/                 pytest suite
├── adapters/               ← LoRA persona adapters (.gguf)
├── llama.cpp/              ← Git submodule (ggml-org/llama.cpp)
├── models/                 ← GGUF model files (gitignored)
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
./go.sh fetch-llama  # Re-download official llama-server binary
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
2. **Inference sidecar** (`minicpm-sidecar/`): A bundled `llama-server` binary (from official llama.cpp releases) fronted by a thin FastAPI gateway. The gateway handles model lifecycle, adapter switching, and chat completions. No PyTorch — all ML runs inside llama-server.

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

5-step state machine: environment check → model download → warm-up → ready. Sentinel file at `<userData>/minicpm-onboarding.json`. Key files: `src/minicpm-onboarding.js` (main process), `src/minicpm-onboarding-renderer.js` (renderer).

## Conventions

- **Commit style**: [Conventional Commits](https://www.conventionalcommits.org/) — `feat:`, `fix:`, `refactor:`, `chore:`, `docs:`. Optional scope, e.g. `feat(sidecar): add endpoint`.
- **License**: AGPL-3.0-only. The `clawd-on-desk/` directory is a vendored fork — keep upstream conventions and avoid unnecessary divergence.
- **Resource paths**: Always use `path.join(__dirname, ...)`.
- **Hook registration**: Only append to existing Claude hook arrays, never overwrite.
- **Assets**: To edit release assets, copy to `assets/source/` first; don't edit originals of unknown provenance.
- **Windows builds**: Must produce separate x64/ARM64 installers (`nsis.buildUniversalInstaller: false`).

## Key Constraints

- `clawd-on-desk/` AGENTS.md contains detailed runtime constraints and high-risk gotchas — read it before modifying state machine, permissions, window management, or hook logic.
- The sidecar gateway is intentionally dependency-light (no torch/transformers). All ML inference happens in the native llama-server binary.
- macOS Apple Silicon is the primary tested platform. Windows and Linux changes should be code-reviewed carefully.
