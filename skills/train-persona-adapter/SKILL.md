---
name: train-persona-adapter
description: >-
  End-to-end recipe to design, train and integrate a new LoRA persona adapter
  on the local MiniCPM-test desktop pet. Walks the agent through persona
  design, dataset generation, MPS LoRA training, sidecar + frontend wiring,
  and live pet verification. Use when the user asks to "训一个新人设", "加新
  adapter / 人格", "自定义 persona", "自己训 LoRA", "做一个新人格 / 桌宠风格",
  or wants to extend the existing chuuni / neko personas with another one.
---

# Training + integrating a new persona LoRA

Sister skill of `deploy-minicpm-pet`. That one runs the pet; **this one
teaches it a new personality**.

Reference implementations:

- `adapters/lora_moyu_20260519_2003` (摸鱼哥)
- `adapters/lora_nekoqa_adapter_20260515_0738` (neko)

The full pipeline scripts live in `training/` and were proven to
end-to-end work on Apple Silicon MPS.

## Key files (orientation)

| File | Role |
|---|---|
| `training/generate_dataset.py` | Hand-written seeds + paraphrase expander → jsonl |
| `training/train_lora.py` | MPS bf16 LoRA training loop (no Trainer) |
| `training/smoke_inference.py` | Before/after inference comparison |
| `minicpm-sidecar/gateway/server.py` | Sidecar. `PERSONA_SYSTEM_PROMPTS` / adapter routing live here |
| `clawd-on-desk/src/minicpm-i18n.js` | Frontend command patterns + classifier few-shot |
| `clawd-on-desk/src/minicpm-chat-renderer.js` | Frontend command dispatch / adapter keyword routing |
| `go.sh start` | One-shot pet launcher (already sets `MINICPM_ATTN_IMPL=eager`) |
| `adapters/<name>/` | Where finished adapters land (auto-discovered by sidecar) |

## Workflow

Track progress with this checklist:

```
- [ ] 1. Confirm persona direction + training scale with user
- [ ] 2. Pick persona key + draft SYSTEM_PROMPT
- [ ] 3. Copy + edit generate_dataset.py
- [ ] 4. Generate dataset, sanity-check counts
- [ ] 5. Smoke train (0.05 epoch, ~30s) to validate MPS path
- [ ] 6. Full train in background, watch loss
- [ ] 7. smoke_inference.py — eyeball before/after
- [ ] 8. Update `minicpm-sidecar/gateway/server.py`
- [ ] 9. Update `clawd-on-desk/src/minicpm-i18n.js` + `clawd-on-desk/src/minicpm-chat-renderer.js`
- [ ] 10. Restart pet, curl end-to-end test
- [ ] 11. Write USAGE.md for the new adapter
```

### Step 1 — Persona direction + scale (AskQuestion)

Two questions to put to the user:

**Direction** — avoid duplicating existing personas (`default`, `neko`
cat-girl, `chuuni` isekai hero). Suggest fresh angles with clear contrast:
傲娇 / 老周(senior eng) / 上海阿姨 / 律师腔 / DIY.

**Scale** — M5 / 16GB feasibility:

| Scale | Seeds | Wall time | When to pick |
|---|---|---|---|
| `fast_demo` | 100-150 hand-written → ~300-500 after expansion | ~10 min | Quick fun, persona-first, technical accuracy can slip |
| `balanced` | 400-600 hand-written → ~1500-2500 | 1-2 h | Persona + capability + safety triangle |
| `hard_cap` | 10K+ | **don't** on M5 — ship the script to cloud H100 |

### Step 2 — Persona key + SYSTEM_PROMPT

**Persona key** (e.g. `chuuni`, `yuki`, `tsundere`) drives three things:

1. Adapter directory name MUST contain it. Sidecar matches it
   case-insensitively as substring against `adapter_dir.name`.
2. Frontend `COMMAND_PATTERNS` / classifier hints map user keywords → this key.
3. `PERSONA_SYSTEM_PROMPTS` / `PERSONA_HINTS` in `server.py` must include it.

