# Local-MiniCPM-Pet-OpenVINO

一键部署 MiniCPM 桌宠体验环境，后端采用 OpenVINO 推理引擎，在 Intel AIPC 上完全本地运行。

## 这是什么

这是一个面向 Intel AIPC 开发者的 Skill，用于快速搭建 MiniCPM 桌宠的完整体验环境：

- **前端**：MiniCPM Desk Pet（Electron 桌宠应用，从源码 `npm start` 启动）
- **后端**：OpenVINO 推理服务（FastAPI HTTP 服务，替代默认的 llama-server）
- **模型**：MiniCPM5-1B INT8 量化版（从 ModelScope 自动下载）

整个推理流程在本地 Intel 硬件上完成，无需云端服务。部署完成后，用户直接通过桌宠 UI 进行对话。

## 目录结构

```
local-minicpm-pet-openvino/
├── README.md                 ← 本文件
└── src/
    ├── SKILL.md              ← Skill 元数据 + Agent 执行指南
    ├── info.json             ← 运行时配置（venv 名称、Python 版本、内存需求、模型地址）
    ├── meta.json             ← 应用商店展示信息（名称、描述、用例标签）
    ├── requirements.txt      ← Python 依赖清单（openvino-genai, fastapi, uvicorn 等）
    └── scripts/
        ├── run.ps1           ← 部署入口：环境检测 → 依赖安装 → 启动推理服务 → 启动桌宠
        └── server.py         ← OpenVINO 推理 HTTP 服务（FastAPI，端口 18765）
```

## 工作原理

```
┌────────────────┐   HTTP :18765   ┌────────────────────┐   OpenVINO   ┌──────────┐
│  桌宠前端       │ ──────────────→ │  server.py (FastAPI)│ ──────────→ │ MiniCPM5 │
│  (Electron)    │ ←────────────── │  (常驻后台)          │ ←────────── │ INT8 模型 │
└────────────────┘                 └────────────────────┘             └──────────┘
```

1. `run.ps1` 是部署入口，依次完成：硬件检测 → 环境配置 → 依赖安装 → 服务启动 → 前端启动
2. `server.py` 作为 HTTP 推理服务常驻后台，提供 OpenAI 兼容的 `/v1/chat/completions` API
3. 桌宠前端通过 HTTP 与推理服务通信，用户直接在桌宠 UI 上聊天

## 使用方式

本 Skill 通过 AI 助手（Agent）使用，用户全程只需自然语言对话，无需手动敲命令。

### 第一步：安装 Skill

将整个 `local-minicpm-pet-openvino` 目录放入你所使用的 AI 助手的 Skills 安装目录，或通过应用市场搜索安装。

### 第二步：对助手说话

安装完成后，直接对 AI 助手说出你的需求，例如：

- "帮我部署 MiniCPM 桌宠"
- "搭建一个本地 AI 桌宠体验环境"
- "在我这台 Intel 电脑上跑一个 OpenVINO 桌宠"

助手识别到关键意图后，会自动调用本 Skill 开始部署。

### 第三步：等待部署完成，开始使用

助手会自动完成以下全部工作（无需人工干预）：

1. 判断你的网络环境（国内自动走镜像源）
2. 检测 Intel AIPC 硬件
3. 安装 Python / npm 依赖
4. 下载 AI 模型（约 1.5GB，首次）
5. 启动 OpenVINO 推理服务
6. 拉起桌宠前端窗口

部署完成后，桌宠窗口自动出现在桌面上，直接和它对话即可。

### 日常管理

部署完成后，你也可以随时对助手说：

- "停掉桌宠" / "关掉桌宠环境" → 助手会停止推理服务和前端
- "桌宠还在跑吗" / "看看桌宠状态" → 助手会检查运行状态并报告
- "重新启动桌宠" → 助手会再次部署（幂等，跳过已完成步骤，秒级启动）

## 环境要求

- Windows 10/11 + Intel AIPC 硬件（LNL/ARL/PTL/WCL）
- Python 3.11+
- Node.js 18+ / npm
- git

## API 端点（部署后可用）

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `/api/health` | GET | 健康检查（返回模型加载状态） |
| `/v1/chat/completions` | POST | OpenAI 兼容的对话推理 |
| `/api/shutdown` | POST | 优雅关闭推理服务 |

---

## 开发者 / 排障参考

> 以下内容仅供开发者手动调试或排查问题使用，普通用户无需关心。

手动调用部署脚本：

```powershell
# 部署并启动（中国大陆环境）
scripts\run.ps1 --china

# 部署并启动（海外 / 可直连环境）
scripts\run.ps1

# 查看运行状态
scripts\run.ps1 --status

# 停止所有服务
scripts\run.ps1 --stop

# 输出诊断信息（排障用）
scripts\run.ps1 --debug
```

脚本参数：

| 参数 | 说明 |
| --- | --- |
| `--china` | 锁定中国大陆镜像源（GitCode / 清华 pip / 淘宝 npm / npmmirror Electron） |
| `--status` | 查看推理服务和桌宠前端的运行状态 |
| `--stop` | 停止推理服务 + 关闭桌宠前端 |
| `--debug` | 输出详细诊断信息（见下方说明） |

`--debug` 输出内容：

| 分类 | 信息 |
| --- | --- |
| 系统 | Windows 版本、CPU 架构 |
| Python 环境 | venv 是否存在、Python 版本、openvino/fastapi 等包版本 |
| 模型 | 模型目录是否存在、文件列表及大小 |
| 推理服务 | /api/health 响应、端口 18765 占用情况（netstat） |
| 桌宠前端 | electron 相关进程名和 PID |
| 环境变量 | MINICPM_BACKEND、PIP_INDEX_URL、ELECTRON_MIRROR 等 |
| 最近日志 | 最新日志文件的最后 20 行 |

健康检查：

```powershell
curl http://127.0.0.1:18765/api/health
```

日志位置：`%USERPROFILE%\.openvino\log\`
