---
base_model: openbmb/MiniCPM5-1B
library_name: peft
license: apache-2.0
datasets:
  - liumindmind/NekoQA-30K
tags:
  - neko30k
  - nekoqa
---

# MiniCPM5-1B NekoQA v2 LoRA

本地开发副本。公开版本见 Hugging Face：

- **PEFT**: [DennisHuang648/MiniCPM5-1B-NekoQA-v2-LoRA](https://huggingface.co/DennisHuang648/MiniCPM5-1B-NekoQA-v2-LoRA)
- **GGUF**: [DennisHuang648/MiniCPM5-1B-NekoQA-v2-LoRA-GGUF](https://huggingface.co/DennisHuang648/MiniCPM5-1B-NekoQA-v2-LoRA-GGUF)

## 训练数据

本 LoRA 的微调数据来源为 **neko30k** 数据集（Hugging Face: [liumindmind/NekoQA-30K](https://huggingface.co/datasets/liumindmind/NekoQA-30K)），共 30,834 条猫娘 QA 对话。

详细用法见 `USAGE.md`。
