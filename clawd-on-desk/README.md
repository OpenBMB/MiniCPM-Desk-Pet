<p align="center">
  <img src="assets/tray-icon.png" width="128" alt="MiniCPM Desk Pet">
</p>
<h1 align="center">MiniCPM Desk Pet</h1>
<p align="center">
  <a href="README.zh-CN.md">简体中文</a>
  ·
  <a href="README.zh-TW.md">繁體中文</a>
  ·
  <a href="README.ko-KR.md">한국어</a>
  ·
  <a href="README.ja-JP.md">日本語</a>
</p>
<p align="center">
  <a href="https://github.com/OpenBMB/MiniCPM-Desk-Pet/releases"><img src="https://img.shields.io/github/v/release/OpenBMB/MiniCPM-Desk-Pet" alt="Version"></a>
  <img src="https://img.shields.io/badge/model-MiniCPM5--1B--GGUF-blue" alt="Model">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" alt="Platform">
  <img src="https://img.shields.io/badge/license-AGPL--3.0--only-green" alt="License">
</p>

MiniCPM Desk Pet is a local-first desktop pet powered by MiniCPM. It brings a lightweight desktop companion, a local MiniCPM chat bubble, first-launch model onboarding, and coding-agent state reactions into one app.

This fork keeps the MiniCPM product identity, default themes, model onboarding, packaged sidecar resources, and adapter paths. The v0.8 to v0.10 upstream feature migration is integrated around the Electron app, settings, hooks, state management, packaging, and tests; inframodel inference code is intentionally left untouched.

## Highlights

- **Local MiniCPM chat**: first-launch environment checks, MiniCPM5-1B-GGUF model download, warm-up, chat bubble, and local model status.
- **Model management**: Hugging Face / ModelScope download flow, local model path selection, backend restart, and log access.
- **Persona adapters**: LoRA adapters are managed from `Settings...` -> `MiniCPM` without changing the base model used for pet narration.
- **Desktop pet reactions**: the pet reacts to supported coding-agent sessions, tool activity, permissions, completion, idle, sleep, and mini-mode states.
- **On-demand agent integrations**: fresh installs manage Claude Code and Codex by default; other migrated agents are installed explicitly from Settings.
- **Remote features migrated but off**: Telegram approval/native bot, completion notification, Direct Send, mobile PWA, Hardware Buddy, and auto-pilot are present for later validation but disabled by default.

## Supported Agents

Claude Code and Codex are enabled as the default managed integrations. The migrated integration layer also includes Copilot CLI, Gemini CLI, Cursor Agent, CodeBuddy, Kiro CLI, Kimi Code CLI, opencode, Pi, OpenClaw, Hermes Agent, Qwen Code, Antigravity, Qoder, Reasonix, and CodeWhale, but non-default agents require explicit installation from `Settings...` -> `Agents`.

State-only integrations report activity without taking over permissions. Network and human-control features do not start automatically on first launch.

## Safety Gate

The following capabilities are code-migrated but not enabled by default:

- Telegram remote approval and Telegram native bot
- Completion notification and Telegram Direct Send
- Mobile read-only PWA
- Hardware Buddy
- Auto-pilot

Before any of these are enabled in a release configuration, they need dedicated local behavior tests, permission-safety tests, network disconnect tests, token/key handling tests, and cross-platform smoke tests. Direct Send must not automatically press Enter during this migration.

## Quick Start

Download prebuilt packages from [OpenBMB MiniCPM Desk Pet Releases](https://github.com/OpenBMB/MiniCPM-Desk-Pet/releases).

- **macOS**: `MiniCPM-Desk-Pet-<version>-<arch>.dmg`
- **Windows**: `MiniCPM-Desk-Pet-Setup-<version>-<arch>.exe`
- **Linux**: `.AppImage` or `.deb`

Run from source when developing or testing:

```bash
git clone https://github.com/OpenBMB/MiniCPM-Desk-Pet.git
cd MiniCPM-Desk-Pet/clawd-on-desk
npm install
npm start
```

The application folder remains `clawd-on-desk` for compatibility with the upstream Electron app structure and existing hook paths.

## Development Notes

- Keep MiniCPM sidecar, adapters, model resources, and default product metadata intact.
- Do not enable remote approval, mobile preview, Direct Send, Hardware Buddy, or auto-pilot without a separate test-and-release task.
- Planning artifacts such as `task_plan.md`, `findings.md`, `progress.md`, and `.planning/` are intentionally ignored by Git.

Useful commands:

```bash
npm test
npm start
```

## Acknowledgments

MiniCPM Desk Pet uses OpenBMB MiniCPM model resources and keeps attribution for the upstream desktop-pet UI foundation in [NOTICE.md](NOTICE.md). Model weights and third-party assets remain governed by their own licenses.
