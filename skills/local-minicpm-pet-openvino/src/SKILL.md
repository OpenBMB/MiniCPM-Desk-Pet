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

### Step 9: 验证部署结果（Agent 必须执行）

**部署脚本执行完毕后，Agent 必须验证部署是否成功，不能直接报告"已完成"。**

验证方法：

```powershell
scripts\run.ps1 --status
```

判断标准（解析脚本输出）：
- 输出包含 `推理服务: 运行中` **且** `桌宠前端: 运行中` → 部署成功，向用户报告
- 输出包含 `推理服务: 未运行` → 部署失败，执行排障流程（见下方排障指南）
- 输出包含 `桌宠前端: 未运行` → 前端未启动，再次执行 `scripts\run.ps1` 重试

脚本在部署结束时也会输出结构化摘要，格式如下：
```
[DEPLOY_RESULT]
server_status=ok|error|timeout
server_port=18765
pet_frontend=running|not_running
model_status=loaded|downloading|error
[/DEPLOY_RESULT]
```

Agent 应解析此摘要：
- `server_status=ok` + `pet_frontend=running` → 部署成功
- `server_status=error` → 执行 `scripts\run.ps1 --debug` 获取诊断信息
- `model_status=downloading` → 模型仍在下载中，提示用户等待

如果 `--debug` 也无法定位问题，将 debug 输出展示给用户协助排查。

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
| `--debug` | 输出详细诊断信息（Python 环境、模型文件、端口、日志） |

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

## 排障指南（Agent 遇到错误时参考）

### 推理服务未运行（server_status=error 或 timeout）

1. 执行 `scripts\run.ps1 --debug` 查看诊断信息
2. 检查「Python 环境」部分：确认 openvino-genai 已安装
3. 检查「端口 18765 占用」：如果被其他进程占用，先 kill 再重试
4. 检查「最近日志」：查找 Python traceback 或 ImportError
5. 常见原因：
   - Python 依赖安装不完整 → 删除 venv 重新执行部署
   - 端口被占用 → `netstat -ano | findstr :18765` 找到 PID 并 kill
   - OpenVINO 不支持当前硬件 → 确认是 Intel AIPC（LNL/ARL/PTL/WCL）

### 桌宠前端未运行（pet_frontend=not_running）

1. 确认 Node.js 18+ 和 npm 已安装：`node --version`
2. 确认 `MINICPM_BACKEND=openvino` 环境变量已设置
3. 检查 npm install 是否成功完成（是否有 node_modules 目录）
4. 再次执行 `scripts\run.ps1`（幂等，会自动重试启动前端）
5. 如果前端卡在 onboarding 引导界面：说明 `MINICPM_BACKEND` 未正确传递，检查环境变量

### 模型下载超时（model_status=downloading）

1. 这不是错误，模型约 1.5GB，首次下载需要时间
2. 确认已使用 `--china` 参数（国内 ModelScope 直连更快）
3. 用 `scripts\run.ps1 --status` 查看推理服务是否仍在下载
4. 下载完成后推理服务会自动加载模型，无需额外操作

### 通用排障步骤

```powershell
# 1. 查看完整诊断信息
scripts\run.ps1 --debug

# 2. 停止所有服务
scripts\run.ps1 --stop

# 3. 重新部署（幂等，已完成的步骤会跳过）
scripts\run.ps1 --china

# 4. 验证
scripts\run.ps1 --status
```

日志位置：`%USERPROFILE%\.openvino\log\`

---

## 本 Skill 不做的事

- 不接受对话 prompt 参数（对话通过桌宠 UI 进行）
- 不调用任何云端服务
- 不支持非 Intel 平台
- 不在沙箱内执行大文件下载
- 不使用预构建 .exe 安装包（从源码运行）
