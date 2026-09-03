"""Exercise the discover_models helper used by /api/models.

A model is an OpenVINO IR *directory*, so discovery has to recognise a
directory as the unit and refuse the half-written ones the conversion
script leaves behind.
"""

from __future__ import annotations

from pathlib import Path

from gateway.openvino_client import OPENVINO_IR_FILES
from gateway.server import discover_models


def make_ir(directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    for name in OPENVINO_IR_FILES:
        (directory / name).write_bytes(b"x")
    return directory


def test_discover_finds_ir_directories_recursively(tmp_path: Path) -> None:
    make_ir(tmp_path / "MiniCPM5-2.6B-int4-sym-g128")
    make_ir(tmp_path / "nested" / "MiniCPM5-1B-int8")
    (tmp_path / "notes.txt").write_bytes(b"x")

    names = sorted(item["name"] for item in discover_models([tmp_path]))
    assert names == ["MiniCPM5-1B-int8", "MiniCPM5-2.6B-int4-sym-g128"]


def test_discover_accepts_a_root_that_is_itself_an_ir(tmp_path: Path) -> None:
    ir = make_ir(tmp_path / "ir")
    items = discover_models([ir])
    assert [it["name"] for it in items] == ["ir"]
    assert items[0]["kind"] == "openvino"


def test_discover_skips_partial_and_staging_directories(tmp_path: Path) -> None:
    make_ir(tmp_path / "good")
    # convert-openvino.py exports here before the atomic rename; a truncated
    # .bin would hang boot.
    make_ir(tmp_path / "good.partial")
    make_ir(tmp_path / "old.bak")
    make_ir(tmp_path / "x.update-staging")

    assert [it["name"] for it in discover_models([tmp_path])] == ["good"]


def test_discover_ignores_a_directory_missing_the_tokenizer_pair(tmp_path: Path) -> None:
    incomplete = tmp_path / "half"
    incomplete.mkdir()
    (incomplete / "openvino_model.xml").write_bytes(b"x")
    (incomplete / "openvino_model.bin").write_bytes(b"x")

    assert discover_models([tmp_path]) == []


def test_discover_ignores_gguf_files(tmp_path: Path) -> None:
    """A leftover .gguf from a llama.cpp install is not a model here."""
    (tmp_path / "MiniCPM5-2.6B-Q4_K_M.gguf").write_bytes(b"GGUF")

    assert discover_models([tmp_path]) == []


def test_discover_dedupes_nested_roots(tmp_path: Path) -> None:
    make_ir(tmp_path / "models" / "ir")

    items = discover_models([tmp_path, tmp_path / "models", tmp_path / "models" / "ir"])
    assert [it["name"] for it in items] == ["ir"]
