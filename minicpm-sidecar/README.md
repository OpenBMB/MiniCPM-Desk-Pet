# minicpm-sidecar

MiniCPM 桌宠的端侧推理 sidecar。基于 [llama.cpp](https://github.com/ggml-org/llama.cpp) 的 `llama-server` 提供 GGUF 推理，外面包一层轻量 Python gateway（FastAPI）以保持对 Electron 的现有 HTTP/SSE 契约不变。

> 本目录取代了旧的 `minicpm-pet-bridge/` 与 `minicpm-pet-bridge-uv/`。它们已被标记为 deprecated，仅用于历史追溯。

## 设计

```
Electron (clawd-on-desk)
   │ HTTP/SSE :18765
   ▼
gateway (FastAPI, 无 torch)             ← 本目录 gateway/
   │ HTTP :18766 OpenAI-compat (stream)
   ▼
llama-server (原生 C++)                 ← third_party/llama.cpp 构建产物
   │
   ▼
*.gguf  在 <userData>/models/
```

为什么拆两段：

- `llama-server` 已经是上游成熟的 OpenAI 兼容服务器，但它的协议是 OpenAI SSE（`event: data\n` 风格、`choices[].delta.content`），与 Electron UI 现有的 `event: start|delta|think|end|error` 自定义 SSE 不兼容。
- gateway 负责协议翻译、`<think>` 块拆分、桌宠状态推送、`/api/update-apply` 流程、模型/适配器目录管理等 Electron 端已经依赖的接口。

打包后两个二进制都放在 `clawd-on-desk` 的 `resources/sidecar-bin/`：

```
sidecar-bin/
  minicpm-sidecar(.exe)   ← gateway，PyInstaller 出
  llama-server(.exe)      ← llama.cpp 编译产物
  <runtime libs ...>
```

Electron 只 spawn `minicpm-sidecar`，由 gateway 自己 fork 出 `llama-server`。

## 目录

```
minicpm-sidecar/
  gateway/                  # FastAPI gateway 源码
    __main__.py             # 入口：python -m gateway --model ... --port ...
    server.py               # FastAPI app + /api/* 路由
    llama_client.py         # llama-server 子进程管理 + OpenAI streaming
    think_filter.py         # <think>...</think> 块拆分（从旧 bridge 移植）
    clawd_state.py          # 桌宠状态推送（从旧 bridge 移植）
    updater.py              # GGUF 模型下载/校验
    log_setup.py            # 跨平台日志目录解析
  third_party/
    llama.cpp/              # 由 scripts/clone-llama.sh 克隆（vendor 版）
  scripts/
    clone-llama.sh          # git clone 指定 PR 提交到 third_party/llama.cpp
    build-llama.sh          # cmake 编 llama-server（mac/linux）
    build-llama.ps1         # 同上（windows）
    build-gateway.sh        # PyInstaller 出 gateway 单文件
    build-all.sh            # 一键：clone + 编 llama + 编 gateway
    run-dev.sh              # 本地开发：直接启动 gateway，由它拉 llama-server
  build/
    gateway.spec            # PyInstaller spec（gateway 用）
  pyproject.toml            # uv 项目，仅 fastapi/uvicorn/httpx/huggingface_hub
  .python-version
```

## 开发态启动

```bash
# 1) 第一次：克隆 vendor 分支并编 llama-server
./scripts/clone-llama.sh
./scripts/build-llama.sh

# 2) 安装 gateway 依赖（瘦小，几十 MB）
uv sync

# 3) 启动 gateway（它会自动拉起 llama-server）
./scripts/run-dev.sh --model /path/to/minicpm5.gguf
```

或者直接走仓库根的 `./go.sh`（已改造为新流程）。

## 生产构建

```bash
./scripts/build-all.sh
# 产物：
#   bin/<os>-<arch>/minicpm-sidecar(.exe)
#   bin/<os>-<arch>/llama-server(.exe)
# 之后由 clawd-on-desk/package.json 的 extraResources 自动打入安装包
```

## Vendor 分支

当前 `llama-server` 编自 [zhangtao2-1/llama.cpp](https://github.com/zhangtao2-1/llama.cpp) 的 MiniCPM5 tokenizer 适配提交（[PR #23384](https://github.com/ggml-org/llama.cpp/pull/23384)）。

PR 已根据 maintainer 反馈关闭，长期会合到 `ggml-org/llama.cpp` 主线后切换。upstream 合并后：

1. 把 `scripts/clone-llama.sh` 里的 `REMOTE` 改回 `https://github.com/ggml-org/llama.cpp.git`，`REF` 改成对应 tag。
2. 跑一次 `./scripts/build-all.sh`。
3. 用 golden prompt 对一遍 token 与中文输出，与旧 HF 模型对齐。

## API

gateway 对 Electron 暴露下列端点（保持与旧 bridge 完全兼容）：

| 类型 | 状态 | 说明 |
|------|------|------|
| `GET /api/health` | ok | 包装 llama-server health + 报告 backend |
| `POST /api/chat` (SSE) | ok | OpenAI stream → 自定义 SSE + ThinkBlockFilter |
| `POST /api/warmup` | ok | 1-token completion，让 mmap/KV cache 升温 |
| `GET /api/models` | ok | 扫描 `<MODEL_ROOT>/**/*.gguf` |
| `POST /api/load-model` | ok | 重启 llama-server 子进程指向新 gguf |
| `GET /api/devices`, `POST /api/set-device` | ok | 报告 metal/cuda/cpu backend |
| `GET /api/onboarding` | ok | model_present / stage_hint |
| `GET /api/update-check`, `POST /api/update-apply` | ok | GGUF 增量下载 |
| `POST /api/state` | ok | 手动桌宠状态推送 |
| `GET /api/adapters` | ok | 扫描 `<MINICPM_ADAPTER_DIR>/**/*.gguf`，返回 `{items, current, current_name, adapter_dir}` |
| `POST /api/load-adapter` | ok | 切换全局激活 LoRA（`{path}`，`null` 卸载）；新文件会触发 llama-server 子进程重启 |
| `POST /api/classify` | stub | v1 返回 501 |

字段细节参见 [`gateway/server.py`](gateway/server.py)。

### LoRA 适配器协议

- 启动时 gateway 扫描 `MINICPM_ADAPTER_DIR`（或默认 `<userData>/adapters/`、dev 下 `<repo>/adapters/`）并把每个 `*.gguf` 通过 `llama-server --lora` 全部预加载。
- "激活"是 gateway 内存里的单值 `current_adapter`，并不直接修改 llama-server 的全局 scale。
- 每次 `POST /api/chat` 时，根据当前激活 adapter + 请求体的 `disable_adapter` 注入 OpenAI 请求体的 `lora: [...]` 字段（PR #10994）：

| `disable_adapter` | active adapter | 注入到 llama-server 的 `lora` |
|------|------|------|
| `false`（默认） | 无 | （不发字段，走 base） |
| `false` | `lora_neko.gguf` | `[{"id": 0, "scale": 1.0}]` |
| `true` | 任意 | `[]`（本次请求显式禁用所有 adapter，桌宠旁白用） |

这样主对话和旁白可以并发，不会因为全局 scale 切换产生人格污染。

- 用户拖入新 `.gguf` 后，下一次 `POST /api/load-adapter` 会触发 llama-server 重启（~2-4s）并把新文件加进 `--lora` 列表；后续在已加载 adapter 间切换是纯内存变更，零开销。
- 适配器持久权重格式必须是 GGUF。从 PEFT safetensors 转换的脚本与示例在 [`adapters/README.md`](../adapters/README.md)。

## 与 llama-server 的 thinking 协议

MiniCPM5 的 chat template 默认会 prefill `<think>\n` 让模型先做 reasoning。
本 gateway 通过 OpenAI 请求体的 `chat_template_kwargs.enable_thinking`
字段把客户端 `thinking` 标志透传给 llama-server：

| 客户端 `thinking` | llama-server | gateway 输出 |
|------|------|------|
| `true`  | 走 `<think>` 模板，reasoning 落到 `delta.reasoning_content` | `event: think` 帧 + `event: delta` 帧 |
| `false` | 跳过 `<think>` 模板，所有 token 都落到 `delta.content` | 仅 `event: delta` 帧 |

这是 v0.7 PyTorch sidecar `enable_thinking` 的等价语义，旧 UI 行为完全保持。
ThinkBlockFilter 仍然挂在 `content` 流路径上作为 safety net，应对未来切到
非 MiniCPM5 模型时 `<think>` 标签泄漏到 content 的情况。

## 实测性能（M4 Pro / 18 GB / Metal）

- Q4_K_M (657 MB) 加载到就绪：~4 秒
- 推理速度：~198 tok/s
- `/api/warmup` 往返：~20 ms（命中 prompt cache）
- `/api/load-model` 热切换（Q4_K_M → Q8_0）：~3 秒，包括关旧 / 起新 / 健康轮询

