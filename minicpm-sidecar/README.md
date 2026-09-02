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
llama-server (原生 C++)                 ← 官方 llama.cpp release 产物
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
  llama-server(.exe)      ← 官方 llama.cpp release 产物
  <runtime libs ...>
```

Electron 只 spawn `minicpm-sidecar`，由 gateway 自己 fork 出 `llama-server`。

## 目录

```
<repo-root>/
  llama.cpp/                  # git submodule（ggml-org/llama.cpp @ b9371，用于源码追踪 / 手动 fallback）

minicpm-sidecar/
  gateway/                  # FastAPI gateway 源码
    __main__.py             # 入口：python -m gateway --model ... --port ...
    server.py               # FastAPI app + /api/* 路由
    llama_client.py         # llama-server 子进程管理 + OpenAI streaming
    think_filter.py         # <think>...</think> 块拆分（从旧 bridge 移植）
    clawd_state.py          # 桌宠状态推送（从旧 bridge 移植）
    updater.py              # GGUF 模型下载/校验
    log_setup.py            # 跨平台日志目录解析
  scripts/
    fetch-llama-release.sh  # 下载官方 llama.cpp release（mac/linux）
    fetch-llama-release.ps1 # 下载官方 llama.cpp release（windows）
    build-llama.sh          # 手动 fallback：本地 cmake 编 llama-server（mac/linux）
    build-llama.ps1         # 手动 fallback：本地 cmake 编 llama-server（windows）
    build-gateway.sh        # PyInstaller 出 gateway 单文件
    build-gateway.ps1       # Windows PyInstaller 出 gateway 单文件
    build-all.sh            # 一键：下载官方 llama-server + 编 gateway
    run-dev.sh              # 本地开发：直接启动 gateway，由它拉 llama-server
  build/
    gateway.spec            # PyInstaller spec（gateway 用）
  pyproject.toml            # uv 项目，仅 fastapi/uvicorn/httpx/huggingface_hub
  .python-version
```

## 开发态启动

```bash
# 1) 第一次：下载官方 llama.cpp release 里的 llama-server
./scripts/fetch-llama-release.sh

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

## Official llama.cpp Release

