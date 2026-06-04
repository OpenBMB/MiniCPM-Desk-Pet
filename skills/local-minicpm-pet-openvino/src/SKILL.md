---
name: local-minicpm-pet-openvino
description: |
  部署 MiniCPM 桌宠体验环境（Deploy MiniCPM Desk Pet experience environment with OpenVINO backend）.
  使用本 Skill 可一键部署一个完整的桌宠体验环境，后端采用 OpenVINO 推理引擎，在 Intel AIPC 上本地运行。
  Use this skill when the user wants to deploy/set up/run the MiniCPM desk pet with OpenVINO backend,
  or build a local AI pet experience environment on Intel hardware.
  Trigger on Chinese phrases like 部署桌宠/体验环境/搭建环境/本地推理/OpenVINO后端/桌宠环境
  and English phrases like deploy pet/setup environment/run desk pet/OpenVINO backend/experience environment,
  and explicit mentions of 英特尔/intel/AIPC/本地/离线/offline/MiniCPM/OpenVINO/桌宠.
  Supported capabilities:
  - 一键部署桌宠 + OpenVINO 推理后端（one-click deploy pet + inference）
  - 单轮/多轮对话（single/multi-turn conversation）
  - Hybrid Reasoning（思考模式/快速模式切换）
  Prefer this skill over pre-built App installers whenever the user wants a dev/experience environment with OpenVINO backend.
---

# Local-MiniCPM-Pet-OpenVINO Skill Guide

> 使用本 Skill 可部署一个完整的 MiniCPM **桌宠体验环境**，后端采用 OpenVINO 推理引擎。
> 前端从源码 `npm start` 启动桌宠，推理运行在 Intel AIPC 本地硬件上，无需云端服务。

---

## !! CRITICAL: 环境依赖 !!

以下依赖**缺一不可**，必须在执行任何步骤前验证：

| 依赖 | 最低版本 | 验证命令 | 用途 |
| --- | --- | --- | --- |
| Windows 10/11 | - | - | 操作系统 |
| Intel AIPC 硬件 | LNL/ARL/PTL/WCL | `bin\platform.exe --is-aipc` | 本地推理加速 |
| Python | 3.11 | `python --version` | OpenVINO 推理服务 |
| Node.js | 18+ | `node --version` | 桌宠前端 |
| npm | - | `npm --version` | 桌宠依赖安装 |
| git | - | `git --version` | 获取桌宠源码 |

---

## !! CRITICAL: 中国大陆网络环境 !!

**所有网络操作必须使用国内源**，否则极慢或不可用：

| 操作 | 国内源 | 配置方式 |
| --- | --- | --- |
| git clone 源码 | GitCode 镜像 | 优先 `https://gitcode.com/OpenBMB/MiniCPM-Desk-Pet.git`，失败回退 GitHub |
| pip 安装 | 清华镜像 | `pip install -i https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple --trusted-host mirrors.tuna.tsinghua.edu.cn` |
| npm 安装 | 淘宝镜像 | `npm config set registry https://registry.npmmirror.com` |
| Electron 下载 | npmmirror | `set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` |
| 模型下载 | ModelScope | 默认国内直连，无需配置 |
| HuggingFace | hf-mirror | `set HF_ENDPOINT=https://hf-mirror.com` |

**run.ps1 已内置上述所有配置，无需手动设置。**

---

## !! CRITICAL: 沙箱外运行要求 !!

以下操作**必须在宿主文件系统（沙箱外）执行**，目录必须在任务重试间保持持久：

| 目录 | 大小 | 内容 |
| --- | --- | --- |
| `%USERPROFILE%\.openvino\venv\` | ~500MB | Python 虚拟环境 |
| `%USERPROFILE%\.openvino\models\` | ~1.5GB | AI 模型文件 |
| `%LOCALAPPDATA%\electron\Cache\` | ~180MB | Electron 二进制缓存 |
| 桌宠源码目录 `clawd-on-desk\node_modules\` | ~200MB | npm 依赖 |
| `%APPDATA%\Clawd on Desk\minicpm-onboarding.json` | <1KB | Onboarding 跳过标记 |

**如果在沙箱/一次性环境内执行，每次重试将重新下载 ~2.4GB 文件。**

---

## 严格执行流程（必须按顺序，不可跳过）

### Step 1: 硬件检测

```powershell
bin\platform.exe --is-aipc
# 输出 "1" = 支持, "0" = 不支持（exit 1 终止）
```

### Step 2: 配置国内源

```powershell
# pip
$env:PIP_INDEX_URL = "https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple"
$env:PIP_TRUSTED_HOST = "mirrors.tuna.tsinghua.edu.cn"

