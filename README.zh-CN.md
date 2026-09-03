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
  <a href="README.md">English</a> | <strong>简体中文</strong>
</p>

<p align="center">
  一个本地优先的 MiniCPM 桌宠。下载安装，跟随首次启动引导完成设置，就可以和桌面上的小伙伴聊天。
</p>

---

## 项目亮点

- **本地运行**：模型下载完成后，日常聊天在你的电脑上完成。
- **无需手动配置**：首次启动会引导完成硬件检测、模型选择和模型预热。
- **桌面聊天伙伴**：通过悬浮气泡和 MiniCPM 对话，桌宠可以一直陪在桌面上。
- **感知工作状态**：可根据 Cursor、Claude Code、Codex 等工具的活动展示不同状态。
- **任务旁白**：coding agent 会话结束时，桌宠会在气泡中用一句话总结 AI 刚刚做了什么，方便你快速了解进度。
- **等待提醒**：当 coding agent 在等你回复时，桌宠会播放铃铛动画和提示音，防止你错过。
- **自动发现 agent**：应用会扫描本地已安装的编程 agent，提示你一键连接。
- **Intel GPU 与 NPU**：推理走 OpenVINO，同一份模型可以在 Arc/Xe 核显和 AI Boost NPU 之间随意切换。

## 快速开始

### 系统要求

| 项目 | 推荐配置 |
| --- | --- |
| Windows | Intel Core Ultra，需 Arc/Xe 核显（AI Boost NPU 可选），约 3 GB 磁盘空间 |
| 模型 | 需要自行转换的 OpenVINO IR 目录，见下方「开始使用」 |

> 本构建面向 Intel AIPC，没有 CPU 兜底：必须有 Intel GPU 或 NPU。当前验证平台是 Windows + Intel Core Ultra。

### 安装

**Windows**

1. 前往 [Releases](https://github.com/OpenBMB/MiniCPM-Desk-Pet/releases) 下载最新 `.exe` 安装程序。
2. 运行安装向导，按提示完成安装。
3. 启动应用，按引导完成设置。

### 首次启动

MiniCPM Desk Pet 内置完整首次启动流程：

**环境检查** -> **选择模型** -> **模型预热** -> **开始使用**

本构建不内置下载：请先用 `python minicpm-sidecar/scripts/convert-openvino.py --source <检查点>` 自行转换（例如 [MiniCPM5-1B](https://huggingface.co/openbmb/MiniCPM5-1B)），再在向导里选中产出的目录。默认量化是对称 INT4，GPU 和 NPU 都能直接跑。

## 功能介绍

### 和本地桌宠聊天

打开悬浮聊天气泡，就可以直接和 MiniCPM 对话。设置完成后，日常聊天不需要依赖远程推理服务。

常用快捷键（macOS 为 `Cmd`，Windows 为 `Ctrl`）：

- `Cmd/Ctrl+Shift+M`：打开或关闭 MiniCPM 聊天气泡
- `Cmd/Ctrl+Shift+T`：显示或隐藏思考模式
- `Esc`：输入框聚焦时关闭气泡

### 工作时的状态反应

桌宠可以停留在你的工作区旁边，根据 coding agent 的状态表现出思考、工作、完成、等待关注、休息等不同反应。

### 模型管理

MiniCPM 设置页支持：

- 下载默认模型或选择本地模型文件
- 重新运行首次启动引导
- 在需要时重启本地模型运行环境

## 路线图

- 优化模型下载提示、重试和诊断体验。
- 缩短首次启动耗时，减小应用体积。
- 为长时间 coding 会话提供更丰富的桌宠旁白。

## 已知限制

- 必须有 Intel GPU 或 NPU，没有 CPU 兜底，非 Intel 机器无法运行本构建。
- 首次使用前需要自己转换一份 OpenVINO IR，本构建不会替你下载模型。
- 回复速度会受到芯片、内存压力和模型选择影响。
- Coding agent 状态反应依赖各工具自身的集成方式，不同版本之间可能存在差异。

## 开发者说明

开发环境、打包流程和仓库结构见 [`docs/development.md`](docs/development.md)。

## 致谢

- 桌宠 UI 基于 [rullerzhou-afk/clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk)。完整归属信息见 [`NOTICE.md`](./NOTICE.md)。
- 模型权重来自 OpenBMB MiniCPM 模型家族，由用户在本地转换。
- 推理由 [OpenVINO GenAI](https://github.com/openvinotoolkit/openvino.genai)（Apache-2.0，Intel Corporation）提供。

## 许可证

本仓库使用 [GNU AGPL-3.0-only](./LICENSE) 分发。

MiniCPM 模型权重需自行获取，受 [OpenBMB MiniCPM Model License](https://github.com/OpenBMB/MiniCPM/blob/main/MiniCPM%20Model%20License.md) 约束。美术素材、第三方代码和数据集保留各自声明；详见 [`NOTICE.md`](./NOTICE.md) 和 [`clawd-on-desk/NOTICE.md`](clawd-on-desk/NOTICE.md)。
