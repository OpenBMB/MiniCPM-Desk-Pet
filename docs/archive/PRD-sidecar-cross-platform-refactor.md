# PRD：MiniCPM 桌宠 Sidecar 跨平台重构

> 项目名称：MiniCPM-test  
> 文档类型：产品需求文档（PRD）  
> 参考项目：[ZMXJJ/Voca](https://github.com/ZMXJJ/Voca) — 本地语音克隆桌面应用，已实现 macOS + Windows 双端可分发，与本项目同样基于 Python FastAPI sidecar 架构

---

## 1. 文档信息

| 字段 | 内容 |
|------|------|
| 版本 | v0.1（Draft） |
| 日期 | 2026-05-20 |
| 作者 | 项目负责人 |
| 评审人 | 待定 |
| 状态 | Draft，已部分由 v0.8 重构落地 |
| 关联文档 | [docs/architecture-and-cross-platform-report.md](architecture-and-cross-platform-report.md)（架构调研与三端打包改造报告，作为本 PRD 的技术细节附录） |
| 勘误 | **v0.8 起推理后端从 PyTorch 切换为 llama.cpp**。本 PRD 中提到的 §6.1（PyInstaller 嵌入 torch ~700MB）、§6.4（Linux/Windows 的 torch CUDA wheel 索引）等章节已不再适用，请参考 [docs/llama-cpp-migration.md](llama-cpp-migration.md)。其它产品诉求（北极星指标、Onboarding 流程、签名 / 自动更新策略、Voca 对标）仍然作为 v0.8 的设计输入。 |

---

## 2. 背景与现状

### 2.1 项目定位

本项目把开源小模型 **MiniCPM5-0.9B** 跑在端侧（macOS 上走 MPS，Windows / Linux 上走 CUDA / CPU），由一个 Electron 桌宠（fork 自 [rullerzhou-afk/clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk)）担任 UI 层，再通过 hook 体系把 Cursor / Claude Code / Codex 等 coding agent 的事件汇聚到桌宠，让桌宠主动旁白。

详细背景参见 [README.md](../README.md) 和 [CHANGELOG.md](../CHANGELOG.md)。

### 2.2 当前现状

唯一被闭环验证的平台是 **macOS（Apple Silicon / MPS）**。底座 `clawd-on-desk` 在 [AGENTS.md](../clawd-on-desk/AGENTS.md) 已经做好 Windows / macOS / Linux 三端兼容；本仓库新加的 **MiniCPM 集成层**（聊天气泡、sidecar 管理、narration）则只针对 mac 写了路径与 spawn 逻辑，Windows 直接挂、Linux 部分能跑。

底座三端分发能力的完整结论参见架构报告 [§ 1.5.1 底座三端分发现状](architecture-and-cross-platform-report.md)，sidecar 侧阻塞项与必备改造参见 [§ 1.5.2 "加 sidecar 就具备端侧推理条件" 这个判断对吗？](architecture-and-cross-platform-report.md)。

### 2.3 参考项目 Voca 的关键架构事实

[ZMXJJ/Voca](https://github.com/ZMXJJ/Voca) 是社区里走过同样工程路径的对照项目（语音克隆，VoxCPM 引擎）。其公开资料中以下事实对本 PRD 有直接参考价值：

| 维度 | Voca 的选择 | 对本项目的指导意义 |
|------|------------|---------------------|
| 桌面框架 | Tauri 2 + Rust | 本项目保留 Electron + clawd-on-desk fork，**不改动桌面框架**，仅对齐 sidecar 思路 |
| 推理 sidecar | Python FastAPI + Uvicorn | 与本项目当前 [server.py](../minicpm-pet-bridge/server.py) 完全一致 |
| 推理引擎 | VoxCPM | 本项目是 MiniCPM5-0.9B，引擎可平替 |
| 首次启动流程 | 环境检查 → 运行时下载 → 模型下载&校验 → 模型 warmup → 就绪（5 步） | **本 PRD § 5.1 全面对齐**：把 onboarding 抬升为产品一等公民 |
| 模型下载源 | Hugging Face + ModelScope 双源，按网络自动推荐 | 中国大陆 / 海外用户全覆盖；本 PRD § 5.3 采纳 |
| macOS 签名 | Apple Developer ID + 公证（Notarization） | 本 PRD § 8 安全要求采纳 |
| Windows 安装包 | per-user NSIS，免管理员权限 | 与本项目现有 `package.json` 已声明的 NSIS 一致 |
| 包体积 | macOS ~6 GB（app + 模型）；Windows ~11 GB（app + 模型 + 2.5 GB CUDA 运行时） | 本 PRD § 3.2 北极星指标参照（更激进） |
| Windows 加速器策略 | **强制 NVIDIA GPU**，无 GPU 直接不支持 | 本 PRD **不一致**：本项目放宽到 NVIDIA 优先 + CPU fallback |
| Linux 支持 | 未计划 | 本项目列为 P1 stretch goal，主路径 mac + win |

> 数据来源：Voca 仓库 README（[ZMXJJ/Voca](https://github.com/ZMXJJ/Voca)），截至 2026-05 v0.5.0。

### 2.4 决策记录（已与项目负责人确认）

- **决策 1**：桌宠层保留 Electron + clawd-on-desk fork 不动，仅重构 sidecar 侧。理由：底座已具备完整三端能力（[release-v0.7.1.md](../clawd-on-desk/docs/releases/release-v0.7.1.md)），且承载了大量 hook / permission / theme 集成，重写代价过高。
- **决策 2**：Windows 加速器策略采用 NVIDIA 优先 + CPU fallback，而非 Voca 的"强制 NVIDIA"。理由：MiniCPM5-0.9B 比 VoxCPM 小一个数量级，CPU 上 1–3 tok/s 仍达到"勉强可用"底线；无 GPU 的 Windows 笔记本在国内市场占有量高。
- **决策 3**：Linux 列为 P1（stretch goal），M2 阶段交付。理由：开发资源有限，先把 mac + win 的"双击安装即用"打通，Linux 通过 AppImage / deb 跟进。

---

## 3. 目标与非目标

### 3.1 业务目标

让普通用户能在 **macOS arm64 / Windows x64** 上"**双击安装包即可使用**"，全程无需懂 conda、uv、Python、Hugging Face、命令行——和 Voca、Ollama Desktop、LM Studio 等同类桌面 AI 应用对齐。

### 3.2 北极星指标

| 指标 | 目标值 | 备注 |
|------|--------|------|
| 双端首次启动到第一句对话回复 | ≤ 8 分钟 | 假设家用宽带 50 Mbps + SSD，含 2 GB 模型下载 |
| mac dmg 安装包体积 | ≤ 1.5 GB | 不含模型 |
| win NSIS 安装包体积（CUDA 包） | ≤ 2.5 GB | 含 2.5 GB CUDA 运行时分发，与 Voca 持平 |
| win NSIS 安装包体积（CPU 包） | ≤ 1.2 GB | 仅 CPU torch wheel |
| 三端 `/api/health` 探活成功率 | ≥ 99% | 模型已下载场景下 |
| 模型下载断点续传成功率 | ≥ 95% | 网络中断后重试 |
| 升级保留率（对话历史 / 设置 / 模型） | 100% | 旧版 → 新版无丢失 |

### 3.3 非目标（明确不做）

- 不重写桌宠 UI / 不替换底座框架（Electron 保留）。
- 不替换底层模型（仍是 MiniCPM5-0.9B 系列）。
- 不做云端推理 / 多用户协作 / 账号体系。
- 不引入 Windows ARM64 推理路径（PyTorch 2026-05 暂无官方 wheel）。
- 不引入 Linux ARM64（树莓派类）推理路径。
- 不重构现有的 narration / overload / failure-streak 派生状态系统。
- 不替换桌宠 hook 体系（Cursor / Claude / Codex / Gemini / Codebuddy / Kiro / opencode / Pi / OpenClaw / Hermes）。

---

## 4. 目标用户与场景

### 4.1 Persona

| Persona | 描述 | 当前能用吗 | 本 PRD 是否覆盖 |
|---------|------|------------|-----------------|
| **P1 协作者（开发者）** | clone 仓库 + `./go.sh`，能开终端、装 conda/uv | 是（仅 mac） | 是，扩展到 win + linux |
| **P2 内部体验用户** | 从 GitHub Release 下载 dmg/exe，第一次双击即用 | 否 | **是，本 PRD 核心受众** |
| **P3 终端用户（未来）** | 从官方发布渠道下载，期望签名 + 公证、SmartScreen 不报红 | 否 | 是，M3 GA 阶段 |
| P4 企业内网用户 | HF 被墙、模型放公司 NAS | 否 | 是，通过 ModelScope 兜底源 + "指定本地模型目录"覆盖入口 |

### 4.2 核心场景

| 场景编号 | 场景描述 | 验收点 |
|----------|----------|--------|
| S1 | mac 用户首次安装 → 引导下载模型 → 第一次聊天 | 双击 dmg → 拖到 Applications → 启动 → onboarding → 5 步走完 → 气泡输入"你好"得到回复，**全程不开终端** |
| S2 | win 用户首次安装（有 NVIDIA GPU） | 双击 exe（per-user，免管理员）→ onboarding 检测到 CUDA → 提示下载 CUDA 运行时 + 模型 → 聊天 |
| S3 | win 用户首次安装（无 GPU 的轻薄本） | 同上，onboarding 检测无 GPU → 切到 CPU 路径 → 顶部条幅提示"性能受限，建议关闭 narration" → 聊天仍可用 |
| S4 | HF 被墙场景 | onboarding 模型下载 HF 失败 → 自动尝试 ModelScope → 提示"已切换到国内源" → 完成 |
| S5 | 升级到新版 | Settings → 检查更新 → 提示有新版 → 下载并替换 → 对话历史 / 设置 / 模型文件保留 |
| S6 | 换设备从零开始 | mac + win 等效流程，模型可以走"指定本地路径"复用旧机器的下载结果 |

---

## 5. 产品需求

### 5.1 安装与首次启动（Onboarding Flow）

**对齐 Voca 的 5 步流程**，并针对本项目的多加速器做扩展。

```mermaid
flowchart LR
  install["双击安装包"] --> launch["首次启动 Electron"]
  launch --> envCheck["1. 环境检查\n(sidecar binary / 磁盘 ≥ 10 GB / 网络)"]
  envCheck --> backendPick["2. 加速器探测\nMPS / CUDA / CPU"]
  backendPick --> runtimeDl["3a. CUDA 运行时下载\n(Win + Nvidia, ~2.5 GB)"]
  backendPick --> modelDl["3b. 模型下载\n(~2 GB, HF / ModelScope)"]
  runtimeDl --> modelDl
  modelDl --> verify["4. 模型校验 + LoRA 安装"]
  verify --> warmup["5. sidecar 启动 + warmup"]
  warmup --> ready["就绪: 桌宠 + 气泡可用"]
```

#### 详细需求

| 步骤 | 必须做到 | 错误降级 |
|------|----------|----------|
| 1 环境检查 | sidecar binary 存在性、磁盘可用空间、网络可达性（HF + ModelScope）三项检测，UI 实时展示 | 任一项失败明确提示并提供"重试 / 跳过 / 退出" |
| 2 加速器探测 | 自动选最佳后端并展示候选清单；用户可手动覆盖（参考 Voca） | 无 GPU 自动切 CPU 路径，顶部条幅提示性能受限 |
| 3a CUDA 运行时 | 仅 Win + Nvidia 场景需要；可断点续传；下载完成做 sha256 校验 | 失败可重试 / 切换镜像源 / 跳过（fallback 到 CPU） |
| 3b 模型下载 | HF / ModelScope 双源，按 ping 推荐；进度条 + 速度 + ETA；可暂停 / 切源 | HF 失败自动尝试 MS，反之亦然；保留已下载分片 |
| 4 校验 + LoRA | 走 [updater.py](../minicpm-pet-bridge/updater.py) 的 revision.json 协议；LoRA 22 MB 随包附带 | 文件 hash 不一致提示重新下载 |
| 5 warmup | 启动 sidecar → `/api/warmup` → 显示 device + dtype + 第一个 token 延迟 | 启动失败给出阶段标识（环境 / 运行时 / 加载 / warmup）+ 一键打开日志 |

技术实现细节参见架构报告 [§ 6.2 模型与适配器分发](architecture-and-cross-platform-report.md)。

### 5.2 平台支持矩阵

| 平台 | 优先级 | 安装包格式 | 加速器 | 包体积上限 | 备注 |
|------|--------|------------|--------|------------|------|
| macOS Apple Silicon (M1+) | P0 | dmg（Developer ID 签名 + 公证） | MPS bf16 | 1.5 GB | 主路径 |
| macOS Intel | P1 | 同 dmg（universal binary） | CPU fp32 | 1.5 GB | 性能受限提示 |
| Windows 10 22H2 / 11 x64 + NVIDIA | P0 | NSIS per-user | CUDA fp16/bf16 | 2.5 GB | 含 CUDA 运行时分发 |
| Windows 10/11 x64 无 GPU | P0 | 同 NSIS | CPU fp32 | 1.2 GB | **与 Voca 不同，本项目支持** |
| Linux x64 + NVIDIA | P1 | AppImage + deb | CUDA | 2.5 GB | M2 阶段 |
| Linux x64 无 GPU | P1 | 同 | CPU | 1.2 GB | 同上 |
| Windows ARM64 | 不支持 | — | PyTorch 暂无 wheel | — | 用户可以在 Win 11 x64 模拟下运行 |
| Linux ARM64 | 不支持 | — | 同上 | — | — |

### 5.3 模型与适配器管理

- **默认基座**：MiniCPM5-0.9B；可在 Settings 切换其他兼容 HF 模型目录（已有 `/api/load-model`）。
- **下载源**：
  - 默认 `hf://openbmb/MiniCPM5-0.9B`；
  - 备选 `modelscope://...`；
  - 启动时各 ping 一次，UI 推荐较快源，用户可手选。
- **LoRA 适配器**：
  - 默认随安装包附带 `lora_nekoqa_adapter_*`（22 MB 可接受），通过 electron-builder `extraResources` 打入 `<resources>/adapters/`；
  - 后续支持 Settings 内增 / 删 / 切换。
- **模型存储位置迁移**：从仓库内 `<repo>/models/` 改为 `<userData>/models/`：
  - mac：`~/Library/Application Support/Clawd on Desk/models/`
  - win：`%APPDATA%\Clawd on Desk\models\`
  - linux：`~/.config/Clawd on Desk/models/`
- **本地路径覆盖**：Settings → 🐾 MiniCPM 提供"指定本地模型目录"入口，写入 `<userData>/minicpm-prefs.json`，sidecar 启动时通过 `--model` 注入。企业内网 / NAS 场景必备。

### 5.4 推理性能与加速器选择

- **启动时自动探测**：MPS → CUDA → CPU；探测结果写入 `<userData>/minicpm-prefs.json`。
- **Settings 手动覆盖**：用户可在"加速器"下拉中强制选择，覆盖自动探测结果。
- **CPU 路径降级**：检测到 CPU 路径时：
  - 默认关闭 narration（避免桌宠 30 秒一句话的尴尬）；
  - `max_new_tokens` 默认降到 256（原默认 768）；
  - 顶部条幅提示"性能受限"。

| 硬件 | 期望 tok/s | 评级 |
|------|-----------|------|
| mac M1 / MPS bf16 | ≥ 30 | 流畅 |
| mac M2/M3/M4 / MPS bf16 | ≥ 50 | 优秀 |
| Windows + RTX 30/40 / CUDA bf16 | ≥ 50 | 优秀 |
| Windows + RTX 20 / CUDA fp16 | ≥ 30 | 流畅 |
| Linux + Nvidia / CUDA | ≥ 30 | 流畅 |
| CPU 笔记本（i5/Ryzen 5 ≥ 16 GB） | ≥ 1 | 可用底线 |

dtype 兜底详见架构报告 [§ 6.4 Python sidecar 改造](architecture-and-cross-platform-report.md)。

### 5.5 离线与隐私

- **模型下载完成后**：sidecar 不主动联网（与 Voca 一致）。
- **"检查更新"是用户主动行为**：UI 默认不轮询。
- **数据本地化**：对话历史、Settings、模型文件、LoRA 全部在 `<userData>` 下，不外发。
- **遥测**：默认关闭；如未来引入，必须 opt-in，且不收集模型对话内容。
- **崩溃日志**：默认仅本地保留 `<userData>/logs/`，不自动上传。

### 5.6 升级与版本管理

- **Windows**：复用底座 `electron-updater`（[electron-updater 文档](https://www.electron.build/auto-update)），sidecar binary 与 Electron 同包升级。
- **macOS / Linux**：受底座 known-limitations 约束（packaged 安装无自动更新，[clawd-on-desk/docs/guides/known-limitations.md](../clawd-on-desk/docs/guides/known-limitations.md)）。改进路径：
  - Settings 提供"检查更新"按钮，指向 GitHub Releases；
  - **模型与 LoRA** 通过 sidecar 自身 `/api/update-apply` 增量更新，不依赖整包升级——这是与 Voca 不一样的优势（模型 2 GB 不需要每次跟应用同发）。
- 升级语义详见架构报告 [§ 1.5.2 G. 自动更新](architecture-and-cross-platform-report.md)。

### 5.7 错误处理与降级体验

| 失败类型 | UI 行为 |
|----------|---------|
| 模型下载网络断开 | 进度条变灰 + 提示「网络中断，已暂停。可断点续传」+「切换源」按钮 |
| HF 503 / 404 | 自动尝试 ModelScope，提示「已切换到国内源」 |
| sidecar 启动失败 | 弹窗显示具体阶段（环境 / 运行时 / 加载 / warmup）+ 折叠的错误日志摘要 + 「打开完整日志」+「重试」+「联系支持」 |
| GPU 驱动版本过低 | 提示「需要 CUDA ≥ 12.1 / 驱动 ≥ 535」+ 「跳过，使用 CPU」 |
| 磁盘空间不足 | onboarding 阶段拦截，明确告知需 10 GB |
| 模型校验失败 | 提示「文件损坏，需要重新下载」+ 一键清空并重试 |

---

## 6. 架构方向（参考 Voca 的工程要点）

### 6.1 桌宠层（不变）

- 保留 Electron + clawd-on-desk fork（version 0.7.1）；
- 仅在 [clawd-on-desk/src/minicpm-chat.js](../clawd-on-desk/src/minicpm-chat.js) 内做平台分支：
  - `locatePython()` 补 win / linux 候选路径；
  - `_spawnAndWait` 走 `cmd.exe /c` 而非 `/bin/bash`；
  - `locateBridgeDir()` 在 `app.isPackaged` 时返回 `process.resourcesPath`。
- IPC 协议（[preload-minicpm-chat.js](../clawd-on-desk/src/preload-minicpm-chat.js)）保持不变。
- 详细改造方案见架构报告 [§ 6.3 Electron 侧改造](architecture-and-cross-platform-report.md)。

### 6.2 Sidecar 分发模型（对齐 Voca）

- **方案**：PyInstaller 单文件二进制，对齐 Voca 的 sidecar 思路（[ZMXJJ/Voca](https://github.com/ZMXJJ/Voca) 用的是 Python FastAPI + Uvicorn sidecar 通过 Tauri sidecar 机制嵌入；本项目改为 Electron `extraResources` 嵌入）。
- 每平台一份二进制，通过 [clawd-on-desk/package.json](../clawd-on-desk/package.json) 的 `build.extraResources` 打入安装包：
  - `dist/sidecar/mac-arm64/minicpm-sidecar` → `<app>/Contents/Resources/sidecar-bin/`
  - `dist/sidecar/win-x64/minicpm-sidecar.exe` → `<app>/resources/sidecar-bin/`
  - `dist/sidecar/linux-x64/minicpm-sidecar` → `<app>/resources/sidecar-bin/`（chmod 0755）
- PyInstaller spec 草稿与 hidden imports 详见架构报告 [§ 6.1 Python sidecar 分发策略选型](architecture-and-cross-platform-report.md)。

### 6.3 Sidecar 协议与端点

#### 6.3.1 现有端点（保持向后兼容）

下列端点全部保留，不破坏既有调用：

`/api/health`、`/api/chat (SSE)`、`/api/warmup`、`/api/classify`、`/api/adapters`、`/api/load-adapter`、`/api/load-model`、`/api/update-check`、`/api/update-apply (SSE)`、`/api/state`、`/api/models`、`/`、`/static/*`。

字段语义详见架构报告 [§ 4.2 Python sidecar 端点矩阵](architecture-and-cross-platform-report.md)。

#### 6.3.2 新增端点（本 PRD 提出，落到后续 TDD）

| Method | Path | 用途 | 返回示例 |
|--------|------|------|----------|
| GET | `/api/onboarding` | 一次返回当前 onboarding 阶段供 UI 渲染 | `{stage:"model-download", progress:0.42, hint:"切换到 ModelScope 中..."}` |
| POST | `/api/select-source` | 切换 HF / ModelScope 源 | `{source:"modelscope://..."}` |
| GET | `/api/devices` | 列出可用加速器与推荐项 | `{available:["mps","cpu"], recommended:"mps", reasons:{...}}` |
| POST | `/api/set-device` | 持久化用户的加速器手动选择 | `{ok:true, device:"cpu"}` |

### 6.4 配置与持久化路径

| 类型 | 路径 | 来源 |
|------|------|------|
| 用户数据根 | `app.getPath("userData")` | mac `~/Library/Application Support/Clawd on Desk/`、win `%APPDATA%\Clawd on Desk\`、linux `~/.config/Clawd on Desk/` |
| 模型 | `<userData>/models/` | **本 PRD 迁移自 `<repo>/models/`** |
| LoRA | `<userData>/adapters/` 或 `<resources>/adapters/`（随包） | 同上 |
| Sidecar binary | `<resources>/sidecar-bin/` | PyInstaller 产物 |
| 聊天参数 | `<userData>/minicpm-prefs.json` | 已存在 |
| 气泡位置 | `<userData>/minicpm-bubble-pos.json` | 已存在 |
| Onboarding 状态 | `<userData>/minicpm-onboarding.json` | **新增** |
| 日志 | `<userData>/logs/sidecar-*.log` | **新增** |

完整端口与路径表参见架构报告 [§ 9.2 端口与持久化路径表](architecture-and-cross-platform-report.md)。

### 6.5 加速器自动选择

- 探测顺序：MPS → CUDA → DirectML（探索，P2）→ CPU。
- dtype 兜底：mac MPS / Ampere+ CUDA → bf16；Turing / 老卡 → fp16；CPU → fp32。
- 详见架构报告 [§ 6.4 Python sidecar 改造](architecture-and-cross-platform-report.md)。

---

## 7. 重构范围与变更项清单

下面是本 PRD 要求落地的具体变更，按"模块 / 现状 / 目标态 / 验收"四列展开。

| 模块 | 现状 | 目标态 | 验收 |
|------|------|--------|------|
| [clawd-on-desk/src/minicpm-chat.js](../clawd-on-desk/src/minicpm-chat.js) `locatePython` / `_spawnAndWait` / `locateBridgeDir` | 硬编码 mac conda 路径，`/bin/bash` spawn | 三端可启动 sidecar，packaged 模式直接走 binary | mac + win + linux `npm start` 均能拉起 sidecar，`/api/health` 200 |
| [clawd-on-desk/src/settings-tab-minicpm.js](../clawd-on-desk/src/settings-tab-minicpm.js) | 状态 / 更新 / 适配器 / 生成参数 / 气泡位置 / 旁白 6 区 | 新增「加速器」「下载源」「Onboarding 状态」「本地模型路径」4 区 | UI 可见且可改、立刻生效 |
| 新增 `clawd-on-desk/src/minicpm-onboarding.js` | 不存在 | 独立 BrowserWindow，5 步引导 + 进度 + 重试 | 首次启动自动打开，已完成后不再弹 |
| [clawd-on-desk/package.json](../clawd-on-desk/package.json) `build.extraResources` | 仅含底座资源 | 接入 sidecar binary + LoRA adapters + sidecar 源代码（备用） | `electron-builder` 三端产物中能看到 `sidecar-bin/`、`adapters/`、`minicpm-pet-bridge/` |
| [minicpm-pet-bridge-uv/pyproject.toml](../minicpm-pet-bridge-uv/pyproject.toml) | 单一 `torch>=2.4.0,<2.7` | 按平台路由：mac PyPI / Linux+Win CPU / Linux+Win CUDA 12.1 | CI 三端 build 都能成功 |
| [minicpm-pet-bridge/server.py](../minicpm-pet-bridge/server.py) `_pick_dtype` / `_pick_device` | MPS bf16 / CUDA bf16-or-fp16 / CPU fp32 | 加 SM 8.0 检测、加 psutil 内存预检日志、加 `/api/devices` `/api/onboarding` `/api/select-source` `/api/set-device` 端点 | 各端 device 字段返回正确，新增端点 200 |
| [minicpm-pet-bridge/updater.py](../minicpm-pet-bridge/updater.py) | mock + HF 双后端，`os.replace` 跨卷失败 | 新增 ModelScope 后端、`_atomic_move` 跨卷兜底、断点续传 | win 跨盘符模型下载成功，HF 失败自动切 MS |
| 新增 `build/sidecar.spec` | 不存在 | PyInstaller spec，含 hidden-imports、binaries、datas | 三端 build 产物可独立运行 `--help` |
| 新增 `go.ps1` | 不存在 | Windows 等价 `go.sh`，doctor/setup/start/run 子命令 | Win 终端跑 `.\go.ps1` 拉起开发模式 |
| 修改 `go.sh` | macOS 才完整工作 | 兼容 Linux | Linux 跑 `./go.sh` 成功 |
| 新增 `.github/workflows/release.yml` | 不存在 | mac arm64/x64、win x64、linux x64 矩阵 build + sign + 上传 Release | tag push 后自动出三端 artifacts |
| 新增公证 / 签名脚本 | 不存在 | mac afterSign hook + win 代码签名 | 安装后 Gatekeeper / SmartScreen 不报警 |

---

## 8. 非功能需求

| 类目 | 指标 | 备注 |
|------|------|------|
| 包体积 | mac dmg ≤ 1.5 GB；win NSIS（CUDA 包）≤ 2.5 GB；win NSIS（CPU 包）≤ 1.2 GB；linux AppImage 同 win | 与 Voca 持平或更优 |
| 首次启动总时长 | 50 Mbps 网络 + SSD ≤ 8 min | 含 2 GB 模型下载 + CUDA 运行时（若适用） |
| sidecar 冷启动 | ≤ 90 s | 首次模型加载 + warmup |
| sidecar 热响应 | warmup 后 `/api/chat` 首 token ≤ 1 s | |
| 内存占用 | bf16 加载下 ≤ 4 GB RSS（含 LoRA） | CPU fp32 可能更高，UI 提示用户 |
| 启动崩溃率 | < 1% | 三端综合 |
| 签名 / 公证 | mac Developer ID + Notarization；win 代码签名（EV 优先） | CI secrets，避免本地泄露 |
| 隐私 | 默认不联网；遥测 opt-in；不收集对话内容 | |
| 可访问性 | Onboarding 三语：zh-CN / en / zh-TW（对齐 Voca） | 底座 i18n 已有 en/zh/ko/ja，扩展 zh-TW |
| 日志可读性 | 错误日志含「阶段 + 异常类型 + 文件路径」三要素，便于复现 | |
| 离线启动 | 模型已就位时，无网也能启动并对话 | |

---

## 9. 里程碑与交付物

| 里程碑 | 时间 | 范围 | 交付物 | 验收 |
|--------|------|------|--------|------|
| **M0 解锁** | 1–2 周 | 跨平台 Python 查找、spawn 修复、`go.ps1`、torch 平台索引 | 三端可在开发模式 `npm start` 跑起来 | mac + win + linux 各跑通一次 `/api/health` 200 |
| **M1 Alpha 双端可分发** | 2–3 周 | PyInstaller pipeline、`extraResources`、Onboarding Flow v1（环境 + 模型下载 + warmup）、CPU fallback、加速器手动覆盖 | mac dmg + win exe（未签名） | 内部 5 人 dogfood：首次启动到第一句对话 ≤ 10 分钟 |
| **M2 Beta 三端** | 1–2 周追加 | Linux AppImage + deb；GitHub Actions release matrix；ModelScope 双源 | 三端 artifacts + 自动化 release | tag push 后 CI 出 6 个 artifact（mac arm64/x64、win x64、linux AppImage/deb） |
| **M3 GA** | 1–2 周 | Apple 公证 + Windows 代码签名、模型增量更新、文档与 release notes、UAT 通过 | 签名后的三端安装包 + Release v1.0 | Gatekeeper / SmartScreen 不报警；UAT 5 项全通 |

---

## 10. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| torch wheel 体积过大 | win CUDA 包接近 3 GB，下载体验差 | 拆 CPU 包 + GPU 包两个 SKU；GPU 用户首次下 CUDA 运行时（与 Voca 一致） |
| PyInstaller 隐含模块漏打 | 运行期 `cannot find transformers.models.minicpm5` | CI 加 smoke test：build 后 `--help` + 跑一次 `/api/chat` |
| Windows SmartScreen 误报 | 首次启动用户被吓退 | 申请 EV 代码签名 + 上线后冷启动期 |
| 首次启动等待过长 | 用户以为应用挂了 | onboarding 进度条 + 阶段提示 + 桌宠"打盹"过渡动画 |
| CPU 设备体验崩塌 | narration 卡 30 秒，桌宠看起来坏了 | CPU 路径默认禁用 narration + 顶部条幅提示性能受限 |
| Win arm64 不支持 | 部分用户买了 Surface Pro X 不能用 | Release 页面明确标注；Win arm64 走 x64 模拟（Windows 11 24H2 已支持） |
| HF 被墙 | 国内用户卡在模型下载 | ModelScope 兜底源 + 自动切换 |
| `koffi` 等 native dep 在 win arm64 重编译 | 安装包构建失败 | electron-builder 自带 `--arm64` 重建；CI 走 windows-2022-arm 或交叉编译；Windows ARM64 直接放弃，仅出 x64 |
| 模型下载在企业代理后失败 | 企业用户无法离线 | 提供"指定本地模型目录"覆盖入口（参见 § 5.3） |
| Apple 公证流程复杂 | M3 阶段卡 release | 提前申请 Apple Developer 账号；M1 阶段先把 entitlements / hardened runtime 打通 |

更细的风险拆解参见架构报告 [§ 8.2 风险与缓解](architecture-and-cross-platform-report.md)。

---

## 11. 验收标准与 UAT 清单

### 11.1 工程验收（M0 / M1 / M2）

参见架构报告 [§ 7 验证清单](architecture-and-cross-platform-report.md)，覆盖：

1. `go.sh` / `go.ps1` 全流程通过
2. `curl /api/health` 返回 device 字段正确
3. 全局快捷键弹气泡 + 完整聊天往返
4. LoRA 切换不崩溃
5. Cursor stop hook → narration 触发
6. 模型更新走 `hf://openbmb/MiniCPM5-0.9B`

### 11.2 UAT（M3 GA 前必须全部通过）

| 编号 | 场景 | 通过条件 |
|------|------|----------|
| UAT-1 | 「无开发经验用户 + mac arm64」 | 从下载 dmg → 完整安装 → 对话回复 ≤ 10 分钟，不开终端 |
| UAT-2 | 「无开发经验用户 + win x64 有 GPU」 | 同上 ≤ 12 分钟（含 CUDA 运行时下载） |
| UAT-3 | 「无开发经验用户 + win x64 无 GPU」 | 同 UAT-1 ≤ 10 分钟，对话能完成（首条响应可慢） |
| UAT-4 | 「HF 被墙网络」 | onboarding 自动切 ModelScope，下载成功 |
| UAT-5 | 「升级保留」 | 旧版 → 新版后对话历史 / Settings / 模型文件 / LoRA 保留 |
| UAT-6 | 「断网恢复」 | 模型下载中拔网线 → 恢复后断点续传，不重新下载已完成分片 |
| UAT-7 | 「企业内网 / 自带模型」 | Settings 指定本地模型目录后立即可用，跳过下载步骤 |
| UAT-8 | 「Gatekeeper / SmartScreen」 | mac 双击 dmg 不出现「未知发布者」；win 双击 exe SmartScreen 不报红 |

---

## 12. 附录

### 12.1 与 Voca 的能力对照表

| 能力 | Voca v0.5.0 | 本项目目标态（M3 GA） | 差异说明 |
|------|-------------|---------------------|----------|
| 桌面框架 | Tauri 2 + Rust | Electron + clawd-on-desk fork | 各有取舍：Voca 包小，本项目复用桌宠生态 |
| 推理 sidecar | Python FastAPI + Uvicorn | 同 | 一致 |
| 推理引擎 | VoxCPM（语音克隆） | MiniCPM5-0.9B（文本） | 不同领域，工程模板可借鉴 |
| Onboarding | 5 步（环境 / 运行时 / 模型 / warmup / 就绪） | 5 步对齐 | 一致 |
| 模型双源 | HF + ModelScope，按网络自动推荐 | 同 | 一致 |
| LoRA / 适配器 | 无（VoxCPM 自己的克隆机制） | 内置猫娘 LoRA + 可切换 | 本项目独有 |
| Narration / 桌宠联动 | 无 | 完整支持（Cursor / Claude / Codex 等） | 本项目核心差异点 |
| mac 签名 | Apple Developer ID + Notarization | 同 | 一致 |
| win NSIS | per-user，免管理员 | 同 | 一致 |
| win 加速器 | **强制 NVIDIA** | NVIDIA 优先 + CPU fallback | **本项目更包容** |
| Linux | 未计划 | P1（M2 阶段） | 本项目额外覆盖 |
| 包体积（mac） | ~6 GB | ≤ 1.5 GB（不含模型）+ 2 GB（模型） | 本项目优势：模型不进包 |
| 包体积（win） | ~11 GB | ≤ 2.5 GB（含 CUDA）+ 2 GB（模型） | 同 |
| 自动更新 | win ✅ / mac ❓ / linux N/A | win ✅ / mac/linux 手动 | 受底座限制 |
| 三语 UI | zh-TW / zh-CN / en | 对齐 + 底座原有 ko / ja | 本项目语言覆盖更广 |

### 12.2 相关文档索引

- [README.md](../README.md) — 项目快速上手
- [CHANGELOG.md](../CHANGELOG.md) — v0.2 变更日志
- [docs/architecture-and-cross-platform-report.md](architecture-and-cross-platform-report.md) — 架构调研与三端打包改造报告（本 PRD 的技术细节附录）
- [clawd-on-desk/AGENTS.md](../clawd-on-desk/AGENTS.md) — 底座 Electron 桌宠的开发约束
- [clawd-on-desk/docs/guides/setup-guide.md](../clawd-on-desk/docs/guides/setup-guide.md) — 底座三端安装指引
- [clawd-on-desk/docs/guides/known-limitations.md](../clawd-on-desk/docs/guides/known-limitations.md) — 底座已知限制
- [clawd-on-desk/docs/releases/release-v0.7.1.md](../clawd-on-desk/docs/releases/release-v0.7.1.md) — 底座当前版本 release notes
- [ZMXJJ/Voca README](https://github.com/ZMXJJ/Voca) — 参考项目

### 12.3 术语表

| 术语 | 含义 |
|------|------|
| sidecar | 与主应用同进程模型并行的辅助进程；本项目中是 Python FastAPI 推理服务 |
| onboarding | 首次启动时的引导流程，让普通用户无需懂技术也能完成安装与配置 |
| warmup | 模型加载完成后跑一次轻量 forward，把权重 fault back 进 RAM / VRAM，降低首次响应延迟 |
| LoRA | Low-Rank Adaptation，参数高效微调技术；本项目用 PEFT 实现，22 MB 一个适配器 |
| 加速器 | 推理后端：MPS（mac）/ CUDA（NVIDIA）/ DirectML（Windows 通用 GPU）/ CPU |
| packaged | electron-builder 产物运行模式（dmg / exe 安装后），与 `npm start` 开发模式相对 |
| extraResources | electron-builder 的资源打包字段，把外部文件放到 `<app>/resources/` |
| MPS | Metal Performance Shaders，Apple Silicon 的 GPU 加速后端 |
| ModelScope | 阿里达摩院的模型托管平台，中国大陆访问 HF 的兜底源 |
| HF / Hugging Face | 全球主要的开源模型托管平台，本项目默认源 |
| narration | 桌宠在 coding agent 完成事件时主动旁白的功能 |
| persona | 当前加载的人格设定，跟随 LoRA 适配器切换（如 `default` ↔ `neko`） |

— PRD 完 —
