# MiniCPM5 LoRA 适配器目录

桌宠 (`clawd-on-desk`) 通过 `minicpm-sidecar` 在 llama.cpp 之上做 LoRA 动态挂载。
这个目录是两份东西的容器：

1. **PEFT 训练产物**（`*.safetensors`）— 由 `training/` 下的脚本输出，作为参考与重训源。
2. **打包给 App 的 GGUF 适配器**（`*.gguf`）— llama-server 真正用的格式，会随
   electron-builder 的 `extraResources` 一起发到用户机。

不在 `adapters/` 目录里的文件、`.safetensors`、不带 `adapter_config.json` 的目录都
**不会** 被装进安装包，也不会被 sidecar 加载。

## 目录布局

```
adapters/
├── README.md                              # 本文件
├── lora_nekoqa_adapter_20260515_0738/
│   ├── adapter_model.safetensors          # PEFT 原始权重（仅参考）
│   ├── adapter_model.f16.gguf             # ← 给 llama-server 用的 GGUF（LFS）
│   ├── adapter_config.json
│   ├── USAGE.md
│   └── README.md
├── lora_chuuni_20260519_1449/...
└── lora_zhiyuan_recite_short_v9_20260519_1932/...
```

`*.gguf` 走 Git LFS（见仓库根的 [`.gitattributes`](../.gitattributes)），克隆后需要
`git lfs install` + `git lfs pull` 才能拿到真实权重。

## 从 PEFT safetensors 转成 GGUF

llama.cpp 只认 GGUF 格式的 LoRA。`minicpm-sidecar/third_party/llama.cpp/convert_lora_to_gguf.py`
（vendor 在 `scripts/clone-llama.sh` pin 的版本里）会把 PEFT 适配器 + 一份只读的 HF
base config 拼成 llama-server 能消费的单文件 GGUF。

```bash
# 1. 准备好一份 HF base 模型目录（只用 config + tokenizer，不需要权重文件）
BASE=/path/to/MiniCPM5-0.9B-hf-fp16   # 含 config.json / tokenizer / model.safetensors.index.json
ADAPTER=adapters/lora_nekoqa_adapter_20260515_0738

# 2. 跑转换脚本（需要一个带 torch + transformers 的 venv，
#    本仓库的 minicpm-pet-bridge-uv/.venv 即可）
minicpm-pet-bridge-uv/.venv/bin/python3 \
  minicpm-sidecar/third_party/llama.cpp/convert_lora_to_gguf.py \
  --base "$BASE" \
  --outtype f16 \
  --outfile "$ADAPTER/adapter_model.f16.gguf" \
  "$ADAPTER"
```

输出：`adapter_model.f16.gguf`（约 21 MB，336 个 tensor）。

### Base 必须对齐

`adapter_config.json` 里 `base_model_name_or_path` 指向训练时用的 checkpoint
（比如内部 `0513_job_349699_step_300_mathrl1_from_0.9B-0512-sft`，**不是**
公开的 `openbmb/MiniCPM5-0.9B`）。如果 `--base` 用的 HF 模型与训练 base 不
是同一个 checkpoint，人格效果会明显变弱。

实务上：只要架构与维度一致（MiniCPM5 0.9B `LlamaForCausalLM`、`hidden_size=1536`
等），转换会成功，推理也能跑，但人格强度需要 smoke test 验证。

### 量化版本兼容

LoRA 是 F16 增量，base 可以是 Q4_K_M、Q8_0 或 F16。实测过 `MiniCPM5-0.9B-Q8_0.gguf`
+ `adapter_model.f16.gguf`：

```bash
llama-server \
  -m MiniCPM5-0.9B-Q8_0.gguf \
  --lora adapters/lora_nekoqa_adapter_20260515_0738/adapter_model.f16.gguf \
  --jinja --no-webui
```

→ 「我今天好累啊」回复带 `(动作)` 描述 + 喵语尾，人格保真。

## App 是怎么加载这些文件的？

详细协议见 [`minicpm-sidecar/README.md` 的 LoRA 适配器协议章节](../minicpm-sidecar/README.md#lora-适配器协议)。要点：

- 用户机上文件最终落在 `<userData>/adapters/`（macOS 是
  `~/Library/Application Support/Clawd on Desk/adapters/`）
- App 首次启动会把 `<resources>/adapters/*.gguf` seed 进去（已存在则跳过）
- sidecar 启动时把所有 `*.gguf` 通过 `llama-server --lora` 预加载，切换是
  per-request 的 `lora: [{id, scale}]` 注入，无锁、无延迟
- Settings → 🐾 MiniCPM → 人格 LoRA 提供单选 UI + 「打开 adapters 目录」入口

## 添加新人格的最小步骤

1. 训练 PEFT LoRA，得到 `adapter_model.safetensors` + `adapter_config.json`
2. 跑上面的 `convert_lora_to_gguf.py` 转出 `adapter_model.f16.gguf`
3. 把整个目录放进 `adapters/`（命名规范 `lora_<人格>_<日期>_<时间>/`）
4. 在 [`minicpm-sidecar/gateway/server.py`](../minicpm-sidecar/gateway/server.py)
   的 `PERSONA_HINTS` 字典里把文件名关键字映射到人格 slug（用于 UI 上的徽章 +
   旁白人格识别）
5. 提交时记得 `.gguf` 自动走 LFS（已配置）
