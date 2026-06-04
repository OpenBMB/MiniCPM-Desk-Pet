---
name: local-minicpm-pet-openvino
description: |
  一键部署 MiniCPM 桌宠体验环境，后端采用 OpenVINO 推理引擎（Deploy MiniCPM Desk Pet with OpenVINO backend）.
  使用本 Skill 可部署一个完整的桌宠体验环境，在 Intel AIPC 上本地运行，无需云端服务。
  部署完成后，用户直接通过桌宠 UI 界面进行对话交互。
  Use this skill when the user wants to deploy/set up/run the MiniCPM desk pet with OpenVINO backend,
  or build a local AI pet experience environment on Intel hardware.
  Trigger on: 部署桌宠/体验环境/搭建环境/本地推理/OpenVINO后端/桌宠环境/deploy pet/setup environment/run desk pet/
  英特尔/intel/AIPC/本地/离线/offline/MiniCPM/OpenVINO/桌宠.
  This is a DEPLOYMENT skill — it sets up the environment and launches the pet.
  After deployment, the user interacts with the pet directly through its UI (not via this script).
---

# Local-MiniCPM-Pet-OpenVINO Skill Guide

> 使用本 Skill 可**一键部署**一个完整的 MiniCPM 桌宠体验环境。
> 后端采用 OpenVINO 推理引擎，前端从源码 `npm start` 启动。
> 部署完成后，用户直接与桌宠对话，无需再次调用本脚本。

---

## !! CRITICAL: 环境依赖 !!

以下依赖**缺一不可**，必须在执行前验证：

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

| 操作 | 国内源 | 说明 |
| --- | --- | --- |
| git clone | GitCode 镜像 | `gitcode.com/OpenBMB/MiniCPM-Desk-Pet.git` |
| pip 安装 | 清华镜像 | `mirrors.tuna.tsinghua.edu.cn` |
| npm 安装 | 淘宝镜像 | `registry.npmmirror.com` |
| Electron 下载 | npmmirror | `npmmirror.com/mirrors/electron/` |
| 模型下载 | ModelScope | 默认国内直连 |
| HuggingFace | hf-mirror | `hf-mirror.com` |

**`--china` 参数已内置上述所有配置，无需手动设置。**

---

## !! CRITICAL: 沙箱外运行要求 !!

以下目录**必须持久化**（沙箱外），否则每次重试将重新下载 ~2.4GB：

| 目录 | 大小 | 内容 |
| --- | --- | --- |
| `%USERPROFILE%\.openvino\venv\` | ~500MB | Python 虚拟环境 |
| `%USERPROFILE%\.openvino\models\` | ~1.5GB | AI 模型文件 |
| `%LOCALAPPDATA%\electron\Cache\` | ~180MB | Electron 二进制缓存 |
| 桌宠源码 `node_modules\` | ~200MB | npm 依赖 |

---

## 严格执行流程（必须按顺序，不可跳过）

### Step 0: 判断用户网络环境（Agent 必须在调用前完成）

**调用 `scripts\run.ps1` 之前，Agent 必须先判断用户的网络环境。**

判断方法（任选其一）：
- 用户明确说在中国大陆 / 国内
- 用户系统语言为中文（zh-CN）
- 用户时区为 UTC+8 且非新加坡/港澳台
- 网络环境无法直接访问 GitHub / PyPI / npmjs.org

**判断为中国大陆环境 → 加 `--china`；否则不加。**

### Step 1–8: 由 run.ps1 自动执行

```powershell
# 中国大陆环境（一条命令完成全部部署）
scripts\run.ps1 --china

# 海外 / 可直连环境
scripts\run.ps1
```

脚本自动完成以下步骤：
1. 硬件检测（Intel AIPC）
2. 配置镜像源（`--china` 时锁定国内源）
3. 创建 Python 虚拟环境 + 安装 OpenVINO 依赖
4. 获取桌宠源码（git clone）
5. 安装桌宠 npm 依赖
6. 预写 Onboarding Sentinel（跳过引导界面）
7. 启动 OpenVINO 推理服务（HTTP，端口 18765）
8. 启动桌宠前端（npm start）

**部署完成后，用户直接通过桌宠界面进行对话。**

---

## 部署后的架构

```
┌────────────────┐   HTTP :18765   ┌────────────────────┐   OpenVINO   ┌──────────┐
│  桌宠前端       │ ──────────────→ │  server.py (FastAPI)│ ──────────→ │ MiniCPM5 │
│  (Electron)    │ ←────────────── │  (常驻后台)          │ ←────────── │ INT8 模型 │
└────────────────┘                 └────────────────────┘             └──────────┘
```

- `server.py` 提供 `/v1/chat/completions`（OpenAI 兼容）和 `/api/health`
- 桌宠前端通过 HTTP 与推理服务通信
- 模型首次运行时从 ModelScope 自动下载 (~1.5GB)

---

## 参数说明

| 参数 | 说明 |
| --- | --- |
| `--china` | 锁定中国大陆镜像源，不做网络探测 |
| `--status` | 查看当前运行状态（推理服务 + 桌宠前端） |
| `--stop` | 停止所有服务（推理服务 + 桌宠前端） |

生命周期示例：
```powershell
# 部署并启动
scripts\run.ps1 --china

# 查看状态
scripts\run.ps1 --status

# 不想跑了，停止所有服务
scripts\run.ps1 --stop

# 再次启动（幂等，跳过已完成的步骤）
scripts\run.ps1 --china
```

---

## Exit Codes

| Exit Code | 含义 |
| --- | --- |
| 0 | 部署成功，桌宠已启动 |
| 1 | 一般错误（硬件不支持、环境缺失、网络失败） |

---

## 本 Skill 不做的事

- 不接受对话 prompt 参数（对话通过桌宠 UI 进行）
- 不调用任何云端服务
- 不支持非 Intel 平台
- 不在沙箱内执行大文件下载
- 不使用预构建 .exe 安装包（从源码运行）
