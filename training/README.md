# LoRA 训练 — 自定义桌宠人设

Apple Silicon (MPS) 上跑 MiniCPM5-0.9B 的 LoRA persona 微调。
现成一例：`chuuni`（中二勇者克莱姆）。

## 一键复跑

```bash
cd minicpm-pet-bridge-uv

# 1) 生成数据集
uv run python ../training/generate_dataset.py
# → training/dataset/chuuni_train.jsonl + chuuni_eval.jsonl

# 2) 训练（约 9 分钟 on M5）
uv run python ../training/train_lora.py --epochs 3 --copy-to-adapters
# → training/runs/lora_chuuni_<timestamp>/
# → adapters/lora_chuuni_<timestamp>/    (--copy-to-adapters 才有)

# 3) before/after 推理对比
uv run python ../training/smoke_inference.py \
  --adapter ../adapters/lora_chuuni_<timestamp>
```

桌宠 (`bash go.sh start`) 启动时会自动发现 `adapters/` 下任意带
`adapter_config.json` 的目录并挂上。

## 关键文件

| 文件 | 作用 |
|---|---|
| `chuuni_persona.md` | 人设设定文档（system prompt、词汇表、句式） |
| `generate_dataset.py` | 手写 seeds + 模板扩增 → jsonl |
| `train_lora.py` | MPS LoRA 训练（手写 loop，不用 Trainer） |
| `smoke_inference.py` | adapter 前后效果对比 |

`dataset/` 和 `runs/` 已 gitignore（可再生）。

## 训练规格

- **设备**：Apple M5 / 16GB Unified Memory / MPS / bf16
- **稳定性**：`attn_implementation="eager"`（MPS GQA matmul kernel bug 绕过）
- **LoRA**：r=8, alpha=16, target = q/k/v/o/gate/up/down
- **数据**：~300-500 条手写 + 模板扩增
- **预算**：~30 分钟（含数据生成）
- **格式**：assistant-only loss（user/system token 的 label 设为 -100）

## 怎么训自己的人设

1. **改人设设定** — 复制 `chuuni_persona.md` → 改成自己想要的设定
2. **改数据** — 在 `generate_dataset.py` 顶部改 `SYSTEM_PROMPT` 常量，
   然后改 `IDENT / EMO / CHAT / CODE / REFUSE / ... CATCH` 这些 list
   里的种子对话。建议每个 bucket 至少 5-10 条手写。
3. **跑** — `generate_dataset.py` → `train_lora.py --copy-to-adapters`
4. **接入桌宠** — 详见根目录 `CHANGELOG.md` 或回看本 repo 之前的对话；
   主要改三处：`server.py` 加 system prompt + `PERSONA_PROMPTS` 表、
   `clawd-on-desk/src/minicpm-chat.html` 加 SYNONYMS / COMMAND_HINTS /
   few-shot。

## 不该期待什么

- **不是从零训** — 这是 LoRA 微调，不改 base 能力，只在外面套一层风格。
- **小数据有 trade-off** — 几百条样本训出来人设强烈但偶有 hallucination，
  尤其是 base 能力本来就弱的领域（如细节型 coding 命令）。要看 nekoqa 那种
  覆盖 12 类的 30K 数据集，必须搬到 H100 跑（M5 估算 10+ 小时不现实）。
- **narration 不受影响** — 桌宠的主动旁白用 `disable_adapter: true`，
  绕过 LoRA。所以新人设只影响**用户主动聊天**。
