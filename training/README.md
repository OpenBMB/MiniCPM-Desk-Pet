# LoRA 训练 - moyu / neko

Apple Silicon (MPS) 上跑 MiniCPM5-0.9B 的 LoRA persona 微调。
这个分支只保留两条线：

- `moyu`：当前在继续整理和训练的人设
- `neko`：`main` 里已有的 adapter 文件，作为现成参考保留

## 当前主要文件

- `moyu_persona.md`：摸鱼哥人设设定
- `generate_moyu_dataset.py`：手写 seeds 扩增出 `moyu_train.jsonl`
- `generate_moyu_dataset_v2.py`：更大规模生成 `moyu_v2_*`
- `sample_dataset.py`：从大训练集抽样出 `300 / 3000 / 10000` 等子集
- `split_dataset.py`：把 raw 数据切成 train / eval
- `train_lora.py`：MPS LoRA 训练主脚本
- `smoke_inference.py`：训练后快速做 base / LoRA 对比

## 常用流程

```bash
# 1) 生成基础摸鱼数据
python3 training/generate_moyu_dataset.py

# 2) 如需大数据集，生成 v2
uv run python training/generate_moyu_dataset_v2.py --target 30000

# 3) 抽样出小训练集
python3 training/sample_dataset.py \
  training/dataset/moyu_v2_train.jsonl \
  training/dataset/moyu_v2_eval.jsonl \
  3000 \
  training/dataset/moyu_v2_s3000_train.jsonl \
  training/dataset/moyu_v2_s3000_eval.jsonl \
  300

# 4) 训练
uv run --with torch --with transformers --with peft --with safetensors --with accelerate \
  python training/train_lora.py \
  --persona-key moyu \
  --train training/dataset/moyu_v2_s3000_train.jsonl \
  --eval training/dataset/moyu_v2_s3000_eval.jsonl \
  --epochs 3 \
  --copy-to-adapters
```

## 关于 eval

`eval` 文件不参与训练，只用来观察模型有没有过拟合。

- `train loss` 下降：说明模型在记训练集
- `eval loss` 也稳住或下降：说明泛化还行
- `eval loss` 反而持续上升：通常说明开始背题了

300 条这档适合演示和录教程，3000 条更适合实际效果。
