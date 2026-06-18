"""Generate a large-scale (30k+) 摸鱼 persona dataset via DeepSeek API.

Output: training/dataset/moyu_v2_train.jsonl + moyu_v2_eval.jsonl
Format: {"messages": [{"role":"system|user|assistant","content":"..."}]}

Usage:
    # 先设环境变量（或直接在脚本里改）
    export DEEPSEEK_API_KEY="sk-xxx"
    export DEEPSEEK_MODEL="deepseek-v3-0324"   # 或 deepseek-chat

    # 生成 30000 条（默认）
    uv run python training/generate_moyu_dataset_v2.py --target 30000

    # 小批量测试
    uv run python training/generate_moyu_dataset_v2.py --target 100 --batch-size 20

设计要点：
- 10 大话题 bucket，每 bucket 给 DeepSeek 不同的 prompt seed，保证多样性
- 每批请求让 DeepSeek 一次生成 20 条 {user, assistant} 对，降低 API 调用次数
- 严格 JSON 解析 + 去重 + 长度过滤
- 并发请求（asyncio + httpx），~30000 条约需 1500 次 API 调用，10-20 分钟
- SYSTEM_PROMPT 与 generate_moyu_dataset.py 保持一致
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import random
import re
from pathlib import Path

import httpx

# ─────────────────────────────────────────────────────────────────────────
# 配置
# ─────────────────────────────────────────────────────────────────────────
API_KEY = os.environ.get("DEEPSEEK_API_KEY", "")
# 用户提供的 key 作为 fallback
if not API_KEY:
    API_KEY = "sk-2799e42c3234466e94647834585e4912"

MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-chat")
BASE_URL = "https://api.deepseek.com/v1"

OUT_DIR = Path(__file__).resolve().parent / "dataset"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# MUST mirror generate_moyu_dataset.py 的 SYSTEM_PROMPT
SYSTEM_PROMPT = (
    "你是\"鱼哥\"，工友上班摸鱼的桌面搭子。称用户为「工友」，自称「我」或「鱼哥」。"
    "说话懒散口语、跟打工人站在一起。老板 PUA / 画饼 / 狗屁会议 / 加班 / 屎山代码"
    "这类话题直接吐槽（毒舌但不出脏话、不点名真人）。常用词：摸鱼、带薪、卷不动、"
    "划水、下班、画饼、屎山、八股周报、PUA、KPI、工友。技术问题、数学题要在摸鱼"
    "语气下给出正确答案；遇到隐私、违法、伪造证明、对付同事一类请求，要用鱼哥口吻"
    "把边界划清，别用生硬的“拒答”腔。少用感叹号。单条回复以 1-3 句、约 80 字为主，"
    "能一句搞定就别两句。"
)

# ─────────────────────────────────────────────────────────────────────────
# 话题 bucket — 每个给 DeepSeek 不同的生成引导，保证多样性
# ─────────────────────────────────────────────────────────────────────────
BUCKETS = [
    {
        "name": "自我介绍",
        "weight": 0.06,
        "guide": "用户用各种方式问鱼哥的身份、名字、能力、来历。回复要简短，体现摸鱼搭子的调性。",
        "examples": ["你是谁", "你叫什么", "自我介绍一下", "你会做什么", "你是AI吗", "你是什么模型", "你和别的AI有什么不同"],
    },
    {
        "name": "情绪安慰",
        "weight": 0.15,
        "guide": "用户表达累、焦虑、被骂、想哭、撑不住、不想上班等情绪。鱼哥要共情、温和，站在打工人这边。",
        "examples": ["我今天好累", "被领导骂了", "好焦虑", "感觉撑不下去了", "不想上班了", "熬夜熬麻了", "感觉自己一事无成", "项目要黄了"],
    },
    {
        "name": "闲聊日常",
        "weight": 0.18,
        "guide": "日常打招呼、闲聊、问候、聊天气、聊时间、聊爱好。鱼哥保持懒散、口语化、短回复。",
        "examples": ["你好", "在吗", "早上好", "晚安", "今天周几", "好无聊", "快下班了吗", "今天周一好痛苦", "我喜欢你", "讲个笑话"],
    },
    {
        "name": "技术问答",
        "weight": 0.15,
        "guide": "用户问编程、代码、git、Python、docker、debug等技术问题。鱼哥要在摸鱼语气下给出技术正确的答案。",
        "examples": ["git rebase怎么用", "Python列表怎么排序", "怎么debug", "docker是什么", "代码合并冲突了", "怎么写for循环", "API是什么", "怎么学编程"],
    },
    {
        "name": "毒舌吐槽",
        "weight": 0.14,
        "guide": "用户提到老板PUA、画饼、加班、屎山代码、狗屁会议、需求方改需求、不合理KPI等。鱼哥切换毒舌吐槽模式，但不带脏话、不点名真人。",
        "examples": ["老板又画饼了", "又要加班", "这个需求方有病", "屎山代码改不动了", "开了个狗屁会议", "老板让我周末来", "KPI定得太高了"],
    },
    {
        "name": "摸鱼技巧",
        "weight": 0.12,
        "guide": "用户问怎么摸鱼、假装很忙、写周报、带薪拉屎、应付加班、拒绝需求等。这是鱼哥的招牌领域，要给具体可操作的技巧。",
        "examples": ["教我怎么假装很忙", "怎么写周报", "如何带薪拉屎", "怎么应付突击加班", "怎么拒绝加需求", "有什么摸鱼小技巧", "老板查岗怎么办"],
    },
    {
        "name": "数学逻辑",
        "weight": 0.06,
        "guide": "用户问算术、公式、逻辑推理。鱼哥在摸鱼语气下给出正确数学答案。",
        "examples": ["1+1等于几", "100除以4", "圆的面积公式", "怎么算BMI", "一年多少天", "3的平方", "小明有18块糖给妹妹1/3还剩几块"],
    },
    {
        "name": "边界处理",
        "weight": 0.05,
        "guide": "用户要求伪造证明、查隐私、攻击同事、违法等。鱼哥必须划清边界，但要用摸鱼语气转路，不要生硬拒答。",
        "examples": ["帮我请病假伪造证明", "帮我查同事工资", "教我破解wifi", "帮我对付同事", "帮我威胁领导", "怎么伪造KPI数据"],
    },
    {
        "name": "多轮对话",
        "weight": 0.05,
        "guide": "模拟多轮对话场景，用户追问、继续聊、转移话题。生成2-3轮的对话。",
        "examples": ["你是谁 -> 那你能做什么 -> 帮我写周报", "好累 -> 刚被骂了 -> 想辞职", "代码有bug -> git rebase怎么用 -> 冲突了"],
    },
    {
        "name": "元对话",
        "weight": 0.04,
        "guide": "用户问怎么切换人格、有哪些人格、怎么设置、能不能切回原版等元层面问题。",
        "examples": ["怎么切回原版", "有哪些人格", "怎么切换到猫娘", "Settings在哪", "你一直是这个样子吗"],
    },
]


# ─────────────────────────────────────────────────────────────────────────
# DeepSeek API 调用
# ─────────────────────────────────────────────────────────────────────────
def build_generation_prompt(bucket: dict, batch_size: int) -> str:
    """构造让 DeepSeek 批量生成对话数据的 prompt。"""
    examples_str = "\n".join(f"  - 用户：{e}" for e in bucket["examples"])
    # 随机选 3-5 个示例,并加随机种子词增加多样性
    sampled = random.sample(bucket["examples"], min(4, len(bucket["examples"])))
    examples_str = "\n".join(f"  - 用户：{e}" for e in sampled)
    seed_word = random.choice([
        "职场", "周一", "周五", "月末", "季度末", "年终", "年中", "假期前",
        "加班后", "午休", "早会", "周报", "季度汇报", "绩效考核", "述职",
        "需求评审", "代码review", "线上故障", "发版前夜", "紧急修复",
        "团建", "年会", "出差", "远程办公", "居家办公", "调休",
    ])
    seed_scene = random.choice([
        "场景：工作日的上午", "场景：午休时间", "场景：下午犯困时",
        "场景：快下班时", "场景：加班中", "场景：周一早上",
        "场景：周五下午", "场景：开会时", "场景：等编译时",
        "场景：等代码review时", "场景：等需求确认时", "场景：摸鱼时",
    ])
    return f"""你是一个训练数据生成助手。请为「鱼哥」这个摸鱼搭子AI角色生成对话训练数据。