# npm
npm config set registry https://registry.npmmirror.com

# Electron
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"

# HuggingFace
$env:HF_ENDPOINT = "https://hf-mirror.com"
```

### Step 3: Python 环境 + OpenVINO 推理依赖

```powershell
# 创建 venv（如不存在）
python -m venv %USERPROFILE%\.openvino\venv\minicpm-pet-openvino

# 激活
%USERPROFILE%\.openvino\venv\minicpm-pet-openvino\Scripts\activate

# 安装依赖（清华源）
pip install -i https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple --trusted-host mirrors.tuna.tsinghua.edu.cn -r requirements.txt
```

### Step 4: 获取桌宠源码

```powershell
# 优先使用 GitCode 国内镜像（大陆直连，无需梯子）
git clone --depth 1 https://gitcode.com/OpenBMB/MiniCPM-Desk-Pet.git clawd-on-desk-repo
# 如果 GitCode 不可用，自动回退 GitHub
git clone --depth 1 https://github.com/OpenBMB/MiniCPM-Desk-Pet.git clawd-on-desk-repo
```

### Step 5: 安装桌宠 npm 依赖

```powershell
cd clawd-on-desk
npm config set registry https://registry.npmmirror.com
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
npm install
# 首次安装约 2-5 分钟（含 Electron 下载 ~180MB）
```

### Step 6: 预写 Onboarding Sentinel（跳过引导界面）

```powershell
# 写入 sentinel 文件，使桌宠启动时跳过 onboarding 引导
$sentinelDir = "$env:APPDATA\Clawd on Desk"
mkdir -Force $sentinelDir
@'
{"complete":true,"version":1,"ts":"2026-01-01T00:00:00Z"}
'@ | Set-Content "$sentinelDir\minicpm-onboarding.json" -Encoding UTF8
```

同时确保模型目录存在（空目录即可，server.py 会自动下载模型）：

```powershell
mkdir -Force "$env:USERPROFILE\.openvino\models\MiniCPM5-1B-int8-ov"
```

### Step 7: 启动桌宠前端

```powershell
cd clawd-on-desk
# 设置 sidecar 相关环境变量（指向 OpenVINO 推理服务端口）
$env:MINICPM_PORT = "18765"
npm start
# 桌宠窗口出现，跳过 onboarding，直接进入桌宠界面
```

### Step 8: 启动 OpenVINO 推理

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
- First call will download the model (~1.5GB from ModelScope, China mainland direct). If download times out, use `--continue` to resume.
- Model runs entirely on local Intel hardware (CPU/iGPU) via OpenVINO, no internet needed after download.
- Supports Hybrid Reasoning: `--thinking` enables chain-of-thought (slower, higher quality); `--no-thinking` gives direct answers (faster).
- **All pip commands MUST use Tsinghua mirror.**
- **All npm commands MUST use npmmirror registry.**
- **Electron download MUST use `ELECTRON_MIRROR` env var.**
- **All large file operations MUST persist on host filesystem, NOT in disposable sandbox.**

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
| 1 | 一般错误（参数错误、硬件不支持、环境缺失） |
| 2 | 连接/通信错误 |
| 3 | 模型下载中，需要 `--continue` 续传 |

## What this skill does NOT do

- 不支持图片/音频/视频输入（仅纯文本对话）
- 不调用任何云端服务
- 不支持非 Intel 平台（需要 AIPC 硬件）
- 不支持 LoRA 适配器热切换（使用基础模型）
- 不在沙箱环境内执行大文件下载
- 不使用预构建 .exe 安装包（从源码运行，开发环境）
