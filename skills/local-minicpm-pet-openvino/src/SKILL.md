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

# Local-Chat Skill Guide

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
- Script auto-launches the MiniCPM Desk Pet frontend (Electron) if not already running. The pet provides the visual chat interface.

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
