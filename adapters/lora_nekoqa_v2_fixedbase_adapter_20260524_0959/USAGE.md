# MiniCPM5-1B-fixed + neko30k LoRA Adapter (v2, 4-GPU DDP rerun)

LoRA adapter trained on **neko30k** ([liumindmind/NekoQA-30K](https://huggingface.co/datasets/liumindmind/NekoQA-30K) — 30,834 cat-girl QA samples,
12 categories incl. ACG / 心理疗愈 / 创意写作 / 安全 / 数学 / 代码 / 职场),
rebuilt on **the fixed base model** at:

    /user/yanhui/share_user_long/zhaohengyu/MiniCPM5-models-fixed/official

## What changed vs v1 (2026-05-15)?

- Base model swapped to the latest **fixed** checkpoint (same architecture,
  same 1.08 B params, but with `tie_word_embeddings=False` explicitly set
  and the GGUF special-token bug fix integrated).
- Trained with 4-GPU DDP (effective batch = 32 instead of 16) → **20 min**
  vs 37 min single-GPU.
- Identical LoRA hyperparams: r=16, α=32, lr=2e-4, 2 epochs, bf16.

## Final metrics

    train/loss = 2.14
    eval/loss  = 2.18

vs v1 (single-GPU on older base):
    train/loss ≈ 2.07
    eval/loss  ≈ 2.14

→ Essentially the same convergence.

## Quick start

```python
import torch
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer

# Use the fixed base model that this adapter was trained on
BASE = "/user/yanhui/share_user_long/zhaohengyu/MiniCPM5-models-fixed/official"
ADAPTER = "./"

tok = AutoTokenizer.from_pretrained(BASE, trust_remote_code=True)
base = AutoModelForCausalLM.from_pretrained(
    BASE, trust_remote_code=True, torch_dtype=torch.bfloat16,
    attn_implementation="sdpa", device_map="auto",
)
model = PeftModel.from_pretrained(base, ADAPTER).eval()

SYSTEM = (
    "你是一只可爱的猫娘，名字叫宝宝。请用毛茸茸、撒娇、带「喵」「的说」"
    "「呜哇」等语气词的口吻，配合 (动作) 描述回应主人。"
)
msgs = [
    {"role": "system", "content": SYSTEM},
    {"role": "user",   "content": "我今天好累啊"},
]
text = tok.apply_chat_template(msgs, tokenize=False,
                               add_generation_prompt=True,
                               enable_thinking=False)
ids = tok(text, return_tensors="pt")
ids.pop("token_type_ids", None)              # Llama doesn't accept this
ids = ids.to(model.device)
out = model.generate(**ids, max_new_tokens=200, do_sample=False,
                     pad_token_id=tok.pad_token_id)
print(tok.decode(out[0, ids.input_ids.shape[1]:], skip_special_tokens=True))
```

## Files

- `adapter_model.safetensors`  LoRA weights (~22 MB)
- `adapter_config.json`        PEFT config (points to the fixed base)
- `README.md`                  PEFT auto-generated README
- `train_meta.json`            training hyperparameters used
- `capability_loss.jsonl`      24-prompt capability regression test results

## Compatibility note

`adapter_config.json` records `base_model_name_or_path` =
`/user/yanhui/share_user_long/zhaohengyu/MiniCPM5-models-fixed/official`.

If you load on a different machine, either:
1. Edit `adapter_config.json` to point at your local base path, or
2. Load the base manually first, then pass it to PeftModel:
   ```python
   base = AutoModelForCausalLM.from_pretrained("<your-base-path>", ...)
   model = PeftModel.from_pretrained(base, ADAPTER)
   ```
