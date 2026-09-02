"""Refuse a LoRA whose base model does not match the loaded one.

Applying the 1B nekoqa persona to the 2.6B base does not degrade — it
kills llama-server with a shape error and 0xC0000005, so the user gets a
wall of logs and a dead pet after picking a persona the UI offered.

A LoRA GGUF declares no dimensions of its own, but its tensor shapes give
the base geometry away (`blk.N.ffn_down.weight.lora_a` is [ffn, rank],
`ffn_gate` is [hidden, rank], and the highest `blk.N` gives layer count).

Everything fails **open**: anything unreadable returns None and loading
proceeds as before. This catches one known crash, it must not become a
new way to block a legitimate adapter.
"""

from __future__ import annotations

import re
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from .log_setup import get_logger

_BLK_RE = re.compile(r"^blk\.(\d+)\.")

# Metadata keys are architecture-prefixed, so read the arch first.
_ARCH_KEY = "general.architecture"


@dataclass(frozen=True)
class ModelGeometry:
    """The handful of dimensions a LoRA has to agree with."""

    hidden: Optional[int] = None
    ffn: Optional[int] = None
    blocks: Optional[int] = None
    arch: Optional[str] = None

    def describe(self) -> str:
        bits = []
        if self.arch:
            bits.append(self.arch)
        if self.hidden:
            bits.append(f"hidden {self.hidden}")
        if self.ffn:
            bits.append(f"ffn {self.ffn}")
        if self.blocks:
            bits.append(f"{self.blocks} layers")
        return ", ".join(bits) or "unknown"


def _read_gguf(path: Path) -> Optional[tuple[dict, list[tuple[str, list[int]]]]]:
    """Minimal GGUF header parser: (metadata, [(tensor_name, shape)]).

    Hand-rolled because pyproject keeps this gateway stdlib-only and `gguf`
    is not a dependency. Reads the KV block and tensor directory at the
    front of the file; no weights. Returns None on anything unexpected.
    """
    # GGUF value type ids → (struct format, size). Strings and arrays are
    # handled separately.
    scalars = {
        0: ("<B", 1), 1: ("<b", 1), 2: ("<H", 2), 3: ("<h", 2),
        4: ("<I", 4), 5: ("<i", 4), 6: ("<f", 4), 7: ("<?", 1),
        10: ("<Q", 8), 11: ("<q", 8), 12: ("<d", 8),
    }
    STRING, ARRAY = 8, 9

    with open(path, "rb") as fh:
        if fh.read(4) != b"GGUF":
            return None
        version, n_tensors, n_kv = struct.unpack("<Iqq", fh.read(20))
        if version < 2 or n_tensors < 0 or n_kv < 0 or n_kv > 100_000:
            return None

        def read_str() -> str:
            (length,) = struct.unpack("<Q", fh.read(8))
            if length > 1 << 20:
                raise ValueError("implausible string length")
            return fh.read(length).decode("utf-8", "replace")

        def read_value(vtype: int):
            if vtype == STRING:
                return read_str()
            if vtype == ARRAY:
                (elem_type,) = struct.unpack("<I", fh.read(4))
                (count,) = struct.unpack("<Q", fh.read(8))
                if count > 1 << 24:
                    raise ValueError("implausible array length")
                return [read_value(elem_type) for _ in range(count)]
            fmt, size = scalars[vtype]
            return struct.unpack(fmt, fh.read(size))[0]

        meta: dict = {}
        for _ in range(n_kv):
            key = read_str()
            (vtype,) = struct.unpack("<I", fh.read(4))
            meta[key] = read_value(vtype)

        tensors: list[tuple[str, list[int]]] = []
        for _ in range(n_tensors):
            name = read_str()
            (n_dims,) = struct.unpack("<I", fh.read(4))
            if n_dims > 8:
                raise ValueError("implausible tensor rank")
            dims = list(struct.unpack(f"<{n_dims}Q", fh.read(8 * n_dims)))
            fh.read(4)   # ggml dtype
            fh.read(8)   # offset
            # GGUF stores dimensions fastest-varying first.
            tensors.append((name, dims[::-1]))
        return meta, tensors


def read_base_geometry(path: Path) -> Optional[ModelGeometry]:
    """Geometry of a base model GGUF, or None if it cannot be read."""
    try:
        parsed = _read_gguf(Path(path))
        if not parsed:
            return None
        meta, _tensors = parsed
        arch = meta.get(_ARCH_KEY)
        if not isinstance(arch, str) or not arch:
            return None
        return ModelGeometry(
            hidden=_as_int(meta.get(f"{arch}.embedding_length")),
            ffn=_as_int(meta.get(f"{arch}.feed_forward_length")),
            blocks=_as_int(meta.get(f"{arch}.block_count")),
            arch=arch,
        )
    except Exception as exc:
        get_logger().debug("could not read base geometry from %s: %s", path, exc)
        return None


def read_adapter_geometry(path: Path) -> Optional[ModelGeometry]:
    """Reconstruct the base geometry a LoRA GGUF was trained against."""
    try:
        parsed = _read_gguf(Path(path))
        if not parsed:
            return None
        meta, tensors = parsed
        arch = meta.get(_ARCH_KEY)
        hidden = ffn = None
        max_block = -1
        for name, shape in tensors:
            match = _BLK_RE.match(name)
            if match:
                max_block = max(max_block, int(match.group(1)))
            if not name.endswith(".lora_a") or len(shape) < 2:
                continue
            # Larger dimension is the base one; the small one is the rank.
            base_dim = max(shape[0], shape[1])
            if ".ffn_down.weight" in name and ffn is None:
                ffn = base_dim
            elif (".attn_q.weight" in name or ".ffn_gate.weight" in name) and hidden is None:
                hidden = base_dim
        if hidden is None and ffn is None and max_block < 0:
            return None
        return ModelGeometry(
            hidden=hidden,
            ffn=ffn,
            blocks=(max_block + 1) if max_block >= 0 else None,
            arch=arch if isinstance(arch, str) else None,
        )
    except Exception as exc:
        get_logger().debug("could not read adapter geometry from %s: %s", path, exc)
        return None


def _as_int(value) -> Optional[int]:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def adapter_mismatch_reason(
    adapter_path: Path, model_path: Optional[Path]
) -> Optional[str]:
    """Human-readable reason the adapter cannot be applied, or None.

    Returns None whenever a mismatch cannot be *proven*, so this can never
    become a new failure mode of its own.
    """
    if not model_path:
        return None
    base = read_base_geometry(Path(model_path))
    lora = read_adapter_geometry(Path(adapter_path))
    if base is None or lora is None:
        return None

    if base.arch and lora.arch and base.arch != lora.arch:
        return (
            f"adapter targets a '{lora.arch}' model but "
            f"{Path(model_path).name} is '{base.arch}'"
        )

    for label, got, want in (
        ("hidden size", lora.hidden, base.hidden),
        ("FFN size", lora.ffn, base.ffn),
        ("layer count", lora.blocks, base.blocks),
    ):
        if got and want and got != want:
            return (
                f"adapter was trained for a different base model — {label} "
                f"{got} vs {want} in {Path(model_path).name} "
                f"(adapter: {lora.describe()}; model: {base.describe()}). "
                "Applying it would crash the inference server."
            )
    return None