Pick a lowercase English word, ≤ 10 chars, no overlap with `neko` /
`chuuni` / `default`.

**SYSTEM_PROMPT** (one paragraph, ≤ 5 sentences) should specify:

- Name (in-character)
- Self-reference (吾/本X/俺/etc.)
- How they address the user (主人/契约者/老板/etc.)
- 3-5 stylistic keywords (口吻 / 句尾词 / 比喻字典)
- **Length hint with explicit char count** — `单条回复以 1-3 句、约 100 字为主`
  is the proven template. Reference values: neko ~50 字 (撒娇 short), chuuni
  / zhiyuan / default ~100 字. **Vague hints like "回答简洁" or "不要长篇大
  论" don't work** — the 0.9B model needs a concrete target number.

This exact string will be hardcoded in **two** places — keep them in sync:
`training/generate_dataset.py:SYSTEM_PROMPT` and
`minicpm-sidecar/gateway/server.py:PERSONA_SYSTEM_PROMPTS[<key>]`.

> ⚠️ **The single most expensive lesson from the zhiyuan persona** (v5-v8
> took 4 wasted iterations to learn this): the SYSTEM_PROMPT used in the
> dataset generator **and** the one loaded at inference time **must be
> byte-identical**, including the length hint. If you train with a "回答可
> 以充分展开" prompt and then swap in a "约 100 字" prompt at inference, the
> LoRA imprint will spew long answers anyway — prompt change cannot
> override what the LoRA learned.

### Step 3 — Dataset generator

Copy `training/generate_dataset.py` → edit in place (not a new file) when
the user only wants one persona. Keep the **10-bucket skeleton**; only
edit the seeds and `SYSTEM_PROMPT`. Recommended minimum per bucket for
`fast_demo`:

| Bucket | Min seeds | Why it matters |
|---|---|---|
| 自我介绍 / 身份 | 8 | "你是谁" is the first prompt every user types |
| 情绪安慰 | 12 | High-frequency chat use case |
| 闲聊 | 15 | Generalisation surface |
| coding 场景 | 15 | Pet user IS a coder — don't ignore |
| 拒答 (隐私/有害) | 8 | **Don't skip** — LoRA otherwise erodes base safety |
| 数学逻辑 | 8 | **Don't skip** — small data wipes arithmetic |
| 元对话 (切换命令) | 6 | "切回原版" must stay in character |
| narration 风格 | 5 | "我刚跑完代码" → proactive cheer |
| 长度严格约束 | 4 | Preserves format-following |
| 人设口头禅 | 5 | Boosts persona signal density |

### Step 4 — Generate

```bash
uv run python training/generate_dataset.py
```

Confirm counts match the scale target. If too sparse, add more seeds or
raise `n` in `expand_one()`.

**Answer length policy (critical)**:

```python
# At end of generator, sanity-check assistant lengths:
asst_lens = [len(r["messages"][-1]["content"]) for r in train_records]
print(f"mean/min/max: {sum(asst_lens)/len(asst_lens):.0f}/"
      f"{min(asst_lens)}/{max(asst_lens)} chars")
```

Target distribution for a `约 100 字` persona prompt: **mean ≤ 100 chars,
max ≤ 150 chars**. If your seeds run longer, the LoRA will imprint long
answers and override the length hint at inference. Three concrete rules:

1. **Don't write seed answers >150 chars** unless the persona is
   *intentionally* verbose (e.g. a 学者 persona aiming for 300-char essays).
   v5-v8 of `zhiyuan` learned this the hard way — 200-280 char seeds
   produced 400-560 char inference outputs even with a "约 100 字" prompt.
2. **Compress, don't truncate**. Strip ceremonial preface ("同学这其实是个
   很好的问题——"), strip closing flourishes ("这是我反复跟团队讲的"), keep
   only the load-bearing sentences with key phrases.
