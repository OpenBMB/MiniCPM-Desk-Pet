#!/usr/bin/env python3
"""Convert a MiniCPM checkpoint to an OpenVINO IR the gateway can load.

    python scripts/convert-openvino.py --source <hf-checkpoint-dir> --preset gpu
    python scripts/convert-openvino.py --source <hf-checkpoint-dir> --preset npu

Why not just call optimum-cli directly:

  · The NPU only accepts symmetric INT4; anything else loads fine and then
    kills the sidecar with 0xC0000005 inside `generate()`
    (openvinotoolkit/openvino#35641). The `npu` preset is the supported
    combination, and `.minicpm-ir.json` lets the gateway prove it.
  · `optimum-intel` pulls in torch/transformers/nncf, which pyproject
    promises never to have — `uv run --no-project` keeps them out of .venv.
  · On a GBK console nncf's rich progress bar dies with UnicodeEncodeError
    *after* doing all the compression work, so UTF-8 is forced.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
SIDECAR_ROOT = HERE.parent
REPO_ROOT = SIDECAR_ROOT.parent

#: Mirrors openvino_client.OPENVINO_IR_FILES; duplicated so this script
#: stays importable without the gateway package.
REQUIRED_IR_FILES = (
    "openvino_model.xml",
    "openvino_model.bin",
    "openvino_tokenizer.xml",
    "openvino_detokenizer.xml",
)

#: A missing chat template silently destroys the <think> protocol, so it
#: is checked rather than assumed.
REQUIRED_SUPPORT_FILES = ("config.json", "generation_config.json")

PRESETS: dict[str, dict] = {
    # INT8 weight-only: best quality per byte on CPU and Arc iGPU.
    "cpu": {"weight_format": "int8", "sym": False, "group_size": None, "ratio": None},
    "gpu": {"weight_format": "int8", "sym": False, "group_size": None, "ratio": None},
    # The only supported NPU LLM format. group-size 128 rather than
    # channel-wise, which targets models well above 4-5B.
    "npu": {"weight_format": "int4", "sym": True, "group_size": 128, "ratio": 1.0},
}

DEFAULT_OPTIMUM_SPEC = (
    "optimum-intel[openvino]",
    "nncf",
    # The 2.6B checkpoint records transformers_version 5.x, but
    # optimum-intel does not track transformers v5 yet.
    "transformers<5",
)


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="convert-openvino.py",
        description="Export a MiniCPM checkpoint to an OpenVINO IR.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--source", required=True,
                   help="HF checkpoint directory (or a hub id)")
    p.add_argument("--preset", choices=sorted(PRESETS), default="gpu",
                   help="target device profile (default: gpu)")
    p.add_argument("--out", default=None,
                   help=f"output root (default: {REPO_ROOT / 'models' / 'ov'})")
    p.add_argument("--name", default=None,
                   help="output directory name (default: derived from source + preset)")
    p.add_argument("--weight-format", default=None, help="override the preset")
    p.add_argument("--sym", action="store_true", default=None, help="override the preset")
    p.add_argument("--group-size", type=int, default=None, help="override the preset")
    p.add_argument("--ratio", type=float, default=None, help="override the preset")
    p.add_argument("--trust-remote-code", action="store_true",
                   help="pass --trust-remote-code to optimum-cli")
    p.add_argument("--force", action="store_true",
                   help="overwrite an existing output directory")
    p.add_argument("--dry-run", action="store_true",
                   help="print the optimum-cli invocation and exit")
    p.add_argument("--optimum-spec", action="append", default=None,
                   help="override the uv --with specs (repeatable)")
    return p.parse_args(argv)


def resolve_settings(args: argparse.Namespace) -> dict:
    settings = dict(PRESETS[args.preset])
    if args.weight_format is not None:
        settings["weight_format"] = args.weight_format
    if args.sym is not None:
        settings["sym"] = args.sym
    if args.group_size is not None:
        settings["group_size"] = args.group_size
    if args.ratio is not None:
        settings["ratio"] = args.ratio
    return settings


def derive_name(source: str, settings: dict) -> str:
    stem = Path(source).name or "model"
    # Keep just the model id from a long checkpoint dir name. Never cut on
    # "." — that is part of "2.6B".
    stem = stem.split("_", 1)[0]
    stem = re.sub(r"-\d{4,8}$", "", stem)
    bits = [stem, settings["weight_format"]]
    if settings.get("sym"):
        bits.append("sym")
    if settings.get("group_size"):
        bits.append(f"g{settings['group_size']}")
    return "-".join(bits)


def build_argv(source: str, target: Path, settings: dict, args: argparse.Namespace) -> list[str]:
    specs = args.optimum_spec or list(DEFAULT_OPTIMUM_SPEC)
    argv = ["uv", "run", "--no-project", "--python", "3.11"]
    for spec in specs:
        argv += ["--with", spec]
    argv += [
        "optimum-cli", "export", "openvino",
        "--model", str(source),
        # Without the KV-cache variant every token reruns the full prefill.
        "--task", "text-generation-with-past",
        "--weight-format", str(settings["weight_format"]),
    ]
    if settings.get("sym"):
        argv.append("--sym")
    if settings.get("group_size") is not None:
        argv += ["--group-size", str(settings["group_size"])]
    if settings.get("ratio") is not None:
        argv += ["--ratio", str(settings["ratio"])]
    if args.trust_remote_code:
        argv.append("--trust-remote-code")
    argv.append(str(target))
    return argv


def export_env() -> dict:
    env = dict(os.environ)
    # nncf's progress bar writes U+2022 and dies on a GBK console.
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    env["NO_COLOR"] = "1"
    env["TERM"] = "dumb"
    env.setdefault("OPENVINO_TELEMETRY_OPT_OUT", "1")
    return env


def validate_export(target: Path) -> list[str]:
    problems = []
    for name in REQUIRED_IR_FILES:
        if not (target / name).is_file():
            problems.append(f"missing IR file: {name}")
    for name in REQUIRED_SUPPORT_FILES:
        if not (target / name).is_file():
            problems.append(f"missing support file: {name}")

    template = target / "chat_template.jinja"
    inline = target / "tokenizer_config.json"
    template_text = ""
    if template.is_file():
        template_text = template.read_text(encoding="utf-8", errors="replace")
    elif inline.is_file():
        template_text = inline.read_text(encoding="utf-8", errors="replace")
    if "enable_thinking" not in template_text:
        problems.append(
            "no chat template with `enable_thinking` found — the desk pet's "
            "think/answer split will not work with this IR"
        )
    return problems


def write_metadata(target: Path, settings: dict, source: str, argv: list[str], preset: str) -> None:
    payload = {
        "version": 1,
        "preset": preset,
        "weight_format": settings["weight_format"],
        "sym": bool(settings.get("sym")),
        "group_size": settings.get("group_size"),
        "ratio": settings.get("ratio"),
        "npu_ready": settings["weight_format"] == "int4" and bool(settings.get("sym")),
        "source": str(source),
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "optimum_cli": argv,
    }
    # Dot-prefixed so no model scanner picks it up as a model file.
    (target / ".minicpm-ir.json").write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )


def main(argv: list[str] | None = None) -> int:
    args = parse_args(list(sys.argv[1:] if argv is None else argv))
    settings = resolve_settings(args)

    out_root = Path(args.out).expanduser() if args.out else REPO_ROOT / "models" / "ov"
    name = args.name or derive_name(args.source, settings)
    target = out_root / name
    # Stage then rename, mirroring updater.py's `.update-staging`: a
    # half-written IR discovered by /api/models would hang LLMPipeline.
    staging = out_root / f"{name}.partial"

    cli = build_argv(args.source, staging, settings, args)

    print(f"==> preset      : {args.preset}")
    print(f"==> quantization: {settings}")
    print(f"==> source      : {args.source}")
    print(f"==> target      : {target}")
    print(f"==> command     : {' '.join(cli)}")

    if args.dry_run:
        return 0

    if shutil.which("uv") is None:
        print(
            "\nuv not found on PATH. Either install it "
            "(https://docs.astral.sh/uv/) or run the equivalent by hand:\n"
            f"  pip install {' '.join(DEFAULT_OPTIMUM_SPEC)}\n"
            f"  {' '.join(cli[cli.index('optimum-cli'):])}\n",
            file=sys.stderr,
        )
        return 1

    if target.exists():
        if not args.force:
            print(f"\n{target} already exists; pass --force to overwrite.", file=sys.stderr)
            return 1
        shutil.rmtree(target)
    if staging.exists():
        shutil.rmtree(staging)
    out_root.mkdir(parents=True, exist_ok=True)

    started = time.monotonic()
    result = subprocess.run(cli, env=export_env())
    if result.returncode != 0:
        print(f"\noptimum-cli failed with exit code {result.returncode}", file=sys.stderr)
        return result.returncode

    problems = validate_export(staging)
    if problems:
        print("\nExport finished but the result is not usable:", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        print(f"Leaving the staging directory at {staging} for inspection.", file=sys.stderr)
        return 1

    write_metadata(staging, settings, args.source, cli, args.preset)
    staging.rename(target)

    size_gb = sum(f.stat().st_size for f in target.rglob("*") if f.is_file()) / 1024 ** 3
    print(f"\n==> OK  {target}  ({size_gb:.2f} GiB, {time.monotonic() - started:.0f}s)")
    if settings["weight_format"] == "int4" and settings.get("sym"):
        print("==> NPU-ready. Run the gateway with MINICPM_DEVICE=npu to use it.")
    else:
        print("==> For CPU/GPU. The NPU needs --preset npu (symmetric INT4).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
