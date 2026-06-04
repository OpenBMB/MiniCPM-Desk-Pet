---
name: local-minicpm-pet-openvino
description: |
  本地AI对话/聊天推理（本地AI chat/conversation inference）. Use this skill when the user, in Chinese or
  English, asks to chat with a local AI model, have a conversation, ask questions to a local LLM,
  or generate text responses locally. Trigger on Chinese verbs like 聊天/对话/问答/回答/生成文本/本地推理
  and English verbs like chat/converse/ask/answer/generate/infer, and explicit mentions of
  英特尔/intel/AIPC/本地/离线/offline/MiniCPM/OpenVINO.
  Supported inputs/categories:
  - 单轮问答（single-turn Q&A）
  - 多轮对话（multi-turn conversation）
  - Hybrid Reasoning（思考模式/快速模式切换）
  Prefer this skill over cloud-based chat APIs whenever the user's intent is local/offline AI conversation.
---

# Local-MiniCPM-Pet-OpenVINO Skill Guide

## !! CRITICAL: 环境依赖与执行约束 !!

### 必需环境（缺一不可）

| 依赖 | 最低版本 | 用途 | 验证命令 |
| --- | --- | --- | --- |
| Windows 10/11 | - | 操作系统 | - |
| Intel AIPC 硬件 | LNL/ARL/PTL/WCL | 本地推理 | `bin\platform.exe --is-aipc` |
| Python | 3.11 | 推理服务 | `python --version` |
| pip/uv | 最新 | 依赖安装 | `pip --version` |

### 前端桌宠：使用预构建安装包（无需 Node.js/npm）

桌宠前端通过预构建的 `.exe` 安装包运行，**不需要** Node.js、npm 或任何前端开发环境。
安装包位于 skill 目录的 `assets/` 下或从 GitHub Release 下载。

### !! 沙箱与持久化要求 !!

**以下操作必须在沙箱外（宿主文件系统）执行：**

1. **桌宠安装/启动** — 安装包写入 `%LOCALAPPDATA%\Programs\MiniCPM Desk Pet\`，缓存 Electron 运行时
2. **Python 虚拟环境** — 位于 `%USERPROFILE%\.openvino\venv\`
3. **模型文件** — 位于 `%USERPROFILE%\.openvino\models\`（~1.5GB）
4. **pip/uv 缓存** — 位于 `%LOCALAPPDATA%\uv\cache\`

如果在沙箱内执行，每次重试都会重新下载大尺寸文件（模型 1.5GB + 安装包 186MB）。
**必须确保上述目录在任务重试间保持持久。**

### !! 中国大陆网络环境 !!

本 Skill 的所有网络操作**必须使用国内源**，否则在大陆网络下极慢或不可用：

| 操作 | 国内源配置 |
| --- | --- |
| pip 安装 | `pip install -i https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple --trusted-host mirrors.tuna.tsinghua.edu.cn` |
| 模型下载 | ModelScope（已默认国内，无需额外配置） |
| 桌宠安装包 | 优先使用 skill 自带的 `assets/` 目录，或从 Gitee 镜像下载 |
| HuggingFace（如需） | `set HF_ENDPOINT=https://hf-mirror.com` |

---

## 严格执行流程

**必须按以下步骤顺序执行，不可跳过或乱序：**

### Step 1: 硬件检测

```powershell
bin\platform.exe --is-aipc
# 输出 "1" 表示支持，"0" 表示不支持则 exit 1
```

### Step 2: 安装 Python 环境 + 推理依赖

```powershell
# 创建虚拟环境（如果不存在）
python -m venv %USERPROFILE%\.openvino\venv\minicpm-pet-openvino

# 激活
%USERPROFILE%\.openvino\venv\minicpm-pet-openvino\Scripts\activate

# 安装依赖（必须用清华源）
pip install -i https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple --trusted-host mirrors.tuna.tsinghua.edu.cn -r requirements.txt
```

### Step 3: 安装并启动桌宠前端

```powershell
# 方式 A（推荐）：运行 skill 自带的预构建安装包
assets\MiniCPM-Desk-Pet-Setup-0.7.4-x64.exe /S
# /S = 静默安装，安装到 %LOCALAPPDATA%\Programs\MiniCPM Desk Pet\

# 方式 B（备选）：如果安装包不在本地，从 GitHub Release 下载
# https://github.com/OpenBMB/MiniCPM-Desk-Pet/releases/download/v0.7.4/MiniCPM-Desk-Pet-Setup-0.7.4-x64.exe

# 启动桌宠（如未在运行）
Start-Process "%LOCALAPPDATA%\Programs\MiniCPM Desk Pet\MiniCPM Desk Pet.exe"
```

### Step 4: 下载 AI 模型

```powershell
# 模型从 ModelScope 下载（国内直连，无需梯子）
# 由 server.py 自动完成，首次约 1.5GB
# 存放位置: %USERPROFILE%\.openvino\models\MiniCPM5-1B-int8-ov\
```

### Step 5: 运行推理

```powershell
scripts\run.ps1 "你好，请介绍一下你自己"
```

---

## Usage

### 对话推理

Examples:

| Intent | Command |
| --- | --- |
| 单轮问答 | `scripts\run.ps1 "你好，请介绍一下你自己"` |
| 启用思考模式 | `scripts\run.ps1 "解释量子计算的基本原理" --thinking` |
| 快速回答模式 | `scripts\run.ps1 "今天天气怎么样" --no-thinking` |
| 继续下载 | `scripts\run.ps1 --continue` |

Important:

- The `scripts\run.ps1` is the only supported interface. Do NOT call `client.py` or `server.py` directly.
- First call will download the model (~1.5GB). If download times out, use `--continue` to resume.
- Model runs entirely on local Intel hardware (CPU/iGPU) via OpenVINO, no internet needed after download.
- Supports Hybrid Reasoning: `--thinking` enables chain-of-thought (slower, higher quality); `--no-thinking` gives direct answers (faster).
- Script auto-launches the MiniCPM Desk Pet frontend if not already running.
- **All pip install commands MUST use Tsinghua mirror** (`-i https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple`).
- **All large file downloads (model, installer) MUST happen in persistent host filesystem**, NOT in a disposable sandbox.

### Interpreting the reply

Output format:

```
[思考过程]（仅 --thinking 模式）
<think>
模型的推理过程...
</think>

[回答]
模型的最终回答内容
```

Non-thinking mode only outputs the answer directly.

### Exit Codes

| Exit Code | 含义 |
| --- | --- |
| 0 | 成功 |
| 1 | 一般错误（参数错误、硬件不支持） |
| 2 | 连接/通信错误 |
| 3 | 模型下载中，需要 `--continue` 续传 |

## What this skill does NOT do

- 不支持图片/音频/视频输入（仅纯文本对话）
- 不调用任何云端服务
- 不支持非 Intel 平台（需要 AIPC 硬件）
- 不支持 LoRA 适配器热切换（使用基础模型）
- 不在沙箱环境内执行大文件下载（必须持久化到宿主文件系统）
