# minicpm-sidecar

MiniCPM 桌宠的端侧推理 sidecar。基于 [OpenVINO GenAI](https://github.com/openvinotoolkit/openvino.genai)
在 Intel AIPC 上做**进程内**推理，外面包一层轻量 Python gateway（FastAPI）以保持
对 Electron 的 HTTP/SSE 契约。

## 设计

```
Electron (clawd-on-desk)
   │ HTTP/SSE :18765
   ▼
gateway (FastAPI)                       ← 本目录 gateway/
   │ openvino_genai.LLMPipeline（进程内，无子进程）
   ▼
OpenVINO IR 目录  在 <userData>/models/
```

只有一个进程。gateway 负责协议翻译（`event: start|delta|think|end|error`）、
`<think>` 块拆分、桌宠状态推送和模型目录管理；推理由 `LLMPipeline` 直接跑在
Intel GPU 或 NPU 上。

**模型是一个目录，不是单个文件**：

```
MiniCPM5-2.6B-int4-sym-g128/
  openvino_model.xml        openvino_model.bin
  openvino_tokenizer.xml    openvino_detokenizer.xml
  config.json  generation_config.json  chat_template.jinja
  .minicpm-ir.json          ← 转换脚本写的精度元数据
```

## 只支持 GPU 和 NPU

这是给 Intel AIPC 做的构建，设备白名单只有 `gpu` 和 `npu`，**没有 CPU**。
`ov::Core` 永远会报告 CPU，gateway 会把它过滤掉；没有 Intel 核显/独显也没有
NPU 的机器上，`start()` 抛一条明确的中文错误而不是让 `LLMPipeline` 抛 native 异常。

`MINICPM_DEVICE` 是跨版本持久化的，所以 `cpu` / `vulkan` / `metal` / `cuda`
这些旧值会被识别并重定向到 `gpu`（记一条 info 日志），不会把未知名字丢给
`ov::Core`。

## 一份模型，两个设备

实测（MiniCPM5-2.6B / Core Ultra 5 225H / Arc 130T / AI Boost NPU，openvino
2026.3.1、NPU 驱动 32.0.100.4778、14.9 GB 内存；同一套直连引擎的测量口径，
`enable_thinking=False`，三个 prompt 各一轮）：

| 精度 | 体积 | GPU 加载 | **GPU chunk/s** | NPU 加载 | **NPU chunk/s** |
|---|---|---|---|---|---|
| **int4-sym-g128** | **1.5 GB** | **2.3s** | **21.9 / 23.0 / 22.3** | 5.8s | 10.1 / 11.7 / 12.0 |
| int8 | 2.4 GB | 6.1s | 15.5 / 18.7 | — | ❌ 见下 |
| fp16 | 4.8 GB | 10.5s | 4.3 / 4.3 / 3.4 | 26.4s | 8.3 / 8.4 / 6.8 |

结论：

- **GPU 上 int4 最快**，比 int8 快约 1.3 倍、比 fp16 快约 **5 倍**。decode 是显存
  带宽瓶颈，而 Arc 130T 用共享系统内存，所以权重越小越快 —— 不量化不是「更准更慢一点」，
  是慢 5 倍。
- **int4 在两个设备上都能跑**，且体积最小、加载最快。所以只需要转一份。
- fp16 在 NPU 上也能跑（见下），但没有理由选它：GPU 上慢 5 倍，NPU 上慢 1.4 倍，
  还多占 3.3 GB。

> ⚠️ 未做过输出质量的正式对比，只比了速度和可用性。

### NPU 拒绝 INT8

实测（长 prompt × 256 token × 4 轮，绕过守卫直连 `LLMPipeline(ir, "NPU")`）：

| 精度 | 结果 |
|---|---|
| int4-sym-g128 | ✅ 全过 |
| fp16 | ✅ 全过 |
| **int8** | ❌ `ZE_RESULT_ERROR_OUT_OF_HOST_MEMORY`，可复现 |

三个精度**构造 `LLMPipeline` 都成功**，int8 只在第一次 `generate()` 时失败 ——
所以检查必须发生在构造之前，不能指望构造失败来兜底。

`IRPrecision.npu_ready` 因此是「**不是 int8**」而不是「只能 int4」：对称 INT4 是
OpenVINO 文档对这个尺寸的推荐配置，未压缩的 FP16 也能跑。精度**读不出来**的 IR
仍然拒绝（它可能就是 int8）。

> [openvinotoolkit/openvino#35641](https://github.com/openvinotoolkit/openvino/issues/35641)
> 报告这个组合会产生**不可捕获**的 `0xC0000005`。在本机这套版本上**没有复现** ——
> 观察到的是一个普通的、可捕获的 `RuntimeError`。但这个组合仍在文档支持矩阵之外，
> 所以继续拒绝。

默认 `MINICPM_OV_NPU_FALLBACK=1` 会在精度不合时降级到 GPU，并在
`/api/health` 的 `device_fallback` 里说明原因；设为 `0` 则硬失败。
`/api/set-device` 也做同样的检查，让拒绝变成一条可操作的报错。

> `/api/health` 的 `accel` 报的是引擎**实际**解析到的设备，不是请求的那个 ——
> 请求值另放在 `requested_device`。发生降级时 `accel` 会显示 `gpu`，
> 设置页也会跟着高亮 GPU 并显示原因。

## 目录

```
minicpm-sidecar/
  gateway/
    __main__.py         # 入口：python -m gateway --model <ir-dir> --port ...
    server.py           # FastAPI app + /api/* 路由
    openvino_client.py  # LLMPipeline 封装、精度守卫、设备发现、流式桥接
    think_filter.py     # <think>...</think> 块拆分
    clawd_state.py      # 桌宠状态推送
    lifecycle.py        # 父进程（Electron）看门狗
    log_setup.py        # 跨平台日志目录解析
  scripts/
    convert-openvino.py # HF checkpoint → OpenVINO IR
    build-gateway.sh    # PyInstaller 出 gateway 单文件
    build-gateway.ps1
    build-all.sh
    run-dev.sh
  build/gateway.spec    # PyInstaller spec
  pyproject.toml
```

## 开发态启动

```bash
# 1) 装依赖（含 OpenVINO runtime，约 100 MB）
uv sync

# 2) 把 HF checkpoint 转成 OpenVINO IR
python scripts/convert-openvino.py --source <hf-checkpoint>

# 3) 启动
MINICPM_DEVICE=gpu uv run python -m gateway --model ../models/ov/<name>
```

或者直接走仓库根的 `./go.sh`。

## 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `MINICPM_DEVICE` | `gpu` | `gpu` \| `npu`；旧的 cpu/vulkan/metal/cuda 会重定向到 gpu |
| `MINICPM_MODEL_DIR` | — | IR 目录 |
| `MINICPM_OV_NPU_FALLBACK` | `1` | NPU 精度不合时降级到 GPU；`0` 则硬失败 |
| `MINICPM_OV_NPU_SAMPLING` | `0` | 允许 NPU 上采样（默认 greedy-only） |
| `MINICPM_OV_CACHE_DIR` | 日志目录旁 | 编译缓存；不设会每次启动重编译 |
| `MINICPM_CTX` | `4096` | 上下文长度 |

## API

| 类型 | 说明 |
|------|------|
| `GET /api/health` | `backend` / `accel` / `engine` / `startup_error` |
| `POST /api/chat` (SSE) | `event: start\|think\|delta\|end\|error` |
| `POST /api/warmup` | 1-token completion，让编译缓存升温 |
| `GET /api/models` | 扫描 `<MODEL_ROOT>/**` 下的 IR 目录 |
| `POST /api/load-model` | 热切换到另一个 IR（重新编译 pipeline） |
| `GET /api/devices`, `POST /api/set-device` | 报告 / 切换 gpu\|npu |
| `GET /api/onboarding` | `model_present` / `accelerators` / `stage_hint` |
| `POST /api/state` | 手动桌宠状态推送 |
| `POST /api/classify` | stub，返回 501 |

> `/api/health` 的引擎子对象键名是 `engine`。（llama.cpp 时代叫 `llama_server`。）

## thinking 协议

MiniCPM5 的 chat template 默认 prefill `<think>\n` 让模型先做 reasoning。
一个实测出来的模型行为：**无论 prompt 怎么写，模型都会先开一个 `<think>` 块**
（给了闭合空块也照样新开）。所以 `thinking=false` 不是"不推理"，只是"不展示"，
被丢弃的推理照样花 token —— 引擎因此对隐藏推理套用与
`server.THINKING_MIN_MAX_NEW_TOKENS` 相同的预算下限，否则采样时可能在
`</think>` 出现前就耗尽配额、给用户一个空气泡。

引擎只吐 `content`，`<think>` / `</think>` 的切分全部交给 `ThinkBlockFilter`。
模板写的是 `"<think>\n"` 和 `"</think>\n\n"`，那些换行属于标签而不是内容，
filter 会跨 chunk 把它们吃掉，否则思考气泡会以空行开头。

## 打包

`build/gateway.spec` **包含** OpenVINO runtime —— 它是唯一的推理引擎。转换期依赖
（`nncf` / `optimum` / `onnx`）仍然排除：`scripts/convert-openvino.py` 把它们
shell out 到一次性 uv 环境，运行期用不到。

### 两个踩过的坑

**① `collect_submodules` 收不了原生 DLL。** OpenVINO 的 Python 包只是薄壳，引擎是
`openvino/libs/` 下 212 MB 的 DLL，设备插件（`intel_gpu_plugin`、`intel_npu_plugin`
和 78 MB 的 NPU 编译器）是**运行时按名字加载**的。用 `collect_submodules` 打出来的
二进制只有 40 MB，能启动、能响应，然后在一台有 GPU 也有 NPU 的机器上报告
「未检测到 Intel GPU 或 NPU」。必须用 `collect_all`，它才会带上 binaries 和 datas。

**② onefile 每次启动解压 300 MB。** 实测（Core Ultra 5 225H）：

| 方式 | 冷启动 | 热启动 |
|---|---|---|
| onefile（105 MB 单文件） | 18.9s | ~19s，**每次都解压约 14s** |
| **onedir（301 MB 目录）** | 12.9s | **6.1s**（其中 2.9s 是模型编译） |

桌宠在应用启动时就拉起 sidecar，14 秒的静默不可接受，所以用 onedir。
`clawd-on-desk` 通过 `extraResources` 整目录搬运，`locateSidecarBinary()`
已经会探测 `sidecar-bin/minicpm-sidecar/minicpm-sidecar[.exe]`。

### 实测产物（win-x64）

```
minicpm-sidecar/bin/win-x64/minicpm-sidecar/   301 MB   PyInstaller onedir
clawd-on-desk/dist/win-unpacked/               800 MB   Electron + sidecar
```

打包后的 sidecar 已验证：从 bundle 启动 → 探测到 gpu/npu → `/api/chat` 的
think/delta 分帧正常 → `/api/set-device` 正常。

### ⚠️ NSIS 安装包这一步在本机会失败

`win-unpacked` 能出来，但 `electron-builder` 生成 `.exe` 时会卡在 `winCodeSign`：
它下载的签名工具包里含 macOS dylib 的**符号链接**，Windows 默认不允许非管理员
创建符号链接。

```
ERROR: Cannot create symbolic link : 客户端没有所需的特权
```

跟本项目无关，是 electron-builder 在 Windows 上的通用问题。两种解法：

- 打开 **Windows 开发者模式**（设置 → 隐私和安全性 → 开发者选项），或
- 用**管理员权限**的终端跑一次 `npm run build:win:x64`

CI（`.github/workflows/`）的 runner 上没有这个限制。

## 模型转换

```bash
# 默认 preset：对称 INT4 / group-size 128，GPU 和 NPU 都能用，且最快
python scripts/convert-openvino.py --source <hf-checkpoint>

# 不量化（GPU 上慢约 5 倍，体积 3.2 倍；一般没有理由用）
python scripts/convert-openvino.py --source <ckpt> --preset fp16
```

脚本 shell out 到 `uv run --no-project --with "optimum-intel[openvino]" ...`，
所以 torch / transformers / nncf **不会进入本项目的 `.venv`**。导出到 `.partial`
再原子 rename，避免 `discover_models` 扫到半写的 IR。导出后校验四个 IR 文件齐全、
chat template 存在且含 `enable_thinking`，最后写 `.minicpm-ir.json` 供精度守卫读取。
