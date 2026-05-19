"""LoRA fine-tune MiniCPM5-0.9B on Apple Silicon (MPS).

A hand-rolled training loop instead of HF Trainer so we have tight control
over the device (MPS), dtype (bf16), and assistant-only loss masking.
Trainer + accelerate adds enough abstraction that MPS-only runs hit
configuration footguns that aren't worth debugging for ~300 samples.

Outputs:
    runs/lora_chuuni_<timestamp>/      checkpoint dir (peft format)
    adapters/lora_chuuni_<timestamp>/  symlinked / copied final adapter
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import shutil
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

import torch
from torch.utils.data import DataLoader, Dataset
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import LoraConfig, get_peft_model, PeftModel  # noqa: F401 (PeftModel used implicitly)


REPO = Path(__file__).resolve().parent.parent


# ─────────────────────────────────────────────────────────────────────────
# Data
# ─────────────────────────────────────────────────────────────────────────


class ChatJsonl(Dataset):
    """One record = one chat (system + user + assistant). Tokenised with
    assistant-only loss mask. We do the masking by tokenising the prompt
    (everything up to-and-including the assistant header) and the full
    chat separately, then zeroing out the prefix in labels."""

    def __init__(self, path: Path, tokenizer, max_length: int = 1024) -> None:
        self.records: list[dict] = []
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line:
                self.records.append(json.loads(line))
        self.tok = tokenizer
        self.max_length = max_length

    def __len__(self) -> int:
        return len(self.records)

    def __getitem__(self, i: int) -> dict:
        msgs = self.records[i]["messages"]
        # Find the last assistant turn; everything before it is "prompt".
        last_asst_idx = None
        for j, m in enumerate(msgs):
            if m["role"] == "assistant":
                last_asst_idx = j
        if last_asst_idx is None:
            raise ValueError(f"record {i} has no assistant message")

        prompt_msgs = msgs[:last_asst_idx]
        full_msgs = msgs[: last_asst_idx + 1]

        prompt_text = self.tok.apply_chat_template(
            prompt_msgs,
            tokenize=False,
            add_generation_prompt=True,
            enable_thinking=False,
        )
        full_text = self.tok.apply_chat_template(
            full_msgs,
            tokenize=False,
            add_generation_prompt=False,
            enable_thinking=False,
        )

        prompt_ids = self.tok(prompt_text, add_special_tokens=False).input_ids
        full_ids = self.tok(full_text, add_special_tokens=False).input_ids

        # Safety: full should start with prompt. Cheap check, surfaces
        # template-drift bugs early instead of silently masking junk.
        prefix_len = len(prompt_ids)
        if full_ids[:prefix_len] != prompt_ids:
            # Fall back: find prompt as a substring by scanning. Rare
            # but happens if tokenizer normalises whitespace differently
            # for the two calls.
            prefix_len = self._find_prefix_len(prompt_ids, full_ids)

        # Truncate from the right; we always want the prompt intact
        # because masking it out is what makes "assistant-only loss" work.
        if len(full_ids) > self.max_length:
            full_ids = full_ids[: self.max_length]

        labels = [-100] * len(full_ids)
        for k in range(prefix_len, len(full_ids)):
            labels[k] = full_ids[k]

        return {
            "input_ids": torch.tensor(full_ids, dtype=torch.long),
            "labels": torch.tensor(labels, dtype=torch.long),
        }

    @staticmethod
    def _find_prefix_len(prompt_ids: list[int], full_ids: list[int]) -> int:
        """Find the largest k where prompt_ids[:k] == full_ids[:k]."""
        k = 0
        for a, b in zip(prompt_ids, full_ids):
            if a != b:
                break
            k += 1
        return k


def pad_collate(batch: list[dict], pad_id: int) -> dict:
    max_len = max(item["input_ids"].size(0) for item in batch)
    input_ids = torch.full((len(batch), max_len), pad_id, dtype=torch.long)
    labels = torch.full((len(batch), max_len), -100, dtype=torch.long)
    attn = torch.zeros((len(batch), max_len), dtype=torch.long)
    for i, item in enumerate(batch):
        n = item["input_ids"].size(0)
        input_ids[i, :n] = item["input_ids"]
        labels[i, :n] = item["labels"]
        attn[i, :n] = 1
    return {"input_ids": input_ids, "labels": labels, "attention_mask": attn}


# ─────────────────────────────────────────────────────────────────────────
# Training
# ─────────────────────────────────────────────────────────────────────────


@dataclass
class TrainCfg:
    model_dir: Path
    train_path: Path
    eval_path: Path
    output_dir: Path
    epochs: float = 3.0
    bs: int = 1
    grad_acc: int = 4
    lr: float = 2e-4
    warmup_ratio: float = 0.05
    weight_decay: float = 0.0
    max_length: int = 1024
    lora_r: int = 8
    lora_alpha: int = 16
    lora_dropout: float = 0.05
    log_every: int = 5
    eval_every: int = 100  # steps; capped at one per epoch anyway
    seed: int = 42
    init_adapter: Path | None = None  # continue from existing LoRA


def pick_device() -> str:
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def cosine_lr(step: int, total: int, warmup: int, peak: float) -> float:
    if step < warmup:
        return peak * (step / max(1, warmup))
    progress = (step - warmup) / max(1, total - warmup)
    return 0.5 * peak * (1.0 + math.cos(math.pi * progress))


def evaluate(model, loader, device) -> float:
    if not loader.dataset:  # type: ignore[attr-defined]
        return float("nan")
    model.eval()
    losses: list[float] = []
    with torch.inference_mode():
        for batch in loader:
            batch = {k: v.to(device) for k, v in batch.items()}
            out = model(**batch)
            losses.append(float(out.loss.detach().to("cpu").float()))
    model.train()
    return sum(losses) / max(1, len(losses))


def train(cfg: TrainCfg) -> Path:
    random.seed(cfg.seed)
    torch.manual_seed(cfg.seed)

    device = pick_device()
    dtype = torch.bfloat16 if device != "cpu" else torch.float32
    print(f"[train] device={device} dtype={dtype}")
    print(f"[train] model={cfg.model_dir}")

    tok = AutoTokenizer.from_pretrained(str(cfg.model_dir), trust_remote_code=True)
    if tok.pad_token_id is None:
        tok.pad_token_id = tok.eos_token_id

    # The MPS metal kernel for fused SDPA blows up on MiniCPM's GQA pattern
    # on some macOS / torch combos; force eager attention to be safe during
    # training (small perf cost, big stability win).
    base = AutoModelForCausalLM.from_pretrained(
        str(cfg.model_dir),
        trust_remote_code=True,
        torch_dtype=dtype,
        attn_implementation="eager",
        low_cpu_mem_usage=True,
    )
    base.config.use_cache = False
    # Enable input grads so LoRA params (which are leaves) can backprop
    # through the frozen base. This is the standard recipe.
    if hasattr(base, "enable_input_require_grads"):
        base.enable_input_require_grads()

    if cfg.init_adapter is not None:
        # Continued LoRA fine-tune: load existing adapter weights and keep
        # training them. save_pretrained later emits a self-contained adapter
        # holding the merged delta (init + new gradient updates), so the
        # consumer only needs the final dir.
        print(f"[train] init from existing adapter: {cfg.init_adapter}")
        model = PeftModel.from_pretrained(
            base, str(cfg.init_adapter), is_trainable=True
        )
    else:
        lora_cfg = LoraConfig(
            r=cfg.lora_r,
            lora_alpha=cfg.lora_alpha,
            lora_dropout=cfg.lora_dropout,
            bias="none",
            task_type="CAUSAL_LM",
            target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                             "gate_proj", "up_proj", "down_proj"],
        )
        model = get_peft_model(base, lora_cfg)
    model.to(device)
    model.print_trainable_parameters()

    # ── Data ──
    train_ds = ChatJsonl(cfg.train_path, tok, max_length=cfg.max_length)
    eval_ds = ChatJsonl(cfg.eval_path, tok, max_length=cfg.max_length)
    print(f"[train] n_train={len(train_ds)} n_eval={len(eval_ds)}")

    def collate(batch):
        return pad_collate(batch, pad_id=tok.pad_token_id or 0)

    g = torch.Generator()
    g.manual_seed(cfg.seed)
    train_loader = DataLoader(
        train_ds, batch_size=cfg.bs, shuffle=True,
        collate_fn=collate, generator=g, num_workers=0,
    )
    eval_loader = DataLoader(
        eval_ds, batch_size=cfg.bs, shuffle=False,
        collate_fn=collate, num_workers=0,
    )

    # ── Optimizer ──
    trainable = [p for p in model.parameters() if p.requires_grad]
    optim = torch.optim.AdamW(trainable, lr=cfg.lr, weight_decay=cfg.weight_decay,
                              betas=(0.9, 0.95))

    n_steps_per_epoch = math.ceil(len(train_loader) / cfg.grad_acc)
    total_steps = int(math.ceil(n_steps_per_epoch * cfg.epochs))
    warmup_steps = max(1, int(total_steps * cfg.warmup_ratio))
    print(f"[train] steps/epoch={n_steps_per_epoch} total_steps={total_steps} warmup={warmup_steps}")

    # ── Loop ──
    cfg.output_dir.mkdir(parents=True, exist_ok=True)
    log_path = cfg.output_dir / "train_log.jsonl"
    log_path.write_text("", encoding="utf-8")

    model.train()
    step = 0
    micro = 0
    t0 = time.time()
    running_loss = 0.0
    running_n = 0

    def log(event: dict) -> None:
        event["wall"] = round(time.time() - t0, 2)
        with log_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(event, ensure_ascii=False) + "\n")
        print(f"[train] {event}", flush=True)

    for epoch in range(int(math.ceil(cfg.epochs))):
        # Stop mid-epoch if we've hit the fractional epoch budget.
        epoch_budget_steps = total_steps - step
        if epoch_budget_steps <= 0:
            break
        for batch in train_loader:
            batch = {k: v.to(device) for k, v in batch.items()}
            out = model(**batch)
            loss = out.loss / cfg.grad_acc
            loss.backward()
            running_loss += float(loss.detach().to("cpu").float()) * cfg.grad_acc
            running_n += 1
            micro += 1

            if micro % cfg.grad_acc == 0:
                # LR schedule + step
                lr_now = cosine_lr(step, total_steps, warmup_steps, cfg.lr)
                for g_ in optim.param_groups:
                    g_["lr"] = lr_now
                torch.nn.utils.clip_grad_norm_(trainable, max_norm=1.0)
                optim.step()
                optim.zero_grad(set_to_none=True)
                step += 1

                if step % cfg.log_every == 0 or step == 1:
                    log({"step": step, "epoch": round(step / n_steps_per_epoch, 3),
                         "lr": round(lr_now, 6),
                         "loss": round(running_loss / max(1, running_n), 4)})
                    running_loss = 0.0
                    running_n = 0

                if step >= total_steps:
                    break

        # End-of-epoch eval.
        eval_loss = evaluate(model, eval_loader, device)
        log({"step": step, "epoch_end": epoch + 1, "eval_loss": round(eval_loss, 4)})
        if step >= total_steps:
            break

    # ── Save ──
    # Adapter weights only — base model already ships tokenizer + chat
    # template, so re-saving them just bloats `adapters/` and diverges from
    # the nekoqa-adapter convention. The PEFT loader pulls them off the
    # base at inference time anyway.
    model.save_pretrained(str(cfg.output_dir))
    meta = {
        "base_model": str(cfg.model_dir),
        "data": str(cfg.train_path),
        "n_train": len(train_ds),
        "n_eval": len(eval_ds),
        "epochs": cfg.epochs,
        "lr": cfg.lr,
        "bs": cfg.bs,
        "grad_acc": cfg.grad_acc,
        "lora_r": cfg.lora_r,
        "lora_alpha": cfg.lora_alpha,
        "max_length": cfg.max_length,
        "assistant_only_loss": True,
        "wall_seconds": round(time.time() - t0, 1),
    }
    (cfg.output_dir / "train_meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"[train] done in {meta['wall_seconds']}s → {cfg.output_dir}")
    return cfg.output_dir


# ─────────────────────────────────────────────────────────────────────────


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--model", default=str(REPO / "models" / "minicpm5-0.9b"))
    p.add_argument("--persona-key", default="chuuni",
                   help="Used in default train/eval/output paths: "
                        "training/dataset/<key>_{train,eval}.jsonl, "
                        "training/runs/lora_<key>_<ts>/, adapters/lora_<key>_<ts>/")
    p.add_argument("--train", default=None,
                   help="Default: training/dataset/<persona-key>_train.jsonl")
    p.add_argument("--eval", default=None,
                   help="Default: training/dataset/<persona-key>_eval.jsonl")
    p.add_argument("--output-dir", default=None,
                   help="Default: training/runs/lora_<persona-key>_<timestamp>")
    p.add_argument("--epochs", type=float, default=3.0)
    p.add_argument("--bs", type=int, default=1)
    p.add_argument("--grad-acc", type=int, default=4)
    p.add_argument("--lr", type=float, default=2e-4)
    p.add_argument("--max-length", type=int, default=1024)
    p.add_argument("--lora-r", type=int, default=8)
    p.add_argument("--lora-alpha", type=int, default=16)
    p.add_argument("--copy-to-adapters", action="store_true",
                   help="After training, copy the adapter into <repo>/adapters/")
    p.add_argument("--init-adapter", default=None,
                   help="Path to an existing LoRA adapter to resume training from. "
                        "Used for continued fine-tune (e.g. teach an existing "
                        "persona to produce longer answers without re-training "
                        "from scratch).")
    args = p.parse_args()

    ts = time.strftime("%Y%m%d_%H%M")
    out = Path(args.output_dir) if args.output_dir else REPO / "training" / "runs" / f"lora_{args.persona_key}_{ts}"
    train_path = Path(args.train) if args.train else REPO / "training" / "dataset" / f"{args.persona_key}_train.jsonl"
    eval_path = Path(args.eval) if args.eval else REPO / "training" / "dataset" / f"{args.persona_key}_eval.jsonl"

    cfg = TrainCfg(
        model_dir=Path(args.model).resolve(),
        train_path=train_path.resolve(),
        eval_path=eval_path.resolve(),
        output_dir=out.resolve(),
        epochs=args.epochs,
        bs=args.bs,
        grad_acc=args.grad_acc,
        lr=args.lr,
        max_length=args.max_length,
        lora_r=args.lora_r,
        lora_alpha=args.lora_alpha,
        init_adapter=Path(args.init_adapter).resolve() if args.init_adapter else None,
    )
    final = train(cfg)

    if args.copy_to_adapters:
        dst = REPO / "adapters" / f"lora_{args.persona_key}_{ts}"
        if dst.exists():
            shutil.rmtree(dst)
        shutil.copytree(final, dst, ignore=shutil.ignore_patterns(
            "*.pyc", "__pycache__",
        ))
        print(f"[train] copied to {dst}")


if __name__ == "__main__":
    main()
