<p align="center">
  <img src="assets/readme%20logo.png" alt="MiniCPM Desk Pet" width="760">
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0--only-blue.svg" alt="License"></a>
  <a href="https://huggingface.co/openbmb/MiniCPM5-1B-GGUF"><img src="https://img.shields.io/badge/Model-MiniCPM5--1B-green" alt="MiniCPM5-1B"></a>
  <img src="https://img.shields.io/badge/Platform-macOS%20Apple%20Silicon-lightgrey" alt="Platform">
</p>

<p align="center">
  <a href="README.md">English</a> | <strong>简体中文</strong>
</p>

<p align="center">
  一个本地优先的 MiniCPM 桌宠。下载安装，跟随首次启动引导完成设置，就可以和桌面上的小伙伴聊天。
</p>

---

## 项目亮点

- **本地运行**：模型下载完成后，日常聊天在你的电脑上完成。
- **无需手动配置**：首次启动会引导完成环境检查、模型下载和模型预热。
- **桌面聊天伙伴**：通过悬浮气泡和 MiniCPM 对话，桌宠可以一直陪在桌面上。
- **感知工作状态**：可根据 Cursor、Claude Code、Codex 等工具的活动展示不同状态。
- **智能下载模型**：支持 Hugging Face 和 ModelScope，会根据网络情况选择更合适的下载源。
- **人格支持**：可在 **Settings -> MiniCPM** 中切换或导入角色适配器。

## 快速开始

### 系统要求

| 项目 | 推荐配置 |
| --- | --- |
| 系统 | macOS 14.0 或更高版本 |
| 芯片 | Apple Silicon (M1/M2/M3/M4) |
| 磁盘空间 | 应用和默认模型约 2 GB |
| 网络 | 首次启动需要联网下载模型；已有本地模型文件时可手动选择 |

### 安装

1. 前往 [Releases](https://github.com/OpenBMB/MiniCPM-Desk-Pet/releases) 下载最新 macOS `.dmg`。
2. 打开 DMG，将 **MiniCPM Desk Pet** 拖入 `Applications`。
3. 启动应用，按引导完成设置。

如果 macOS 阻止首次打开，可以右键应用选择 **Open**。必要时也可以移除隔离标记：

```bash
xattr -cr /Applications/MiniCPM\ Desk\ Pet.app
```

### 首次启动

MiniCPM Desk Pet 内置完整首次启动流程：

**环境检查** -> **模型下载** -> **模型预热** -> **开始使用**

默认模型是 [MiniCPM5-1B-GGUF](https://huggingface.co/openbmb/MiniCPM5-1B-GGUF)。你可以让应用自动下载，也可以选择已有的本地 `.gguf` 文件。

## 功能介绍

### 和本地桌宠聊天

打开悬浮聊天气泡，就可以直接和 MiniCPM 对话。设置完成后，日常聊天不需要依赖远程推理服务。

常用快捷键：

- `Cmd+Shift+M`：打开或关闭 MiniCPM 聊天气泡
- `Cmd+Shift+T`：显示或隐藏思考模式
- `Esc`：输入框聚焦时关闭气泡

### 工作时的状态反应

桌宠可以停留在你的工作区旁边，根据 coding agent 的状态表现出思考、工作、完成、等待关注、休息等不同反应。

### 模型管理

MiniCPM 设置页支持：

- 下载默认模型或选择本地模型文件
- 重新运行首次启动引导
- 管理角色 / 人格适配器
- 在需要时重启本地模型运行环境

### 人格适配器

应用内置一个 neko 风格人格适配器。你可以在 **Settings -> MiniCPM** 中切换适配器，也可以导入自己的适配器。

## 路线图

- 扩展 Windows 和 Linux 验证。
- 增加更多人格预设。
- 优化模型下载提示、重试和诊断体验。
- 缩短首次启动耗时，减小应用体积。
- 为长时间 coding 会话提供更丰富的桌宠旁白。

## 已知限制

- 当前主要验证和发布目标是 macOS Apple Silicon。
- 首次启动需要联网下载模型，除非你手动提供本地模型文件。
- 回复速度会受到芯片、内存压力和模型选择影响。
- Coding agent 状态反应依赖各工具自身的集成方式，不同版本之间可能存在差异。

## 开发者说明

开发环境、打包流程和仓库结构见 [`docs/development.md`](docs/development.md)。

## 致谢

- 桌宠 UI 基于 [rullerzhou-afk/clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk)。完整归属信息见 [`NOTICE.md`](./NOTICE.md)。
- 模型权重来自 OpenBMB MiniCPM 模型家族，并在使用时单独下载。
- 内置 neko 人格使用 [liumindmind/NekoQA-30K](https://huggingface.co/datasets/liumindmind/NekoQA-30K) 作为微调数据。

## 许可证

本仓库使用 [GNU AGPL-3.0-only](./LICENSE) 分发。

MiniCPM 模型权重会单独下载，受 [OpenBMB MiniCPM Model License](https://github.com/OpenBMB/MiniCPM/blob/main/MiniCPM%20Model%20License.md) 约束。美术素材、第三方代码和数据集保留各自声明；详见 [`NOTICE.md`](./NOTICE.md) 和 [`clawd-on-desk/NOTICE.md`](clawd-on-desk/NOTICE.md)。
