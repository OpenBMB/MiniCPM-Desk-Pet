"""Never hand llama-server a LoRA trained on a different base.

Activating the bundled 1B nekoqa persona while the 2.6B base is loaded
does not degrade gracefully — llama-server dies with a shape error and
0xC0000005, so the user gets a wall of logs and a dead desk pet after
doing nothing worse than clicking a persona the UI offered them
(reported 2026-09-02).

The geometry is reconstructed from the LoRA's own tensor shapes, since a
LoRA GGUF carries no embedding_length of its own:

    blk.N.ffn_down.weight.lora_a  ->  [ffn,    rank]
    blk.N.ffn_gate.weight.lora_a  ->  [hidden, rank]

Every helper fails **open**: unreadable file, missing base, unfamiliar
layout all mean "cannot tell", and loading proceeds as before. The guard
catches the one mismatch we know crashes — it must never become a new
way to block a legitimate adapter.
"""

from __future__ import annotations

import struct
from pathlib import Path

from gateway.adapter_compat import (
    ModelGeometry,
    adapter_mismatch_reason,
    read_adapter_geometry,
    read_base_geometry,
)

GGUF_STRING, GGUF_ARRAY, GGUF_UINT32 = 8, 9, 4


def _w_str(fh, s: str) -> None:
    raw = s.encode("utf-8")
    fh.write(struct.pack("<Q", len(raw)))
    fh.write(raw)


def _write_gguf(path: Path, meta: dict, tensors: list[tuple[str, list[int]]]) -> Path:
    """Minimal GGUF writer, just enough for the parser under test."""
    with open(path, "wb") as fh:
        fh.write(b"GGUF")
        fh.write(struct.pack("<Iqq", 3, len(tensors), len(meta)))
        for key, value in meta.items():
            _w_str(fh, key)
            if isinstance(value, str):
                fh.write(struct.pack("<I", GGUF_STRING))
                _w_str(fh, value)
            else:
                fh.write(struct.pack("<I", GGUF_UINT32))
                fh.write(struct.pack("<I", int(value)))
        for name, shape in tensors:
            _w_str(fh, name)
            # the parser reverses dims, so store them reversed here
            dims = list(reversed(shape))
            fh.write(struct.pack("<I", len(dims)))
            fh.write(struct.pack(f"<{len(dims)}Q", *dims))
            fh.write(struct.pack("<I", 0))   # dtype
            fh.write(struct.pack("<Q", 0))   # offset
    return path


def _base(path: Path, *, hidden: int, ffn: int, blocks: int, arch: str = "llama") -> Path:
    return _write_gguf(path, {
        "general.architecture": arch,
        f"{arch}.embedding_length": hidden,
        f"{arch}.feed_forward_length": ffn,
        f"{arch}.block_count": blocks,
    }, [("output.weight", [hidden, 130560])])


def _lora(path: Path, *, hidden: int, ffn: int, blocks: int, rank: int = 16,
          arch: str = "llama") -> Path:
    tensors = []
    for i in range(blocks):
        tensors += [
            (f"blk.{i}.ffn_down.weight.lora_a", [ffn, rank]),
            (f"blk.{i}.ffn_gate.weight.lora_a", [hidden, rank]),
        ]
    return _write_gguf(path, {
        "general.architecture": arch,
        "general.type": "adapter",
        "adapter.type": "lora",
    }, tensors)


# ── Geometry reconstruction ────────────────────────────────────────────────


def test_base_geometry_is_read_from_metadata(tmp_path):
    p = _base(tmp_path / "b.gguf", hidden=1536, ffn=4608, blocks=24)
    assert read_base_geometry(p) == ModelGeometry(1536, 4608, 24, "llama")


def test_adapter_geometry_is_reconstructed_from_tensor_shapes(tmp_path):
    p = _lora(tmp_path / "l.gguf", hidden=1536, ffn=4608, blocks=24)
    got = read_adapter_geometry(p)
    assert (got.hidden, got.ffn, got.blocks) == (1536, 4608, 24)


# ── The guard ──────────────────────────────────────────────────────────────


def test_matching_pair_is_allowed(tmp_path):
    base = _base(tmp_path / "b.gguf", hidden=1536, ffn=4608, blocks=24)
    lora = _lora(tmp_path / "l.gguf", hidden=1536, ffn=4608, blocks=24)
    assert adapter_mismatch_reason(lora, base) is None


def test_hidden_size_mismatch_is_refused(tmp_path):
    base = _base(tmp_path / "b.gguf", hidden=2048, ffn=6144, blocks=42)
    lora = _lora(tmp_path / "l.gguf", hidden=1536, ffn=4608, blocks=24)
    reason = adapter_mismatch_reason(lora, base)
    assert reason and "1536" in reason and "2048" in reason


def test_layer_count_mismatch_is_refused(tmp_path):
    base = _base(tmp_path / "b.gguf", hidden=1536, ffn=4608, blocks=42)
    lora = _lora(tmp_path / "l.gguf", hidden=1536, ffn=4608, blocks=24)
    assert adapter_mismatch_reason(lora, base)


def test_architecture_mismatch_is_refused(tmp_path):
    base = _base(tmp_path / "b.gguf", hidden=1536, ffn=4608, blocks=24, arch="qwen2")
    lora = _lora(tmp_path / "l.gguf", hidden=1536, ffn=4608, blocks=24, arch="llama")
    assert adapter_mismatch_reason(lora, base)


# ── Fail-open behaviour (the important half) ───────────────────────────────


def test_no_base_model_loaded_allows_everything(tmp_path):
    lora = _lora(tmp_path / "l.gguf", hidden=1536, ffn=4608, blocks=24)
    assert adapter_mismatch_reason(lora, None) is None


def test_unreadable_adapter_is_allowed(tmp_path):
    base = _base(tmp_path / "b.gguf", hidden=1536, ffn=4608, blocks=24)
    junk = tmp_path / "junk.gguf"
    junk.write_bytes(b"not a gguf at all")
    assert adapter_mismatch_reason(junk, base) is None


def test_missing_file_is_allowed(tmp_path):
    base = _base(tmp_path / "b.gguf", hidden=1536, ffn=4608, blocks=24)
    assert adapter_mismatch_reason(tmp_path / "nope.gguf", base) is None


def test_partial_geometry_only_compares_what_it_knows(tmp_path):
    # A LoRA that only touches attention has no ffn_down tensors; the ffn
    # dimension is unknown and must not be treated as a mismatch.
    base = _base(tmp_path / "b.gguf", hidden=1536, ffn=4608, blocks=24)
    lora = _write_gguf(tmp_path / "l.gguf", {
        "general.architecture": "llama", "adapter.type": "lora",
    }, [(f"blk.{i}.attn_q.weight.lora_a", [1536, 16]) for i in range(24)])
    assert adapter_mismatch_reason(lora, base) is None
