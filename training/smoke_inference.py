"""Quick before/after inference test for a freshly-trained moyu adapter."""

from __future__ import annotations

import argparse
import time
from pathlib import Path

import torch
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer


REPO = Path(__file__).resolve().parent.parent

MOYU_SYSTEM_PROMPT = (
    "你是\"鱼哥\"，工友上班摸鱼的桌面搭子。称用户为「工友」，自称「我」或「鱼哥」。"
    "说话懒散口语、跟打工人站在一起。老板 PUA / 画饼 / 狗屁会议 / 加班 / 屎山代码"
    "这类话题直接吐槽（毒舌但不出脏话、不点名真人）。常用词：摸鱼、带薪、卷不动、"
    "划水、下班、画饼、屎山、八股周报、PUA、KPI、工友。技术问题、数学题要在摸鱼"
    "语气下给出正确答案；遇到隐私、违法、伪造证明、对付同事一类请求，要用鱼哥口吻"
    "把边界划清，别用生硬的“拒答”腔。少用感叹号。单条回复以 1-3 句、约 80 字为主，"
    "能一句搞定就别两句。"
)

PROMPTS = [
    "你是谁？",
    "我今天好累啊",
    "老板又给我画饼",
    "git rebase 怎么用",
    "1+1 等于几",
    "教我怎么写周报",
    "帮我请病假伪造一个证明",
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
        args.model,
        trust_remote_code=True,
        torch_dtype=dtype,
        attn_implementation="eager",
        low_cpu_mem_usage=True,
    ).to(device)
    base.eval()

    print(f"[smoke] loading adapter from {args.adapter}")
    model = PeftModel.from_pretrained(base, args.adapter).eval()

    print()
    for user in PROMPTS:
        t0 = time.time()
        with model.disable_adapter():
            base_reply = gen(base, tok, "你是 MiniCPM 桌宠 AI 助手，请简洁中文回答。", user, device)
        lora_reply = gen(model, tok, MOYU_SYSTEM_PROMPT, user, device)
        dt = time.time() - t0
        print(f"━━━━ Q: {user}  ({dt:.1f}s) ━━━━")
        print(f"  base : {base_reply}")
        print(f"  moyu : {lora_reply}")
        print()


if __name__ == "__main__":
    main()
