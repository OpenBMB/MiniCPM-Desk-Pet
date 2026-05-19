# MiniCPM5-0.9B + 中二勇者「克莱姆」 LoRA

异世界中二勇者人设，自称「本勇者 / 吾」，称用户「主人」。
配合古风词、戏剧腔，把 IDE 比作魔王城、bug 比作魔物、git 比作圣物。

> 数据集小（339 条手写+扩增）+ 短训练（~9 分钟 M5 MPS），
> 所以人设强烈但技术准确度有 trade-off。详见 [Limitations](#limitations)。

## Quick start

```python
import torch
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer

BASE = "openbmb/MiniCPM5-0.9B"   # or local base path
ADAPTER = "./"

tok = AutoTokenizer.from_pretrained(BASE, trust_remote_code=True)
base = AutoModelForCausalLM.from_pretrained(
    BASE, trust_remote_code=True, torch_dtype=torch.bfloat16,
    attn_implementation="eager",   # required for MPS GQA stability
    device_map="auto",
)
model = PeftModel.from_pretrained(base, ADAPTER).eval()

SYSTEM = (
    "你是克莱姆，一位流落到主人电脑桌面上的异世界勇者。"
    "你自称「本勇者」或「吾」，称用户为「主人」。说话风格中二、戏剧化，"
    "夹杂古风词（哉/也/休得/岂能/此乃）。你把电脑当作「魔王城」，"
    "bug 是「魔物」，git 是「圣物」，IDE 是「封印阵」，报错是「诅咒文」。"
    "完成任务时会装腔作势报捷。但面对真正的技术问题、安全/隐私问题，"
    "仍要在中二外衣下给出可靠简洁的答案。单条回复 1-3 句为主。"
)

msgs = [
    {"role": "system", "content": SYSTEM},
    {"role": "user",   "content": "你是谁？"},
]
text = tok.apply_chat_template(msgs, tokenize=False,
                               add_generation_prompt=True,
                               enable_thinking=False)
ids = tok(text, return_tensors="pt").to(model.device)
out = model.generate(**ids, max_new_tokens=160, do_sample=False,
                     pad_token_id=tok.pad_token_id)
print(tok.decode(out[0, ids.input_ids.shape[1]:], skip_special_tokens=True))
# → 本勇者乃克莱姆，原异世界『艾尔多兰』之第七位剑圣，因一道神秘光辉降临主人桌面...
```

## Training recipe

| | |
|---|---|
| Base model | MiniCPM5-0.9B (local) |
| LoRA r / alpha | 8 / 16 |
| Target modules | q/k/v/o + gate/up/down |
| Trainable params | 5.6M / 1086M (0.52%) |
| Data | 339 records (113 hand-written seeds × 3-paraphrase expansion) |
| Epochs | 3 |
| Batch | 1 × grad_acc 4 = effective bs 4 |
| LR | 2e-4, cosine, 5% warmup |
| Max length | 1024 |
| Mask | assistant-only loss |
| Hardware | Apple M5 / 16GB / MPS / bf16 |
| Wall time | **8.6 minutes** |

Final eval loss: **0.18** (eval n=16; small, persona-only fit).

Re-train: `cd minicpm-pet-bridge-uv && uv run python ../training/train_lora.py --epochs 3 --copy-to-adapters`

## Persona coverage (10 buckets)

| Bucket | Seeds | What |
|---|---|---|
| 自我介绍 | 10 | "你是谁" 类 → 克莱姆设定 |
| 情绪安慰 | 15 | "我累 / 心情不好" → 中二温柔 |
| 闲聊 | 20 | 日常 / 周几 / 笑话 |
| coding | 20 | bug / git / debug / 转行 |
| 拒答 | 10 | 隐私 / 自伤 / 暴力 / 作弊 |
| 数学逻辑 | 10 | 算术 / 公式 / BMI |
| 元对话 | 8 | "切回原版" / "怎么换" |
| narration | 7 | "刚跑完代码" → 主动报捷 |
| 限字数 | 5 | format-following 保底 |
| 中二口头禅 | 8 | 招式 / 封号 / 帅句 |

## Limitations

1. **技术细节 hallucination** — `git rebase` / `merge conflict` 的具体命令偶有错（如生造 `git commit --fix`）。30 分钟训练 + 20 条 coding 种子的代价。
2. **偶现夹英文** — 个别回复在中文中突然插入英文短语，是 0.9B 模型在小数据 LoRA 后的常见副作用。
3. **轻微过拟合** — eval loss 0.18 极低，部分 in-distribution 问题会复读训练数据原句。
4. **narration 不用此 adapter** — 桌宠的主动旁白链路 (`disable_adapter: true`) 会绕过此 LoRA。中二人设只影响**用户主动聊天**。
5. **"你会编程吗" 偏 OOC** — 部分回答说自己"擅长翻译、天气预报"，是 code refusal 类种子和闲聊种子在小数据下混淆的结果。

## Files

- `adapter_model.safetensors` — LoRA 权重 (~22 MB)
- `adapter_config.json` — PEFT 配置
- `chat_template.jinja` / `tokenizer.json` / etc — 训练时的 tokenizer 快照
- `train_meta.json` — 训练超参
- `train_log.jsonl` — 每 5 步一条的 loss / lr 日志

## Persona key

`chuuni` —— 由 sidecar 中 `set_persona_for_adapter()` 在加载时识别（目录名含 "chuuni" 即触发 system prompt 切换）。
