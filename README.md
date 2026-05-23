# MiniCPM-Desk-Pet

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)
[![Upstream: clawd-on-desk](https://img.shields.io/badge/fork%20of-rullerzhou--afk%2Fclawd--on--desk-orange)](https://github.com/rullerzhou-afk/clawd-on-desk)

> **致谢 / Attribution**：本项目的桌宠 UI 层（[`clawd-on-desk/`](clawd-on-desk/)）
> 是 [rullerzhou-afk/clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk)
> 的 fork（基于 upstream commit `5b1f003`），在其之上集成了本地 MiniCPM5-0.9B
> 推理 sidecar、5 步 Onboarding、LoRA 人格切换以及面向 coding agent 的桌宠旁白。
> 原作者 [@rullerzhou-afk](https://github.com/rullerzhou-afk) 等贡献者的工作在此致谢。
>
> 本项目按 [AGPL-3.0-only](./LICENSE) 协议分发（与 upstream 一致）；完整的修改清单、
> 第三方组件归属与许可证信息请见 [`NOTICE.md`](./NOTICE.md)，vendored 子项目的原始
> 许可证保留在 [`clawd-on-desk/LICENSE`](clawd-on-desk/LICENSE) 与
> [`clawd-on-desk/NOTICE.md`](clawd-on-desk/NOTICE.md)。

本地 MiniCPM5-0.9B 模型 + 桌宠交互的实验项目。基于 [llama.cpp](https://github.com/ggml-org/llama.cpp)
的 `llama-server` 做 GGUF 推理（Apple Silicon → Metal，NVIDIA → CUDA，
通用 → CPU），Electron 桌宠当 UI 层，Cursor / Claude Code / Codex 等
coding agent 完成事件触发桌宠主动旁白。

> **状态**：mac arm64 MVP 已打通"双击 dmg → Onboarding 引导 → 聊天"全链路；Windows / Linux 通过同一套 sidecar 编译产物落地中。
>
> **v0.8 起**：推理后端从 PyTorch / transformers 切换到 llama.cpp。安装包体积从 ~700 MB（torch 嵌入）降到 ~几十 MB（gateway）+ 几十 MB（llama-server）。详见 [minicpm-sidecar/README.md](minicpm-sidecar/README.md)。

---

## 给最终用户 (推荐路径)

### 安装

1. 从 [Releases](https://github.com/OpenBMB/MiniCPM-Desk-Pet/releases) 下载 `Clawd-on-Desk-*-arm64.dmg`（仅 macOS Apple Silicon）。
2. 双击 dmg，把应用拖进 Applications。
3. 首次打开应用时，macOS 可能提示 "无法验证开发者"：
   - **右键** 应用图标 → **打开** → 在弹窗里点 **打开**；或
   - 终端运行 `xattr -cr /Applications/Clawd\ on\ Desk.app`，再双击。
4. 跟着首次启动的 Onboarding 向导走完 5 步：
   1. 环境检查
   2. 加速器探测（mac 上自动选 Metal）
   3. 模型下载（GGUF，~600 MB – 1 GB，从 Hugging Face 拉取，约 2–5 分钟）
   4. sidecar 启动 + warmup（llama-server mmap GGUF，~5–20 秒）
   5. 就绪——桌宠登场

整个过程不需要打开终端、不需要装 Python / conda / uv / PyTorch。

### 日常使用

- `⌘⇧M`：开关聊天气泡
- `⌘⇧T`：切换"思考模式"显示
- `Esc`：在气泡内焦点时关闭气泡
- 右键桌宠 → **Settings → 🐾 MiniCPM**：换 GGUF 路径、调整气泡位置、开关旁白、切换加速器，以及在「人格 LoRA」里挑选 / 切换 / 拖入用户自带的 GGUF 适配器

### 已知限制

- 主路径仍是 macOS Apple Silicon (M1+)；Windows / Linux 安装包由同一套 CI 出，但可能尚未全平台 QA
- dmg 暂未代码签名 / 公证（见上面的 Gatekeeper 绕开方式）
- packaged 安装不会自动检查应用更新——请手动到 Releases 看新版
- 模型可以由 sidecar 自身的 `/api/update-apply` 增量更新（GGUF 单文件下载）
- LoRA 适配器（含「猫娘人格」）在 v0.8 暂未移植到 llama.cpp，将在 v2 重新支持

---

## 给开发者

参见 [docs/development.md](docs/development.md)。简要：

```bash
git clone git@github.com:OpenBMB/MiniCPM-Desk-Pet.git
cd MiniCPM-Desk-Pet
mkdir -p models
# Drop a GGUF you already have, or let Onboarding download one on first launch.
cp /path/to/your/minicpm5-0.9b.Q4_K_M.gguf models/

./go.sh             # 一键 dev 模式（含 cmake 编 llama-server + uv sync gateway）
./go.sh build       # 出 dmg（mac arm64）
```

推理 sidecar 入口位于 [`minicpm-sidecar/`](minicpm-sidecar/)（llama.cpp + 瘦 FastAPI gateway）。
v0.7 时代的 PyTorch sidecar（`minicpm-pet-bridge*`）与旧 PyInstaller `build/`
目录已在 v0.9 整体移除；如需历史代码，请查阅 `v0.8.x` 之前的 git 历史。

---

## 主要功能

- 本地模型聊天（⌘⇧M 弹气泡）— llama.cpp 后端，GGUF 单文件加载
- 桌宠主动旁白（Cursor / Claude / Codex 完成事件）
- Settings → 🐾 MiniCPM：模型参数、气泡位置、旁白开关、加速器、本地模型路径、重跑 Onboarding
- 跨 agent 事件 merge：Cursor + Claude Code 同时为一个会话触发时自动选 transcript 上下文最丰富的那条
- **v2 已落地**：LoRA 人格切换（"用猫娘" / "切回原版"）通过 per-request `lora` 数组实现，主对话与旁白零并发污染；详见 [docs/llama-cpp-migration.md](docs/llama-cpp-migration.md#v2已落地) 和 [adapters/README.md](adapters/README.md)

完整变更见 [CHANGELOG.md](./CHANGELOG.md)。

## 文档索引

- [minicpm-sidecar/README.md](minicpm-sidecar/README.md) — 新推理 sidecar（llama.cpp）总览、API、构建与 vendor 分支说明
- [docs/llama-cpp-migration.md](docs/llama-cpp-migration.md) — v0.8 PyTorch → llama.cpp 迁移记录
- [docs/development.md](docs/development.md) — 开发者指南
- [CONTRIBUTING.md](CONTRIBUTING.md) — 贡献指南（quickstart / 测试 / commit 风格）
- [clawd-on-desk/AGENTS.md](clawd-on-desk/AGENTS.md) — 底座 Electron 桌宠的开发约束（fork 自 [rullerzhou-afk/clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk)）
- [docs/archive/](docs/archive/) — v0.7 历史调研文档（PRD、架构报告）

## License & Acknowledgments

本项目以 [GNU AGPL-3.0-only](./LICENSE) 协议开源。

桌宠 UI 层 fork 自 [rullerzhou-afk/clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk)（同为 AGPL-3.0），向原作者
[@鹿鹿 (rullerzhou-afk)](https://github.com/rullerzhou-afk) 及其全体贡献者致谢。详细 fork 起点
（upstream commit）、修改清单与第三方组件归属请见 [`NOTICE.md`](./NOTICE.md) 与
[`clawd-on-desk/NOTICE.md`](clawd-on-desk/NOTICE.md)。

> 依据 AGPL-3.0 §13，如以网络服务形式运行本项目修改版，须向使用者提供完整对应源码。
> 本仓库源码即 https://github.com/OpenBMB/MiniCPM-Desk-Pet 。
