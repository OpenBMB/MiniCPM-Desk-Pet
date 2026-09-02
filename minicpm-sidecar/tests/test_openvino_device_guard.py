"""Never hand the NPU an IR it will die on.

`LLMPipeline(ir, "NPU")` accepts an INT8 weight-only IR without a warning
and then kills the process from inside `generate()` with a 0xC0000005
access violation — no Python traceback, no log line, the sidecar just
disappears (openvinotoolkit/openvino#35641). There is nothing to catch and
nothing to report, so the only defence is refusing before the pipeline is
ever constructed.

That makes these the highest-stakes tests in the backend, and it is why
the guard **fails closed**: an IR whose precision we cannot determine is
treated as unsafe. A false positive costs one clear error message; a false
negative costs the user's whole desk pet with no diagnostics.

The negative assertion in `test_int8_ir_never_reaches_pipeline_construction`
is the one that actually matters — it proves we bail *before* the native
call, not merely that we log something afterwards.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from gateway import openvino_client as ov
from gateway import server as server_mod


# ── Fixtures ────────────────────────────────────────────────────────────────


def _write_ir(root: Path, name: str, *, meta: dict | None = None) -> Path:
    """A structurally complete IR. Contents are irrelevant — nothing here
    loads it, only inspects filenames and sidecar metadata."""
    d = root / name
    d.mkdir(parents=True, exist_ok=True)
    for f in ov.OPENVINO_IR_FILES:
        (d / f).write_text("", encoding="utf-8")
    if meta is not None:
        (d / ".minicpm-ir.json").write_text(json.dumps(meta), encoding="utf-8")
    return d


@pytest.fixture
def int4_sym_ir(tmp_path: Path) -> Path:
    return _write_ir(tmp_path, "npu-ok", meta={
        "weight_format": "int4", "sym": True, "group_size": 128, "ratio": 1.0,
    })


@pytest.fixture
def int8_ir(tmp_path: Path) -> Path:
    return _write_ir(tmp_path, "int8", meta={"weight_format": "int8", "sym": False})


# ── Precision inspection ────────────────────────────────────────────────────


def test_sidecar_metadata_is_preferred_over_everything(int4_sym_ir: Path):
    p = ov.inspect_ir_precision(int4_sym_ir)
    assert p.weight_format == "int4"
    assert p.sym is True
    assert p.group_size == 128
    assert p.source == ".minicpm-ir.json"
    assert p.npu_ready is True


def test_optimum_config_is_skipped_when_it_says_nothing_useful(tmp_path: Path):
    # A plain `--weight-format int8` export writes dtype:"" and no bits —
    # observed on a real optimum 2.3.0 export. Trusting it would report
    # weight_format="" and mask the real precision, so this layer has to
    # fall through to reading the IR.
    d = _write_ir(tmp_path, "stub")
    (d / "openvino_config.json").write_text(
        json.dumps({"dtype": "", "quantization_config": {"quant_method": "default"}}),
        encoding="utf-8",
    )
    assert ov.inspect_ir_precision(d).source != "openvino_config.json"


def test_unreadable_precision_reports_unknown(tmp_path: Path):
    d = _write_ir(tmp_path, "bare")
    p = ov.inspect_ir_precision(d)
    assert p.weight_format == "unknown"
    assert p.npu_ready is False


# ── The guard itself ────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "meta",
    [
        {"weight_format": "int8", "sym": False},
        {"weight_format": "int8", "sym": True},   # symmetric INT8 is still not INT4
        {"weight_format": "int4", "sym": False},  # asymmetric INT4 is still refused
        {"weight_format": "fp16", "sym": None},
        {"weight_format": "unknown", "sym": None},
    ],
)
def test_guard_refuses_everything_that_is_not_sym_int4(tmp_path: Path, meta: dict):
    d = _write_ir(tmp_path, "bad", meta=meta)
    with pytest.raises(ov.NpuPrecisionError) as excinfo:
        ov.assert_npu_compatible(ov.inspect_ir_precision(d), d)
    # The message has to be actionable, not just correct.
    assert "convert-openvino.py" in str(excinfo.value)
    assert "--preset npu" in str(excinfo.value)


def test_guard_passes_symmetric_int4(int4_sym_ir: Path):
    ov.assert_npu_compatible(ov.inspect_ir_precision(int4_sym_ir), int4_sym_ir)


def test_int8_ir_never_reaches_pipeline_construction(int8_ir: Path, monkeypatch):
    """The whole point: bail *before* the native call, not after."""
    constructed: list = []

    class _ExplodingPipeline:
        def __init__(self, *args, **kwargs):
            constructed.append(args)
            raise AssertionError("LLMPipeline must not be constructed for int8+NPU")

    engine = ov.OpenVinoEngine(model_path=int8_ir)
    engine.precision = ov.inspect_ir_precision(int8_ir)
    engine._genai = type("_G", (), {"LLMPipeline": _ExplodingPipeline})
    monkeypatch.setenv("MINICPM_DEVICE", "npu")
    monkeypatch.setenv("MINICPM_OV_NPU_FALLBACK", "0")
    monkeypatch.setattr(
        ov, "detect_devices",
        lambda: {"available": ["gpu", "cpu", "npu"], "recommended": "gpu",
                 "current": "npu", "experimental": ["npu"], "reasons": {}},
    )

    with pytest.raises(ov.NpuPrecisionError):
        engine._resolve_device()

    assert constructed == []


def test_fallback_downgrades_instead_of_failing_by_default(int8_ir: Path, monkeypatch):
    # Mirrors the existing Vulkan→CPU product behaviour: explain and
    # degrade rather than refuse to boot.
    engine = ov.OpenVinoEngine(model_path=int8_ir)
    engine.precision = ov.inspect_ir_precision(int8_ir)
    monkeypatch.setenv("MINICPM_DEVICE", "npu")
    monkeypatch.delenv("MINICPM_OV_NPU_FALLBACK", raising=False)
    monkeypatch.setattr(
        ov, "detect_devices",
        lambda: {"available": ["gpu", "cpu", "npu"], "recommended": "gpu",
                 "current": "npu", "experimental": ["npu"], "reasons": {}},
    )

    assert engine._resolve_device() == "gpu"
    assert engine.device_fallback and "sym-INT4" in engine.device_fallback


# ── Device normalisation ────────────────────────────────────────────────────


@pytest.mark.parametrize("raw", ["metal", "mps", "cuda", "vulkan"])
def test_llama_device_names_never_leak_into_openvino(raw, monkeypatch):
    # MINICPM_DEVICE is shared between both backends and persisted by
    # Electron. Passing "metal" through verbatim would hand ov::Core a
    # device it has never heard of and produce an opaque native throw.
    monkeypatch.delenv("MINICPM_DEVICE", raising=False)
    got = ov._normalise_ov_device(raw, available=["gpu", "cpu", "npu"])
    assert got == "gpu"
    assert got not in ("metal", "mps", "cuda", "vulkan")


def test_auto_never_selects_npu(monkeypatch):
    # The NPU needs a specially quantised IR and has reduced sampling, so
    # it must stay opt-in even when present.
    monkeypatch.delenv("MINICPM_DEVICE", raising=False)
    assert ov._normalise_ov_device("auto", available=["npu", "cpu"]) == "cpu"
    assert ov._normalise_ov_device("", available=["gpu", "cpu", "npu"]) == "gpu"


# ── /api/set-device ─────────────────────────────────────────────────────────


def _client(monkeypatch, model: Path | None):
    monkeypatch.setattr(
        ov, "detect_devices",
        lambda: {"available": ["gpu", "cpu", "npu"], "recommended": "gpu",
                 "current": "gpu", "experimental": ["npu"], "reasons": {}},
    )
    app = server_mod.build_app(initial_model=model, backend="openvino")
    return TestClient(app)


def test_set_device_rejects_npu_for_an_int8_model(int8_ir: Path, monkeypatch):
    monkeypatch.setenv("MINICPM_DEVICE", "gpu")
    with _client(monkeypatch, int8_ir) as client:
        response = client.post("/api/set-device", json={"device": "npu"})

    assert response.status_code == 400
    assert "symmetric INT4" in response.json()["error"]
    # Rejection must not mutate the env — same convention as the existing
    # vulkan-off-Windows test in test_backend_selection.py.
    assert ov.os.environ["MINICPM_DEVICE"] == "gpu"


def test_set_device_rejects_llama_device_names(int8_ir: Path, monkeypatch):
    monkeypatch.setenv("MINICPM_DEVICE", "gpu")
    with _client(monkeypatch, int8_ir) as client:
        response = client.post("/api/set-device", json={"device": "vulkan"})

    assert response.status_code == 400
    assert "unknown device" in response.json()["error"]
    assert ov.os.environ["MINICPM_DEVICE"] == "gpu"


def test_set_device_accepts_npu_for_a_sym_int4_model(int4_sym_ir: Path, monkeypatch):
    monkeypatch.setenv("MINICPM_DEVICE", "gpu")
    with _client(monkeypatch, int4_sym_ir) as client:
        response = client.post("/api/set-device", json={"device": "npu"})

    assert response.status_code == 200
    assert ov.os.environ["MINICPM_DEVICE"] == "npu"
