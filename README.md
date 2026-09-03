<p align="center">
  <img src="assets/readme%20logo.png" alt="MiniCPM Desk Pet" width="760">
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0--only-blue.svg" alt="License"></a>
  <a href="https://huggingface.co/openbmb/MiniCPM5-1B"><img src="https://img.shields.io/badge/Model-MiniCPM5--1B-green" alt="MiniCPM5-1B"></a>
  <a href="https://modelbest.feishu.cn/wiki/UtWxwcERfiRIpIkBOjuc3h9tn1D"><img src="https://img.shields.io/badge/MiniCPM-Wiki-1677FF?logo=readthedocs&logoColor=white" alt="MiniCPM Wiki"></a>
  <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20Intel%20AIPC-lightgrey" alt="Platform">
</p>

<p align="center">
  <strong>English</strong> | <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  A local-first desktop pet powered by MiniCPM. Download, complete the guided setup, and chat with a tiny companion that lives on your desktop.
</p>

---

## Highlights

- **Local by default** — everything runs on your machine, on the Intel GPU or NPU.
- **Zero manual setup** — first launch guides you through hardware detection, model selection, and warm-up.
- **Desktop companion** — open a floating chat bubble, talk with MiniCPM, and keep the pet on screen while you work.
- **Agent-aware reactions** — the pet can react to coding activity from tools such as Cursor, Claude Code, and Codex.
- **Task narration** — when a coding-agent session finishes, the pet summarizes what the AI just did in a speech bubble, so you can catch up at a glance.
- **Idle alerts** — if a coding agent has been waiting for your input, the pet plays a bell animation and sound to get your attention.
- **Auto-detect agents** — the app scans your machine for installed coding agents and prompts you to connect them in one click.
- **Intel GPU and NPU** — inference runs on OpenVINO, so you can switch between the Arc/Xe GPU and the AI Boost NPU without changing model.

## Getting Started

### System Requirements

| Item | Recommended |
| --- | --- |
| Windows | Intel Core Ultra with Arc/Xe graphics (an AI Boost NPU is optional), about 3 GB disk space |
| Model | An OpenVINO IR you converted yourself — see Getting Started |

> This build targets Intel AIPC hardware and has no CPU fallback: an Intel GPU or NPU is required. Windows on Intel Core Ultra is the tested platform.

### Installation

**Windows**

1. Go to [Releases](https://github.com/OpenBMB/MiniCPM-Desk-Pet/releases) and download the latest `.exe` installer.
2. Run the installer and complete the wizard.
3. Launch the app and follow the setup guide.

### First Launch

MiniCPM Desk Pet includes a complete first-launch guide:

**Environment Check** -> **Choose Model** -> **Model Warm-up** -> **Ready to Use**

There is no bundled download: convert a checkpoint such as [MiniCPM5-1B](https://huggingface.co/openbmb/MiniCPM5-1B) yourself with `python minicpm-sidecar/scripts/convert-openvino.py --source <checkpoint>`, then point the wizard at the resulting directory. The default profile is symmetric INT4, which runs on both the GPU and the NPU.

## Features

### Chat With a Local Pet

Use the floating chat bubble to talk with MiniCPM from your desktop. Once setup is complete, your normal conversations do not need a remote inference service.

Useful shortcuts (macOS uses `Cmd`, Windows uses `Ctrl`):

- `Cmd/Ctrl+Shift+M` — open or close the MiniCPM chat bubble
- `Cmd/Ctrl+Shift+T` — show or hide thinking mode
- `Esc` — close the bubble when input is focused

### Reactions While You Work

MiniCPM Desk Pet can stay beside your workspace and react to coding-agent activity: thinking, working, finishing tasks, waiting for attention, or going idle.

### Model Management

The MiniCPM settings page lets you:

- choose a different OpenVINO model directory
- rerun onboarding
- restart the local model runtime when needed

## Roadmap

- Ship a ready-made OpenVINO IR so no manual conversion is needed.
- Faster first launch and smaller app footprint.
- Richer desktop-pet narration for long-running coding sessions.

## Known Limitations

- Requires an Intel GPU or NPU. There is no CPU fallback, so non-Intel machines cannot run this build.
- You must convert an OpenVINO IR yourself before first use; nothing is downloaded for you.
- Response speed depends on your chip, memory pressure, and selected model.
- Coding-agent reactions depend on each tool's integration behavior and may vary by version.

## Developer Notes

For development setup, packaging, and repository layout, see [`docs/development.md`](docs/development.md).

## Acknowledgments

- Desktop pet UI is based on [rullerzhou-afk/clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk). Full attribution is listed in [`NOTICE.md`](./NOTICE.md).
- Model weights come from the OpenBMB MiniCPM model family and are converted locally.
- Inference runs on [OpenVINO GenAI](https://github.com/openvinotoolkit/openvino.genai) (Apache-2.0, Intel Corporation).

## License

This repository is distributed under [GNU AGPL-3.0-only](./LICENSE).

MiniCPM model weights are obtained separately and governed by the [OpenBMB MiniCPM Model License](https://github.com/OpenBMB/MiniCPM/blob/main/MiniCPM%20Model%20License.md). Artwork, third-party code, and datasets keep their own notices; see [`NOTICE.md`](./NOTICE.md) and [`clawd-on-desk/NOTICE.md`](clawd-on-desk/NOTICE.md).