3. **Don't mix long-form and short-form seeds in one adapter**. Pick one
   length regime per persona. If you need both, train two adapters and let
   the user switch.

### Step 5 — Smoke train (mandatory)

Validate MPS path before committing to a long run:

```bash
uv run python training/train_lora.py \
  --epochs 0.05 --output-dir training/runs/_smoke
```

Expected: finishes in ~30s, loss drops a little (5-step run). If
**SIGABRT / `LLVM ERROR: mps_matmul`** appears, the eager-attention
override is missing — `train_lora.py` already forces it, so investigate
torch version mismatch rather than retry. Clean up: `rm -rf
training/runs/_smoke`.

### Step 6 — Full train (background)

```bash
uv run python training/train_lora.py --epochs 3 --copy-to-adapters
```

**Run it backgrounded** (`block_until_ms: 0`). Critical: pass
`working_directory: /absolute/path/to/MiniCPM-Desk-Pet` to Shell —
**a shell restart loses cwd** and the relative `training/...` path
breaks.

While it runs, poll with AwaitShell pattern `"'step': 30"` to confirm
loss is dropping past step 30. Healthy `fast_demo`:

- step 1: loss ~4.7
- step 30: loss ~3.0
- end-of-epoch-1 eval: < 1.5
- end-of-epoch-3 eval: < 0.5

`--copy-to-adapters` auto-publishes the final adapter to
`adapters/lora_<key>_<timestamp>/` so the sidecar will find it on next
restart.

### Step 7 — Smoke inference

```bash
uv run python training/smoke_inference.py \
  --adapter adapters/lora_<key>_<timestamp>
```

Edit `training/smoke_inference.py` first if the persona changed
substantially. The default prompts cover identity / emotion / coding /
math / refusal / meta — eyeball all of them. Pass
criteria:

- Identity prompt clearly says the new name in character
- Math answer numerically correct
- Refusal still refuses (don't let persona override safety)
- At least 5/8 sound like the target persona, not base

### Step 8 — Wire into `server.py`

Edit `minicpm-sidecar/gateway/server.py` in two places.

**a) Add the prompt constant + register in `PERSONA_SYSTEM_PROMPTS`:**

Find the existing block:

```python
PERSONA_SYSTEM_PROMPTS = {
    "moyu": ("..."),
    "neko": ("..."),
}
```

Add the new persona prompt string in the same style and an entry in the
dict. Key MUST match what `adapter_dir.name` contains.

**b) Extend `PERSONA_HINTS`:**

Find `PERSONA_HINTS = {...}` and append filename / directory-name hints
for the new persona key.

### Step 9 — Wire into `minicpm-i18n.js` + `minicpm-chat-renderer.js`

`clawd-on-desk/src/minicpm-i18n.js` and
`clawd-on-desk/src/minicpm-chat-renderer.js` replace the old inline HTML
logic.

**a) `clawd-on-desk/src/minicpm-i18n.js` command patterns** — add
keyword → persona-key entries. Keys here are the Chinese / English words
a user might say, value is the substring that matches the adapter
directory name:

```js
"傲娇": "tsundere",
"tsundere": "tsundere",
```

**b) `clawd-on-desk/src/minicpm-i18n.js` hints / classifier few-shot** —
append the new keywords and add 1-2 positive examples:

```
"用户：切到傲娇 → SWITCH_TO=傲娇\n" +
"用户：换成傲娇模式 → SWITCH_TO=傲娇\n" +
```

0.9B is sensitive to few-shot distribution — every new persona benefits
from at least one positive example.

### Step 10 — Restart pet + end-to-end verify

Kill cleanly (the pet spawns multiple Electron children):

```bash
pkill -f "clawd-on-desk|minicpm-sidecar|launch.js" 2>/dev/null || true
sleep 2
pgrep -f "clawd-on-desk|minicpm-sidecar" || echo "all clean"
```

Restart backgrounded:

```bash
bash go.sh start
```

