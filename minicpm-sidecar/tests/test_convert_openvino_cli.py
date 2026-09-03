"""The conversion CLI builds one optimum-cli command; get the flags wrong and
you silently ship a model the NPU will refuse — or crash on.

Pure argv assertions: nothing here runs optimum-cli.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "convert-openvino.py"


def _load():
    # Hyphenated filename, so import it by path rather than by module name.
    spec = importlib.util.spec_from_file_location("convert_openvino", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


convert = _load()


def _argv(*extra: str) -> list[str]:
    args = convert.parse_args(["--source", "/tmp/ckpt", *extra])
    settings = convert.resolve_settings(args)
    return convert.build_argv("/tmp/ckpt", Path("/tmp/out"), settings, args)


def test_default_preset_is_the_npu_compatible_combination():
    """Symmetric INT4 runs on both devices and is the fastest of the three
    on the GPU; group-size 128 is what the OpenVINO docs recommend at this
    model size."""
    argv = _argv()
    assert "--weight-format" in argv and argv[argv.index("--weight-format") + 1] == "int4"
    assert "--sym" in argv
    assert argv[argv.index("--group-size") + 1] == "128"
    assert argv[argv.index("--ratio") + 1] == "1.0"


def test_npu_alias_matches_the_default():
    assert _argv("--preset", "npu") == _argv()


@pytest.mark.parametrize("fmt", ["fp16", "fp32"])
def test_overriding_to_an_unquantized_format_drops_the_quantization_flags(fmt):
    """Regression: `--weight-format fp16` used to inherit the preset's
    `--sym --group-size 128 --ratio 1.0`, producing a command optimum-cli
    rejects and an output directory named `...-fp16-sym-g128`.
    """
    argv = _argv("--weight-format", fmt)
    assert argv[argv.index("--weight-format") + 1] == fmt
    assert "--sym" not in argv
    assert "--group-size" not in argv
    assert "--ratio" not in argv


def test_fp16_preset_and_fp16_override_agree():
    assert _argv("--preset", "fp16") == _argv("--weight-format", "fp16")


def test_derived_name_records_the_quantization():
    settings = convert.resolve_settings(convert.parse_args(["--source", "/tmp/MiniCPM5-2.6B"]))
    assert convert.derive_name("/tmp/MiniCPM5-2.6B", settings) == "MiniCPM5-2.6B-int4-sym-g128"


def test_derived_name_does_not_split_on_the_dot_in_2_6b():
    """`2.6B` must survive: an early version cut the stem on "." and produced
    a directory called `MiniCPM5-2`."""
    settings = convert.resolve_settings(
        convert.parse_args(["--source", "/tmp/MiniCPM5-2.6B", "--weight-format", "fp16"])
    )
    assert convert.derive_name("/tmp/MiniCPM5-2.6B", settings) == "MiniCPM5-2.6B-fp16"


def test_dry_run_never_executes(monkeypatch, capsys):
    called = []
    monkeypatch.setattr(convert.subprocess, "run", lambda *a, **k: called.append(a))
    rc = convert.main(["--source", "/tmp/ckpt", "--dry-run"])
    assert rc == 0
    assert called == []
    assert "optimum-cli" in capsys.readouterr().out
