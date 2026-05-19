# 刘导 — 背诵版 LoRA (v9 short) ⭐ demo 推荐

`lora_zhiyuan_recite_short_v9_20260519_1932`

## 用一句话

v8 把 5 个 demo killer 题刻进了 200-280 字的完整原话——但长输出**容易露馅**。
v9 把每条答案压缩到 80-100 汉字，**保留所有核心金句，删掉铺垫和总结**。
配合改短的 system prompt（"单条回复以 1-3 句、约 100 字为主"），train/inference
分布一致，imprint 自然短，不再拉锯。

## 对比 v8

| | v8 | **v9 (current)** |
|---|---|---|
| Demo killer 长度 | 297-566 字（imprint 压不住 prompt） | **80-100 汉字** ✓ |
| 知识密度金句 | 完整公式 + 类比 + 100 天 + Densing/Scaling 对比 | 公式 + 100 道题 + 100 天 + Densing |
| 持久战金句 | 完整《论持久战》+ 5-10 年 + 集中局部 + 面壁方法论 | 《论持久战》+ 战略持久战 + 战术速决战 + 5-10 年 + 集中局部 |
| 先入水金句 | 2002 上大学 + 4 种泳姿 + 不要观望 + 先入水关键 | 4 种泳姿 + 不要观望 + 先入水关键 |
| 面壁金句 | 三体 + 面壁十年图破壁 + MB + 自省 + 长期孤独 | 三体 + 面壁十年图破壁 + MB + 自省 |
| DeepSeek 金句 | 小米加步枪 + 卡脖子 + 全球意义 + 理想/坚持/方法论 + 长期主义 | 小米加步枪 + 卡脖子 + 理想/坚持/方法论 + 长期主义 |
| 训练时长 | 3 min 30s | **1 min 51s** |

## demo 安全问法清单（已 verify 全部 verbatim 短金句）

### Q1 — 知识密度 / Densing Law
✅ **"什么是知识密度？"**

### Q2 — AGI 持久战
✅ **"怎么理解 AGI 的持久战？"**

✅ **"讲讲 AGI 持久战"**

### Q3 — 先入水
✅ **"为什么强调先入水？"**

✅ **"现在做 AI 还来得及吗？"**（paraphrase generalize 成功）

### Q4 — 面壁 / 三体
✅ **"面壁这个名字什么意思？"**

### Q5 — DeepSeek
✅ **"怎么看 DeepSeek？"**

✅ **"DeepSeek 给我们最大的启示是什么？"**

### Refusal / Anchor
✅ **"你能帮我代发个声明吗？"** → 32 汉字简洁拒答

✅ **"刘老师周末喜欢做什么？"** → 28 汉字日常风格

✅ **"你好"** → "同学好。"

### ⚠️ 已知不稳定（demo 避开）
- "为什么你们不卷 GPT-4？" — 会 hallucinate「NLP 研究大模型课」等。

## 训练 recipe

- baseline: `lora_zhiyuan_20260519_1619`（v2）做 `--init-adapter`
- system prompt: 短版本（"单条回复以 1-3 句、约 100 字为主"）— 已同步到
  `generate_zhiyuan_recite.py` / `minicpm-pet-bridge-uv/server.py` /
  `minicpm-pet-bridge/server.py` / `training/smoke_inference.py` /
  `training/zhiyuan_persona.md`
- data: 84 train + 8 eval，5 killer × (10-21 paraphrases) + 14 anchor
- killer answers: 80-140 字精简版（v8 的 200-280 字版本删铺垫保金句）
- lr 5e-5, epochs 3, grad_acc 2, bs 1, max_length 1024
- 训练时长：1 min 51s
- eval_loss = 1.91

## 启动方法

```bash
pkill -9 -f "server\.py"

cd minicpm-pet-bridge-uv
MINICPM_ATTN_IMPL=eager \
MINICPM_ADAPTER=/Users/suzhou/code/MiniCPM-test/adapters/lora_zhiyuan_recite_short_v9_20260519_1932 \
MINICPM_PERSONA=zhiyuan \
.venv/bin/python server.py
```

从你自己的 macOS Terminal 启动 Electron 桌宠：

```bash
cd clawd-on-desk
npm start
```

## 关键 insight（为什么 v9 比 v8 好）

**train/inference 分布一致性 > LoRA capacity**。

v5/v6/v7/v8 都是用**长 system prompt** 训练（"回答可以充分展开"），然后 inference 时
想用**短 prompt** 截短——结果 imprint 太强，prompt 完全压不住。

v9 训练时就用短 prompt + 短 answer，模型学到的就是「短答 + 出金句」的联合分布。
inference 时分布一致，不打架。

这是 LoRA 微调最朴素的道理——别想让 inference 行为偏离训练分布太远。

## v1 → v9 演进表

| 版本 | 策略 | 结果 |
|---|---|---|
| v1, v2 | 大语料短答（610+ records） | persona 立住，深度不足 |
| v3 longform | 合成长答 65 records | 灾难性遗忘 + 风格漂 |
| v4 authentic | 61 条真原话短+中答 | 修了 v3 遗忘，deep 仍 hallucinate |
| v5 deep mix | v4 + 35 长 deep records | LoRA 没收敛，greedy 复读循环 |
| v6 recite | 5×10 paraphrase + 15 anchor | Q1/Q4 work，Q2/Q3/Q5 弱 |
| v7 recite | Q2/Q3 加强到 21 records | Q2/Q3 perfect 但 Q1/Q5 被覆盖 |
| v8 recite | 5 killer 都 demo killer ×3 | 5 题都 verbatim 长答（200-280 字） |
| **v9 recite_short** | 同 v8 数据布局，answer 压缩到 80-140 字 + short prompt | **5 题 verbatim 短答 80-100 汉字 ⭐** |