Wait for sidecar with AwaitShell pattern `"persona = <new_key>"`. Then
verify the full chain via the HTTP API:

```bash
curl -s http://127.0.0.1:18765/api/health | python3 -m json.tool
# expect: persona = "<new_key>", adapter ends in "lora_<key>_..."

curl -s -X POST http://127.0.0.1:18765/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"你是谁"}],"stream":false,"max_new_tokens":120,"silent":true}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['content'])"
# expect: reply clearly in the new persona's voice

curl -s http://127.0.0.1:18765/api/adapters | python3 -m json.tool
# expect: new adapter listed, current_name matches it
```

If the reply still sounds like base / chuuni / neko, the sidecar most
likely loaded a stale adapter — recheck `health.adapter` path and
restart.

### Step 11 — Write USAGE.md

Use an existing adapter README / USAGE in `adapters/` as a template.
Update: persona name, SYSTEM_PROMPT, training recipe table (steps, time,
eval loss), 10-bucket coverage table, limitations section honestly
listing what broke during smoke_inference.

## Pitfalls cheat sheet

| Pitfall | Symptom | Fix |
|---|---|---|
| `MINICPM_ATTN_IMPL` unset on torch 2.6 + macOS 26 | Sidecar SIGABRT on warmup, `LLVM ERROR: mps_matmul ... incompatible dimensions` | `go.sh` defaults to `eager` since v0.2.1. If launching sidecar manually, `export MINICPM_ATTN_IMPL=eager` |
| Editing the wrong sidecar file | Persona prompt looks right in one place but runtime ignores it | Only edit `minicpm-sidecar/gateway/server.py` in this repo |
| Adapter dir name missing persona key | Adapter loads but sidecar reports `persona = "default"` | Rename dir to contain the key, or extend the `PERSONA_HINTS` / `PERSONA_SYSTEM_PROMPTS` logic |
| `working_directory` not absolute on backgrounded Shell | `[Errno 2] No such file or directory` from `training/...` | Pass absolute path to `working_directory:` (shell may restart, losing cwd) |
| Skipping refusal / math buckets | LoRA wipes base safety + arithmetic | Keep all 10 buckets; minimums in Step 3 table |
| `enable_thinking=True` during training | Model traps tokens inside `<think>` and never closes | `train_lora.py` and chat template both default to `False`; don't toggle |
| Loss < 0.1 by epoch 2 on `fast_demo` | Severe overfit, in-distribution prompts echo seeds verbatim | Reduce epochs to 2, or add more seed diversity per bucket |
| Training answer mean >150 chars but prompt says "约 100 字" | Inference outputs 300-500 chars, prompt-change at inference does nothing | Re-compress seeds to mean ≤ 100 chars **and** re-train (see Step 4 length policy) |
| `SYSTEM_PROMPT` in generator differs from `server.py` | Persona style is right but length / formality drifts; "改 prompt" feels useless | Treat the two prompts as **one** string: diff before every training run; copy-paste rather than re-type |

## What this skill does NOT do

- **Does not touch narration**. Pet's proactive narration uses
  `disable_adapter: true`, intentionally bypassing every persona LoRA.
  New persona only shows in **user-initiated chat**.
- **Does not chase 30K-sample regimes**. M5 budget is wrong for that —
  port the dataset generator to a cloud H100 job (see
  `adapters/lora_nekoqa_adapter_20260515_0738/REPORT_4WAY.md` for the
  reference recipe).
- **Does not auto-commit dataset / runs**. `training/dataset/` and
  `training/runs/` are gitignored; only scripts + final adapter belong
  in version control.

## References

- `training/README.md` — one-pager on the training pipeline
- `training/moyu_persona.md` — worked example of a persona design doc
- `adapters/lora_moyu_20260519_2003/README.md` — worked example of an
  adapter note / usage doc
- `adapters/lora_nekoqa_adapter_20260515_0738/REPORT_4WAY.md` — H100
  regime reference (don't run on M5)
