"""将 raw jsonl 切分为 train/eval。"""
import json
import random
import sys

raw_path = sys.argv[1] if len(sys.argv) > 1 else "training/dataset/moyu_v2_raw.jsonl"
train_path = sys.argv[2] if len(sys.argv) > 2 else "training/dataset/moyu_v2_train.jsonl"
eval_path = sys.argv[3] if len(sys.argv) > 3 else "training/dataset/moyu_v2_eval.jsonl"

records = []
with open(raw_path, "r", encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if line:
            records.append(json.loads(line))

print(f"总计: {len(records)} 条")
random.shuffle(records)

n_eval = max(10, min(len(records) // 20, 500))
eval_split = records[:n_eval]
train_split = records[n_eval:]

with open(train_path, "w", encoding="utf-8") as f:
    for rec in train_split:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
with open(eval_path, "w", encoding="utf-8") as f:
    for rec in eval_split:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")

asst_lens = [len(r["messages"][-1]["content"]) for r in train_split]
print(f"train: {len(train_split)} 条 -> {train_path}")
print(f"eval:  {len(eval_split)} 条 -> {eval_path}")
print(f"回复长度: mean={sum(asst_lens)/len(asst_lens):.0f}, min={min(asst_lens)}, max={max(asst_lens)}")
print()
print("样本预览:")
for rec in train_split[:3]:
    msgs = rec["messages"]
    print(f"  用户: {msgs[1]['content'][:50]}")
    print(f"  鱼哥: {msgs[2]['content'][:80]}")
    print()
