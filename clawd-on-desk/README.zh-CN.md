<p align="center">
  <img src="assets/tray-icon.png" width="128" alt="MiniCPM Desk Pet">
</p>
<h1 align="center">MiniCPM Desk Pet</h1>
<p align="center">
  <a href="README.md">English</a>
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

MiniCPM Desk Pet 是一个由 MiniCPM 驱动的本地优先 AI 桌宠。它把桌面宠物、本地 MiniCPM 聊天气泡、首次启动模型引导，以及 AI 编程 Agent 状态反馈整合到同一个应用里。

本分支保留 MiniCPM 的产品身份、默认主题、模型引导、打包资源、sidecar 路径和 adapter 路径。0.8 到 0.10 的迁移集中在 Electron 前端、设置、Agent hook、状态管理、打包配置和测试上；inframodel 推理侧代码保持不改。

## 功能亮点

- **本地 MiniCPM 对话**：首次启动环境检查、MiniCPM5-1B-GGUF 模型下载、预热、聊天气泡和本地模型状态。
- **模型管理**：支持 Hugging Face / ModelScope 下载流程、本地模型路径选择、后端重启和日志查看。
- **人格 LoRA**：在 `设置...` -> `MiniCPM` 中管理 LoRA adapter；桌宠旁白仍固定使用 base 模型。
- **桌宠状态反馈**：根据受支持 Agent 的会话、工具调用、权限请求、完成、空闲、睡眠和 mini-mode 状态切换动画。
- **按需 Agent 集成**：全新安装默认只管理 Claude Code 和 Codex；其他迁移来的 Agent 需要在 Settings 中显式安装。
- **远程/人控功能默认关闭**：Telegram approval/native bot、completion notification、Direct Send、mobile PWA、Hardware Buddy 和 auto-pilot 均只迁移代码，不默认启用。

## 支持的 Agent

Claude Code 和 Codex 是默认启用的托管集成。迁移后的集成层还包含 Copilot CLI、Gemini CLI、Cursor Agent、CodeBuddy、Kiro CLI、Kimi Code CLI、opencode、Pi、OpenClaw、Hermes Agent、Qwen Code、Antigravity、Qoder、Reasonix 和 CodeWhale，但非默认 Agent 必须在 `Settings...` -> `Agents` 中手动安装。

state-only 集成只上报状态，不接管权限。网络和人控能力首次启动时不会自动监听端口、发送消息或接受手机端输入。

## 安全开关

以下能力已经迁移代码，但默认保持关闭：

- Telegram remote approval 和 Telegram native bot
- Completion notification 和 Telegram Direct Send
- Mobile 只读 PWA
- Hardware Buddy
- Auto-pilot

这些能力启用前必须单独完成本地功能测试、权限安全测试、网络断连测试、token/密钥处理测试和跨平台 smoke test。Direct Send 在本次迁移中不得自动按 Enter。

## 快速开始

从 [OpenBMB MiniCPM Desk Pet Releases](https://github.com/OpenBMB/MiniCPM-Desk-Pet/releases) 下载预构建安装包。

- **macOS**：`MiniCPM-Desk-Pet-<version>-<arch>.dmg`
- **Windows**：`MiniCPM-Desk-Pet-Setup-<version>-<arch>.exe`
- **Linux**：`.AppImage` 或 `.deb`

开发或测试时从源码运行：

```bash
git clone https://github.com/OpenBMB/MiniCPM-Desk-Pet.git
cd MiniCPM-Desk-Pet/clawd-on-desk
npm install
npm start
```

应用目录仍保留为 `clawd-on-desk`，用于兼容上游 Electron 结构和现有 hook 路径。

## 开发说明

- 保留 MiniCPM sidecar、adapter、模型资源和默认产品元数据。
- 未经独立测试与发布任务，不启用远程审批、移动端预览、Direct Send、Hardware Buddy 或 auto-pilot。
- `task_plan.md`、`findings.md`、`progress.md` 和 `.planning/` 等 planning 产物已加入 Git 忽略。

常用命令：

```bash
npm test
npm start
```

## 致谢

MiniCPM Desk Pet 使用 OpenBMB MiniCPM 模型资源，并在 [NOTICE.md](NOTICE.md) 中保留上游桌宠 UI 基础的归属说明。模型权重与第三方资源遵循各自许可证。
