"""Exercise the discover_models helper used by /api/models."""

from __future__ import annotations

from pathlib import Path

from gateway.server import discover_models


def test_discover_finds_gguf_recursively(tmp_path: Path) -> None:
    (tmp_path / "a.gguf").write_bytes(b"x")
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "b.gguf").write_bytes(b"x")
    (tmp_path / "ignore.txt").write_bytes(b"x")

    items = discover_models([tmp_path])
    names = sorted(item["name"] for item in items)
    assert names == ["a.gguf", "b.gguf"]


def test_discover_skips_staging_and_backup(tmp_path: Path) -> None:
    (tmp_path / "models.gguf").write_bytes(b"x")
    (tmp_path / "models.update-staging").mkdir()
    (tmp_path / "models.update-staging" / "x.gguf").write_bytes(b"x")
    (tmp_path / "models.bak").mkdir()
    (tmp_path / "models.bak" / "y.gguf").write_bytes(b"x")

    items = discover_models([tmp_path])
    assert [it["name"] for it in items] == ["models.gguf"]


def test_discover_accepts_direct_file(tmp_path: Path) -> None:
    f = tmp_path / "single.gguf"
    f.write_bytes(b"x")
    items = discover_models([f])
    assert len(items) == 1
    assert items[0]["name"] == "single.gguf"
