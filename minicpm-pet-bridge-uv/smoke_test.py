"""Cold-load the model on MPS and run a single short generation.

Usage:
    python smoke_test.py
"""

import sys
import time
from pathlib import Path

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

MODEL_DIR = Path(__file__).resolve().parent.parent / "models" / "minicpm5-0.9b"

if not (MODEL_DIR / "config.json").exists():
    sys.exit(f"Model not found at {MODEL_DIR}")

device = "mps" if torch.backends.mps.is_available() else "cpu"
dtype = torch.bfloat16 if device == "mps" else torch.float32

print(f"[smoke] loading on {device} ({dtype})...", flush=True)
t0 = time.time()
tok = AutoTokenizer.from_pretrained(str(MODEL_DIR), trust_remote_code=True)
model = AutoModelForCausalLM.from_pretrained(
    str(MODEL_DIR),
    torch_dtype=dtype,
    trust_remote_code=True,
    low_cpu_mem_usage=True,
).to(device)
model.eval()
print(f"[smoke] loaded in {time.time() - t0:.1f}s", flush=True)

messages = [
    {"role": "system", "content": "你是 MiniCPM，一只在用户桌面上陪伴的可爱桌宠。请用一句话简短回答。"},
    {"role": "user", "content": "你好，你是谁？"},
]
text = tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
print("[smoke] prompt:", repr(text)[:160], flush=True)
inputs = tok([text], return_tensors="pt").to(device)

eos = model.generation_config.eos_token_id
if isinstance(eos, int):
    eos = [eos]

t1 = time.time()
with torch.inference_mode():
    out = model.generate(
        **inputs,
        max_new_tokens=80,
        do_sample=True,
        temperature=0.6,
        top_p=0.95,
        repetition_penalty=1.05,
        eos_token_id=eos,
        pad_token_id=tok.pad_token_id or eos[0],
    )
print(f"[smoke] generated in {time.time() - t1:.1f}s", flush=True)
reply = tok.decode(out[0][inputs.input_ids.shape[1]:], skip_special_tokens=True)
print("\n=== reply ===\n" + reply.strip())
