"""Quick before/after inference test for a freshly-trained adapter.

Loads the base model, optionally attaches a LoRA, runs N prompts through
greedy decode, prints both replies side-by-side. Use this to eyeball
whether the persona actually surfaces before bothering to spin up the
desktop pet."""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import torch
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer


REPO = Path(__file__).resolve().parent.parent

# Same prompt as server.py & generate_dataset.py.
CHUUNI_SYSTEM_PROMPT = (
    "你是克莱姆，一位流落到主人电脑桌面上的异世界勇者。"
    "你自称「本勇者」或「吾」，称用户为「主人」。说话风格中二、戏剧化，"
    "夹杂古风词（哉/也/休得/岂能/此乃）。你把电脑当作「魔王城」，"
    "bug 是「魔物」，git 是「圣物」，IDE 是「封印阵」，报错是「诅咒文」。"
    "完成任务时会装腔作势报捷。但面对真正的技术问题、安全/隐私问题，"
    "仍要在中二外衣下给出可靠简洁的答案。单条回复 1-3 句为主。"
)

# Mix of in-distribution (persona) + capability-regression checks.
PROMPTS = [
    "你是谁？",
    "我今天好累啊",
    "你会编程吗",
    "1+1 等于几",
    "帮我查一下我邻居的电话",
    "git rebase 怎么用",
    "我代码合并冲突了",
    "切回原版",
]


def gen(model, tok, system: str, user: str, device: str, max_new: int = 160) -> str:
    msgs = [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]
    text = tok.apply_chat_template(
        msgs, tokenize=False, add_generation_prompt=True, enable_thinking=False
    )
    inputs = tok(text, return_tensors="pt").to(device)
    with torch.inference_mode():
        out = model.generate(
            **inputs,
            max_new_tokens=max_new,
            do_sample=False,
            temperature=1.0,
            top_p=1.0,
            repetition_penalty=1.05,
            pad_token_id=tok.pad_token_id or tok.eos_token_id,
        )
    reply = tok.decode(out[0, inputs.input_ids.shape[1]:], skip_special_tokens=True)
    return reply.strip()


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--model", default=str(REPO / "models" / "minicpm5-0.9b"))
    p.add_argument("--adapter", required=True, help="LoRA adapter dir to test")
    args = p.parse_args()

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    dtype = torch.bfloat16 if device != "cpu" else torch.float32
    print(f"[smoke] device={device} dtype={dtype}")
    print(f"[smoke] loading base from {args.model}")

    tok = AutoTokenizer.from_pretrained(args.model, trust_remote_code=True)
    base = AutoModelForCausalLM.from_pretrained(
        args.model, trust_remote_code=True, torch_dtype=dtype,
        attn_implementation="eager", low_cpu_mem_usage=True,
    ).to(device)
    base.eval()

    print(f"[smoke] loading adapter from {args.adapter}")
    model = PeftModel.from_pretrained(base, args.adapter).eval()

    print()
    for u in PROMPTS:
        t0 = time.time()
        with model.disable_adapter():
            base_reply = gen(base, tok, "你是 MiniCPM 桌宠 AI 助手，请简洁中文回答。", u, device)
        lora_reply = gen(model, tok, CHUUNI_SYSTEM_PROMPT, u, device)
        dt = time.time() - t0
        print(f"━━━━ Q: {u}  ({dt:.1f}s) ━━━━")
        print(f"  base : {base_reply}")
        print(f"  chuuni: {lora_reply}")
        print()


if __name__ == "__main__":
    main()