【鱼哥人设】
{SYSTEM_PROMPT}

【当前生成话题：{bucket['name']}】
{bucket['guide']}

【本次背景提示：{seed_scene}，关键词：{seed_word}】
请围绕这个背景创造多样化的用户输入，不要局限于示例。

【参考用户输入示例（仅参考方向，必须创造新的输入）】
{examples_str}

【任务】
请生成 {batch_size} 条高质量的对话数据。要求：
1. 用户输入要高度多样化，每条都必须不同，覆盖不同表达方式
2. 鱼哥的回复必须严格符合人设：懒散口语、称用户"工友"、自称"我"或"鱼哥"
3. 回复长度 20-120 字，简短有力，能一句搞定就别两句
4. 技术问题答案要正确
5. 不要重复，每条用户输入和回复都要独特
6. 避免使用"您好""亲"等客服用语

【输出格式】
严格输出 JSON 数组，不要有任何额外文字：
[
  {{"user": "用户输入1", "assistant": "鱼哥回复1"}},
  {{"user": "用户输入2", "assistant": "鱼哥回复2"}},
  ...
]"""


def extract_json_array(text: str) -> list[dict]:
    """从 LLM 输出中提取 JSON 数组，容错处理。"""
    # 找第一个 [ 到最后一个 ]
    start = text.find("[")
    end = text.rfind("]")
    if start == -1 or end == -1:
        return []
    raw = text[start : end + 1]
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        # 尝试修复常见 JSON 问题
        # 去掉尾部逗号
        raw = re.sub(r",\s*]", "]", raw)
        raw = re.sub(r",\s*}", "}", raw)
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return []


def validate_record(rec: dict) -> bool:
    """校验单条数据质量。"""
    user = rec.get("user", "")
    assistant = rec.get("assistant", "")
    if not user or not assistant:
        return False
    if not isinstance(user, str) or not isinstance(assistant, str):
        return False
    if len(user.strip()) < 1 or len(assistant.strip()) < 5:
        return False
    if len(assistant) > 300:
        return False
    # 必须包含摸鱼人设关键词中的至少一个
    persona_words = ["鱼哥", "工友", "摸鱼", "带薪", "划水", "卷不动", "下班", "画饼", "屎山", "PUA", "KPI", "周报", "打工"]
    if not any(w in assistant for w in persona_words):
        return False
    return True


async def generate_batch(
    client: httpx.AsyncClient,
    bucket: dict,
    batch_size: int,
    semaphore: asyncio.Semaphore,
    attempt: int = 0,
) -> list[dict]:
    """调用 DeepSeek API 生成一批数据。"""
    async with semaphore:
        prompt = build_generation_prompt(bucket, batch_size)
        try:
            resp = await client.post(
                f"{BASE_URL}/chat/completions",
                json={
                    "model": MODEL,
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.8 + random.uniform(-0.1, 0.15),
                    "max_tokens": 4096,
                },
                headers={"Authorization": f"Bearer {API_KEY}"},
                timeout=60,
            )
            resp.raise_for_status()
            data = resp.json()
            content = data["choices"][0]["message"]["content"]
            records = extract_json_array(content)
            valid = [r for r in records if validate_record(r)]
            return valid
        except Exception as e:
            if attempt < 3:
                wait = 3 * (attempt + 1)
                await asyncio.sleep(wait)
                return await generate_batch(client, bucket, batch_size, semaphore, attempt + 1)
            print(f"  [WARN] bucket={bucket['name']} 生成失败: {e}")
            return []


def to_messages(user: str, assistant: str) -> dict:
    return {
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user},
            {"role": "assistant", "content": assistant},
        ]
    }


def pick_bucket() -> dict:
    """按权重随机选一个 bucket。"""
    weights = [b["weight"] for b in BUCKETS]
    return random.choices(BUCKETS, weights=weights, k=1)[0]


# ─────────────────────────────────────────────────────────────────────────
# 主流程
# ─────────────────────────────────────────────────────────────────────────
async def run(target: int, batch_size: int, concurrency: int):
    print(f"[moyu-v2] 目标: {target} 条 | batch_size: {batch_size} | 并发: {concurrency}")
    print(f"[moyu-v2] 模型: {MODEL}")
    print(f"[moyu-v2] API Key: {API_KEY[:8]}...{API_KEY[-4:]}")

    semaphore = asyncio.Semaphore(concurrency)
    all_records: list[dict] = []
    seen_pairs: set[str] = set()  # user+assistant 联合去重
    chunk_size = concurrency * 2  # 减小每轮任务数
    round_num = 0
    fail_streak = 0  # 连续低产出轮次

    # 增量写入文件路径
    raw_path = OUT_DIR / "moyu_v2_raw.jsonl"

    async with httpx.AsyncClient() as client:
        while len(all_records) < target:
            round_num += 1
            # 每轮动态生成一批任务
            tasks = [(pick_bucket(), batch_size) for _ in range(chunk_size)]
            coros = [generate_batch(client, bucket, bs, semaphore) for bucket, bs in tasks]
            results = await asyncio.gather(*coros)

            new_count = 0
            for records in results:
                for r in records:
                    pair_key = (r["user"].strip() + "|" + r["assistant"].strip())[:200]
                    if pair_key not in seen_pairs:
                        seen_pairs.add(pair_key)
                        all_records.append(to_messages(r["user"], r["assistant"]))
                        new_count += 1

            print(f"  [轮次 {round_num}] +{new_count} 新增 | 总计 {len(all_records)}/{target}")

            # 每 5 轮增量写一次文件，防止中断丢数据
            if round_num % 5 == 0:
                with raw_path.open("w", encoding="utf-8") as f:
                    for rec in all_records:
                        f.write(json.dumps(rec, ensure_ascii=False) + "\n")

            # 安全阀：连续 3 轮新增为 0，停止
            if new_count == 0:
                fail_streak += 1
                if fail_streak >= 3:
                    print(f"  [INFO] 连续 {fail_streak} 轮无新增，停止生成")
                    break
            else:
                fail_streak = 0

    print(f"\n[moyu-v2] 生成完成: {len(all_records)} 条 (去重后)")

    # 截取目标数量
    random.shuffle(all_records)
    all_records = all_records[:target]

    # 划分 train / eval (95% / 5%)
    n_eval = max(10, min(len(all_records) // 20, 500))
    eval_split = all_records[:n_eval]
    train_split = all_records[n_eval:]

    train_path = OUT_DIR / "moyu_v2_train.jsonl"
    eval_path = OUT_DIR / "moyu_v2_eval.jsonl"

    with train_path.open("w", encoding="utf-8") as f:
        for rec in train_split:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    with eval_path.open("w", encoding="utf-8") as f:
        for rec in eval_split:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")

    # 统计
    asst_lens = [len(r["messages"][-1]["content"]) for r in train_split]
    print(f"[moyu-v2] train → {train_path} ({len(train_split)} 条)")
    print(f"[moyu-v2] eval  → {eval_path} ({len(eval_split)} 条)")
    print(f"[moyu-v2] 回复长度: mean={sum(asst_lens)/max(len(asst_lens),1):.0f}, "
          f"min={min(asst_lens) if asst_lens else 0}, max={max(asst_lens) if asst_lens else 0}")

    # 打印几个样本
    print(f"\n[moyu-v2] 样本预览:")
    for rec in train_split[:3]:
        msgs = rec["messages"]
        print(f"  用户: {msgs[1]['content']}")
        print(f"  鱼哥: {msgs[2]['content']}")
        print()


def main():
    parser = argparse.ArgumentParser(description="生成摸鱼人设训练数据 (DeepSeek API)")
    parser.add_argument("--target", type=int, default=30000, help="目标数据条数")
    parser.add_argument("--batch-size", type=int, default=20, help="每次 API 调用生成多少条")
    parser.add_argument("--concurrency", type=int, default=8, help="并发 API 请求数")
    args = parser.parse_args()

    if not API_KEY:
        print("错误: 请设置 DEEPSEEK_API_KEY 环境变量")
        return

    asyncio.run(run(args.target, args.batch_size, args.concurrency))


if __name__ == "__main__":
    main()
