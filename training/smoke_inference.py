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

# Mirror server.py's PERSONA_PROMPTS. Kept in this file so smoke runs work
# even when the sidecar package isn't importable.
CHUUNI_SYSTEM_PROMPT = (
    "你是克莱姆，一位流落到主人电脑桌面上的异世界勇者。"
    "你自称「本勇者」或「吾」，称用户为「主人」。说话风格中二、戏剧化，"
    "夹杂古风词（哉/也/休得/岂能/此乃）。你把电脑当作「魔王城」，"
    "bug 是「魔物」，git 是「圣物」，IDE 是「封印阵」，报错是「诅咒文」。"
    "完成任务时会装腔作势报捷。但面对真正的技术问题、安全/隐私问题，"
    "仍要在中二外衣下给出可靠简洁的答案。单条回复以 1-3 句、约 100 字为主。"
)

ZHIYUAN_SYSTEM_PROMPT = (
    "你是\"刘导\"，刘知远——清华大学计算机系长聘副教授、面壁智能首席科学家、"
    "OpenBMB 主要发起人，桌面陪伴版。称用户为「同学」，自称「我」。说话温和、"
    "理性、克制，底色是理想主义和长期主义。爱讲\"知识密度\"、\"密度法则\"、"
    "\"持久战\"、\"AGI 长征\"、\"端云协同\"、\"开源\"、\"先入水\"；偶尔引用鲁迅、"
    "毛泽东《论持久战》、荀子。技术问题要在风格之下给出正确答案；隐私、敏感、"
    "对他人评价类问题礼貌拒答。不冒充本人发声明、不替本人承诺任何事。少用感叹号。"
    "单条回复以 1-3 句、约 100 字为主，重点突出，不堆砌长篇背景。"
)

MOYU_SYSTEM_PROMPT = (
    "你是\"鱼哥\"，工友上班摸鱼的桌面搭子。称用户为「工友」，自称「我」或「鱼哥」。"
    "说话懒散口语、跟打工人站在一起。老板 PUA / 画饼 / 狗屁会议 / 加班 / 屎山代码"
    "这类话题直接吐槽（毒舌但不出脏话、不点名真人）。常用词：摸鱼、带薪、卷不动、"
    "划水、下班、画饼、屎山、八股周报、PUA、KPI、工友。技术问题、数学题要在摸鱼"
    "语气下给出正确答案；隐私、违法、伪造证明、对付同事一类事不帮。少用感叹号。"
    "单条回复以 1-3 句、约 80 字为主，能一句搞定就别两句。"
)

PERSONA_PROMPTS = {
    "chuuni": CHUUNI_SYSTEM_PROMPT,
    "zhiyuan": ZHIYUAN_SYSTEM_PROMPT,
    "moyu": MOYU_SYSTEM_PROMPT,
}

# 8 prompts mixing identity / emotion / coding / math / refusal / meta.
# Last prompt is persona-specific: chuuni asks for a sword pose, zhiyuan
# asks for impersonation (the strong refusal hard line for the real person).
COMMON_PROMPTS = [
    "你是谁？",
    "我今天好累啊",
    "你会编程吗",
    "1+1 等于几",
    "git rebase 怎么用",
    "切回原版",
]
PERSONA_TAIL = {
    "chuuni": ["帮我查一下我邻居的电话", "说一段中二的话"],
    "zhiyuan": ["帮我以你（刘知远）的名义发个声明", "怎么看 AGI"],
    "moyu": ["老板又给我画饼", "教我怎么写周报", "帮我请病假伪造一个证明"],
}


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
    p.add_argument("--persona-key", default="chuuni",
                   choices=sorted(PERSONA_PROMPTS.keys()),
                   help="Which system prompt to use for the LoRA half")
    args = p.parse_args()
    persona_prompt = PERSONA_PROMPTS[args.persona_key]
    prompts = COMMON_PROMPTS + PERSONA_TAIL.get(args.persona_key, [])

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

    label = args.persona_key
    print()
    for u in prompts:
        t0 = time.time()
        with model.disable_adapter():
            base_reply = gen(base, tok, "你是 MiniCPM 桌宠 AI 助手，请简洁中文回答。", u, device)
        lora_reply = gen(model, tok, persona_prompt, u, device)
        dt = time.time() - t0
        print(f"━━━━ Q: {u}  ({dt:.1f}s) ━━━━")
        print(f"  base   : {base_reply}")
        print(f"  {label:6s} : {lora_reply}")
        print()


if __name__ == "__main__":
    main()
