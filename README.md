<p align="center">
  <img src="assets/readme%20logo.png" alt="MiniCPM Desk Pet" width="760">
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0--only-blue.svg" alt="License"></a>
  <a href="https://huggingface.co/openbmb/MiniCPM5-1B-GGUF"><img src="https://img.shields.io/badge/Model-MiniCPM5--1B-green" alt="MiniCPM5-1B"></a>
  <img src="https://img.shields.io/badge/Platform-macOS%20Apple%20Silicon-lightgrey" alt="Platform">
</p>

<p align="center">
  <strong>English</strong> | <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  A local-first desktop pet powered by MiniCPM. Download, complete the guided setup, and chat with a tiny companion that lives on your desktop.
</p>

---

## Highlights

- **Local by default** — after the model is downloaded, everyday chat runs on your machine.
- **Zero manual setup** — first launch guides you through environment check, model download, and warm-up.
- **Desktop companion** — open a floating chat bubble, talk with MiniCPM, and keep the pet on screen while you work.
- **Agent-aware reactions** — the pet can react to coding activity from tools such as Cursor, Claude Code, and Codex.
- **Smart model download** — the app can download from Hugging Face or ModelScope and choose the better source for your network.
- **Persona support** — switch or import character adapters from **Settings -> MiniCPM**.

## Getting Started

### System Requirements

| Item | Recommended |
| --- | --- |
| OS | macOS 14.0 or later |
| Chip | Apple Silicon (M1/M2/M3/M4) |
| Disk Space | About 2 GB for the app and default model |
| Network | Required on first launch unless you already have a local model file |

### Installation

1. Go to [Releases](https://github.com/OpenBMB/MiniCPM-Desk-Pet/releases) and download the latest macOS `.dmg`.
2. Open the DMG and drag **MiniCPM Desk Pet** into `Applications`.
3. Launch the app and follow the setup guide.

If macOS blocks the first launch, right-click the app and choose **Open**. If needed, remove the quarantine flag:

```bash
xattr -cr /Applications/MiniCPM\ Desk\ Pet.app
```

### First Launch

MiniCPM Desk Pet includes a complete first-launch guide:

**Environment Check** -> **Model Download** -> **Model Warm-up** -> **Ready to Use**

The default model is [MiniCPM5-1B-GGUF](https://huggingface.co/openbmb/MiniCPM5-1B-GGUF). You can let the app download it automatically, or choose an existing local `.gguf` file.

## Features

### Chat With a Local Pet

Use the floating chat bubble to talk with MiniCPM from your desktop. Once setup is complete, your normal conversations do not need a remote inference service.

Useful shortcuts:

- `Cmd+Shift+M` — open or close the MiniCPM chat bubble
- `Cmd+Shift+T` — show or hide thinking mode
- `Esc` — close the bubble when input is focused

### Reactions While You Work

MiniCPM Desk Pet can stay beside your workspace and react to coding-agent activity: thinking, working, finishing tasks, waiting for attention, or going idle.

### Model Management

The MiniCPM settings page lets you:

- download the default model or choose a local model file
- rerun onboarding
- manage character/persona adapters
- restart the local model runtime when needed

### Persona Adapters

The app includes a neko-style persona adapter. You can switch adapters or import your own from **Settings -> MiniCPM**.

## Roadmap

- Broader Windows and Linux validation.
- More persona presets.
- Clearer model download diagnostics and retry guidance.
- Faster first launch and smaller app footprint.
- Richer desktop-pet narration for long-running coding sessions.

## Known Limitations

- The primary tested release target is macOS Apple Silicon.
- First launch requires an internet connection unless you provide a local model file.
- Response speed depends on your chip, memory pressure, and selected model.
- Coding-agent reactions depend on each tool's integration behavior and may vary by version.

## Developer Notes

For development setup, packaging, and repository layout, see [`docs/development.md`](docs/development.md).

## Acknowledgments

- Desktop pet UI is based on [rullerzhou-afk/clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk). Full attribution is listed in [`NOTICE.md`](./NOTICE.md).
- Model weights come from the OpenBMB MiniCPM model family and are downloaded separately.
- The bundled neko persona uses [liumindmind/NekoQA-30K](https://huggingface.co/datasets/liumindmind/NekoQA-30K) for fine-tuning data.

## License

This repository is distributed under [GNU AGPL-3.0-only](./LICENSE).

MiniCPM model weights are downloaded separately and governed by the [OpenBMB MiniCPM Model License](https://github.com/OpenBMB/MiniCPM/blob/main/MiniCPM%20Model%20License.md). Artwork, third-party code, and datasets keep their own notices; see [`NOTICE.md`](./NOTICE.md) and [`clawd-on-desk/NOTICE.md`](clawd-on-desk/NOTICE.md).
