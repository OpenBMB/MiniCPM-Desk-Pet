"""从大数据集中随机抽样 N 条，生成新的 train/eval 文件。"""
import json
import random
import sys

src_train = sys.argv[1] if len(sys.argv) > 1 else "training/dataset/moyu_v2_train.jsonl"
src_eval = sys.argv[2] if len(sys.argv) > 2 else "training/dataset/moyu_v2_eval.jsonl"
n = int(sys.argv[3]) if len(sys.argv) > 3 else 10000
out_train = sys.argv[4] if len(sys.argv) > 4 else f"training/dataset/moyu_v2_s{n}_train.jsonl"
out_eval = sys.argv[5] if len(sys.argv) > 5 else f"training/dataset/moyu_v2_s{n}_eval.jsonl"
eval_n_arg = int(sys.argv[6]) if len(sys.argv) > 6 else None

records = []
with open(src_train, "r", encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if line:
            records.append(json.loads(line))

random.seed(42)
random.shuffle(records)
sampled = records[:n]

eval_records = []
with open(src_eval, "r", encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if line:
            eval_records.append(json.loads(line))

n_eval = eval_n_arg if eval_n_arg is not None else max(10, n // 10)
n_eval = min(n_eval, len(eval_records))

with open(out_train, "w", encoding="utf-8") as f:
    for rec in sampled:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
with open(out_eval, "w", encoding="utf-8") as f:
    for rec in eval_records[:n_eval]:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")

print(f"train: {len(sampled)} 条 -> {out_train}")
print(f"eval:  {n_eval} 条 -> {out_eval}")
