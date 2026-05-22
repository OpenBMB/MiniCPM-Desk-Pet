"""Exercise the discover_adapters / _persona_for / _resolve_adapter_root
helpers used by /api/adapters and /api/load-adapter. These run on every
sidecar boot, so a regression here would break the Settings UI for every
user simultaneously — keep them tight."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from gateway.server import (
    PERSONA_HINTS,
    _persona_for,
    _resolve_adapter_root,
    discover_adapters,
)


def test_discover_finds_gguf_recursively(tmp_path: Path) -> None:
    (tmp_path / "a.gguf").write_bytes(b"x")
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "b.gguf").write_bytes(b"x")
    (tmp_path / "ignore.txt").write_bytes(b"x")
    (tmp_path / "not_a_lora.safetensors").write_bytes(b"x")

    items = discover_adapters([tmp_path])
    names = sorted(it["name"] for it in items)
    assert names == ["a.gguf", "b.gguf"]
    for it in items:
        assert set(it.keys()) >= {"name", "path", "persona"}


def test_discover_skips_staging_and_backup(tmp_path: Path) -> None:
    (tmp_path / "real.gguf").write_bytes(b"x")
    (tmp_path / "incoming.update-staging").mkdir()
    (tmp_path / "incoming.update-staging" / "half.gguf").write_bytes(b"x")
    (tmp_path / "old.bak").mkdir()
    (tmp_path / "old.bak" / "prev.gguf").write_bytes(b"x")

    items = discover_adapters([tmp_path])
    assert [it["name"] for it in items] == ["real.gguf"]


def test_discover_dedupes_across_overlapping_roots(tmp_path: Path) -> None:
    shared = tmp_path / "shared"
    shared.mkdir()
    (shared / "lora.gguf").write_bytes(b"x")
    # Use both the direct path and its parent — same file should only
    # appear once in the result.
    items = discover_adapters([shared, tmp_path])
    assert [it["name"] for it in items] == ["lora.gguf"]


def test_discover_handles_missing_root(tmp_path: Path) -> None:
    missing = tmp_path / "nope"
    items = discover_adapters([missing])
    assert items == []


@pytest.mark.parametrize(
    "filename,expected",
    [
        ("lora_nekoqa_adapter_20260515.gguf", "neko"),
        ("lora_neko.gguf", "neko"),
        ("muice_v1.gguf", "muice"),
        ("lora_chuuni_20260519.gguf", "chuuni"),
        ("lora_moyu_20260519.gguf", "moyu"),
        ("lora_zhiyuan_recite_short_v9.gguf", "zhiyuan"),
        ("random_lora.gguf", "custom"),
    ],
)
def test_persona_for_matches_filename_hints(filename: str, expected: str) -> None:
    p = Path("/tmp/some_dir") / filename
    assert _persona_for(p) == expected


def test_persona_hints_are_lowercase() -> None:
    # Defensive — _persona_for lowercases its input, so the lookup table
    # must already be lowercase to match.
    for key in PERSONA_HINTS:
        assert key == key.lower()


def test_resolve_adapter_root_prefers_env(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("MINICPM_ADAPTER_DIR", str(tmp_path / "from-env"))
    root = _resolve_adapter_root(None)
    assert root == tmp_path / "from-env"


def test_resolve_adapter_root_falls_back_to_default(monkeypatch) -> None:
    monkeypatch.delenv("MINICPM_ADAPTER_DIR", raising=False)
    root = _resolve_adapter_root(None)
    # Without the env var we still want *some* writable target so the
    # Settings UI's "open folder" can mkdir it.
    assert root is not None