CI 和默认本地构建不再编译 `llama.cpp`，而是直接下载官方
[`ggml-org/llama.cpp` b9371 release](https://github.com/ggml-org/llama.cpp/releases/tag/b9371)
里的 `llama-server` 二进制。MiniCPM5 tokenizer 支持已经随
[PR #23384](https://github.com/ggml-org/llama.cpp/pull/23384) 进入上游。

`llama.cpp` 仍作为仓库顶层 git submodule pin 在同一 release，用于源码追踪和
极端情况下的手动本地 fallback；它不再是 CI 出包路径的一部分。

升级到新的官方 release 时：

1. 更新 `LLAMA_CPP_RELEASE` 默认值（`fetch-llama-release.*`）并确认官方 release assets 命名。
2. `cd llama.cpp && git fetch origin <tag> && git checkout <tag>`，然后在仓库根 `git add llama.cpp`。
3. 跑一次 `./scripts/build-all.sh`。
4. 用 golden prompt 对一遍 token 与中文输出，与旧 HF 模型对齐。

## OpenVINO 后端（Intel AIPC，可选）

llama.cpp 没有 NPU 后端，所以在 Intel Core Ultra 机器上默认路径只能用到
CPU 和实验性的 Vulkan iGPU。`--backend openvino` 换成
`openvino_genai.LLMPipeline` 在**进程内**推理，可以选 CPU / GPU / NPU。

```bash
# 1) 装可选依赖（默认 `uv sync` 不会装）
uv sync --extra openvino

# 2) 把 HF checkpoint 转成 OpenVINO IR
python scripts/convert-openvino.py --source <hf-checkpoint> --preset gpu   # INT8
python scripts/convert-openvino.py --source <hf-checkpoint> --preset npu   # 对称 INT4

# 3) 启动
MINICPM_BACKEND=openvino MINICPM_DEVICE=gpu \
  uv run python -m gateway --model ../models/ov/<name>
```

Electron 侧同样只需 `MINICPM_BACKEND=openvino`（会跳过只会下 GGUF 的
onboarding 向导，并改用源码态 sidecar —— 见下方"打包"）。

### ⚠️ NPU 只接受对称 INT4

把 INT8 IR 交给 NPU **不会报错**：`LLMPipeline(ir, "NPU")` 静默接受，然后在
`generate()` 里以不可捕获的 `0xC0000005` 杀死整个进程 —— 没有 traceback，
没有日志（[openvino#35641](https://github.com/openvinotoolkit/openvino/issues/35641)）。

因此 `openvino_client` 在构造 pipeline **之前**就校验 IR 精度，并且**失败时从严**：
精度无法确定的 IR 一律视为不安全。默认 `MINICPM_OV_NPU_FALLBACK=1` 会降级到
GPU 并在 `/api/health` 的 `device_fallback` 里说明原因；设为 `0` 则硬失败。

### 与 llama.cpp 后端的差异

| | llama.cpp | openvino |
|---|---|---|
| 模型形态 | 单个 `.gguf` 文件 | **目录**（`openvino_model.xml` + `.bin` + tokenizer 对） |
| 子进程 | 有（llama-server） | 无，进程内；`port` 恒为 0，`lifecycle.py` 不适用 |
| LoRA adapter | 支持 | 不支持，`/api/load-adapter` 返回 501 |
| 设备 | metal / cuda / vulkan / cpu | cpu / gpu / npu |
| `<think>` 拆分 | llama-server 预拆到 `reasoning_content` | 引擎只吐 `content`，由 `ThinkBlockFilter` 拆 |

一个实测出来的模型行为，两个后端都受影响但只有 OV 需要额外处理：**MiniCPM5
无论 prompt 怎么写都会先开一个 `<think>` 块**（给了闭合空块也照样新开）。所以
`thinking=false` 不是"不推理"，只是"不展示"，被丢弃的推理照样花 token —— 引擎
因此对隐藏推理套用与 `server.THINKING_MIN_MAX_NEW_TOKENS` 相同的预算下限，
否则采样时可能在 `</think>` 出现前就耗尽配额、给用户一个空气泡。

### 打包

`build/gateway.spec` 的 `excludes` **显式排除** openvino 系列。函数内 lazy
import 挡不住 PyInstaller —— 它的 modulegraph 是静态 AST 遍历，函数体里的
import 一样会被收进去；而两个 build 脚本共用同一个 `.venv`，跑过一次
`--extra openvino` 之后再打包就会静默塞进约 400 MB。

代价是**冻结的 sidecar 二进制跑不了 OV 后端**，这是刻意的：
`clawd-on-desk/src/minicpm-chat.js` 在 `MINICPM_BACKEND=openvino` 时会优先走
源码 + `.venv`，而不是给用户一个无从下手的 ImportError。

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

- gateway 默认不预加载 LoRA；只有当前激活的 adapter 会随 `llama-server --lora` 启动。
- "激活"是 gateway 内存里的单值 `current_adapter`，每次请求通过 `lora` 字段显式选择 adapter scale。
- 每次 `POST /api/chat` 时，根据当前激活 adapter + 请求体的 `disable_adapter` 注入 OpenAI 请求体的 `lora: [...]` 字段（PR #10994）：

| `disable_adapter` | active adapter | 注入到 llama-server 的 `lora` |
|------|------|------|
| `false`（默认） | 无 | `[]`（显式禁用所有 adapter，走 base） |
| `false` | `lora_neko.gguf` | `[{"id": 0, "scale": 1.0}]` |
| `true` | 任意 | `[]`（本次请求显式禁用所有 adapter，桌宠旁白用） |

这样主对话和旁白可以并发，不会因为全局 scale 切换产生人格污染。

- 用户切换到某个 `.gguf` LoRA 时，gateway 会重启 llama-server（~2-4s）并只加载该 adapter；切回 Base 时也会重启一次来释放 LoRA 内存。
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
