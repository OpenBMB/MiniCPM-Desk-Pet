"""Never hand the NPU an IR it cannot run.

Measured on Core Ultra 5 225H / AI Boost, openvino 2026.3.1, NPU driver
32.0.100.4778, 2.6B model, 16 GB machine — long prompt, 256 tokens, 4 runs:

    int4-sym-g128   all runs fine
    fp16            all runs fine, ~2x the throughput of int4
    int8            ZE_RESULT_ERROR_OUT_OF_HOST_MEMORY at the first
                    generate(), reproducibly

So the guard refuses INT8 (and anything unreadable), not "everything that
is not INT4". `LLMPipeline(ir, "NPU")` constructs happily for all three, so
the check has to happen before that call rather than relying on it to fail.

The guard still **fails closed** on `unknown`: an IR whose precision cannot
be read could be int8. A false positive costs one clear error message.

Note: openvinotoolkit/openvino#35641 reports an *uncatchable* 0xC0000005 for
this combination. That did not reproduce on this stack — the failure here is
an ordinary catchable RuntimeError — but the combination is still outside
the documented NPU matrix, so it stays refused.
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
        {"weight_format": "int8", "sym": True},   # symmetric INT8 is still int8
        {"weight_format": "int4", "sym": False},  # asymmetric INT4 is undocumented
        {"weight_format": "unknown", "sym": None},
    ],
)
def test_guard_refuses_int8_and_anything_unreadable(tmp_path: Path, meta: dict):
    d = _write_ir(tmp_path, "bad", meta=meta)
    with pytest.raises(ov.NpuPrecisionError) as excinfo:
        ov.assert_npu_compatible(ov.inspect_ir_precision(d), d)
    # The message has to be actionable, not just correct.
    assert "convert-openvino.py" in str(excinfo.value)


@pytest.mark.parametrize(
    "meta",
    [
        {"weight_format": "fp16", "sym": False},   # optimum writes sym=false here
        {"weight_format": "fp32", "sym": None},
    ],
)
def test_guard_allows_uncompressed_weights(tmp_path: Path, meta: dict):
    """Measured: FP16 runs on the NPU. Refusing it cost real functionality
    and the refusal cited a crash that does not happen."""
    d = _write_ir(tmp_path, "plain", meta=meta)
    ov.assert_npu_compatible(ov.inspect_ir_precision(d), d)


def test_uncompressed_describe_omits_quantization_noise(tmp_path: Path):
    d = _write_ir(tmp_path, "plain", meta={"weight_format": "fp16", "sym": False})
    assert ov.inspect_ir_precision(d).describe() == "fp16"


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
    assert engine.device_fallback and "int8" in engine.device_fallback


# ── Device normalisation ────────────────────────────────────────────────────


@pytest.mark.parametrize("raw", ["metal", "mps", "cuda", "vulkan", "cpu"])
def test_retired_device_names_migrate_to_gpu(raw, monkeypatch):
    # MINICPM_DEVICE persists across versions, so an upgraded machine may
    # still have one of these stored.
    monkeypatch.delenv("MINICPM_DEVICE", raising=False)
    got = ov._normalise_ov_device(raw)
    assert got == "gpu"
    assert got not in ("metal", "mps", "cuda", "vulkan", "cpu")


def test_auto_never_selects_npu(monkeypatch):
    # The NPU needs a specially quantised IR and has reduced sampling, so
    # it must stay opt-in even when present.
    monkeypatch.delenv("MINICPM_DEVICE", raising=False)
    assert ov._normalise_ov_device("auto") == "gpu"
    assert ov._normalise_ov_device("") == "gpu"


# ── This build offers accelerators only ─────────────────────────────────────


def _fake_core(devices: list[str]):
    class _Core:
        available_devices = devices

    return type("_OV", (), {"Core": lambda self=None: _Core()})()


def test_cpu_is_never_offered_even_though_openvino_exposes_it(monkeypatch):
    # ov::Core always reports CPU, so this is the Intel-accelerator picker.
    ov.invalidate_device_cache()
    monkeypatch.setattr(ov, "_import_openvino", lambda: _fake_core(["CPU", "GPU", "NPU"]))
    monkeypatch.delenv("MINICPM_DEVICE", raising=False)

    info = ov.detect_devices()
    assert info["available"] == ["gpu", "npu"]
    assert "cpu" not in info["available"]
    assert "cpu" not in info["reasons"]
    assert info["recommended"] == "gpu"
    assert info["experimental"] == ["npu"]


def test_gpu_ordinals_collapse_to_one_entry(monkeypatch):
    ov.invalidate_device_cache()
    monkeypatch.setattr(ov, "_import_openvino", lambda: _fake_core(["CPU", "GPU.0", "GPU.1"]))
    monkeypatch.delenv("MINICPM_DEVICE", raising=False)

    assert ov.detect_devices()["available"] == ["gpu"]


def test_empty_device_list_is_reported_as_a_broken_runtime(int4_sym_ir: Path, monkeypatch):
    """Reporting no devices at all means the plugin libraries are missing —
    a mis-built bundle, not absent hardware."""
    ov.invalidate_device_cache()
    monkeypatch.setattr(ov, "_import_openvino", lambda: _fake_core([]))
    monkeypatch.delenv("MINICPM_DEVICE", raising=False)

    assert ov.detect_devices()["runtime_ok"] is False

    engine = ov.OpenVinoEngine(model_path=int4_sym_ir)
    with pytest.raises(ov.NoAcceleratorError) as excinfo:
        engine._resolve_device()
    assert "OpenVINO 运行时不完整" in str(excinfo.value)


def test_machine_without_an_intel_accelerator_fails_with_a_readable_error(
    int4_sym_ir: Path, monkeypatch
):
    # The one failure mode dropping CPU introduces — it has to be a
    # sentence, never a native LLMPipeline throw.
    ov.invalidate_device_cache()
    monkeypatch.setattr(ov, "_import_openvino", lambda: _fake_core(["CPU"]))
    monkeypatch.delenv("MINICPM_DEVICE", raising=False)
    built = []
    monkeypatch.setattr(
        ov.OpenVinoEngine, "_build_pipeline",
        lambda self: built.append(self.device),
    )

    engine = ov.OpenVinoEngine(model_path=int4_sym_ir)
    with pytest.raises(ov.NoAcceleratorError) as excinfo:
        engine._resolve_device()

    assert "Intel Arc" in str(excinfo.value)
    assert ov.detect_devices()["runtime_ok"] is True   # CPU seen, just filtered
    assert built == []


# ── /api/health must not lie about the device ───────────────────────────────


def test_health_reports_the_device_the_engine_actually_used(int8_ir: Path, monkeypatch):
    """A fallback must be visible in `accel`, not just buried in `engine`.

    Reporting the *requested* device here made "INT8 on the NPU" look like a
    working combination: the guard had quietly degraded to the GPU but the
    Settings picker kept showing NPU selected.
    """
    monkeypatch.setenv("MINICPM_DEVICE", "npu")
    monkeypatch.setattr(
        ov, "detect_devices",
        lambda: {"available": ["gpu", "npu"], "recommended": "gpu",
                 "current": "npu", "experimental": ["npu"], "reasons": {}},
    )
    monkeypatch.setattr(ov.OpenVinoEngine, "_build_pipeline", lambda self: None)
    monkeypatch.setattr(ov.OpenVinoEngine, "alive", property(lambda self: True))

    app = server_mod.build_app(initial_model=int8_ir)
    with TestClient(app) as client:
        body = client.get("/api/health").json()

    assert body["accel"] == "gpu"
    assert body["device"] == "gpu"
    assert body["requested_device"] == "npu"
    assert "int8" in (body["device_fallback"] or "")


# ── /api/set-device ─────────────────────────────────────────────────────────


def _client(monkeypatch, model: Path | None):
    monkeypatch.setattr(
        ov, "detect_devices",
        lambda: {"available": ["gpu", "npu"], "recommended": "gpu",
                 "current": "gpu", "experimental": ["npu"], "reasons": {}},
    )
    app = server_mod.build_app(initial_model=model)
    return TestClient(app)


def test_set_device_rejects_npu_for_an_int8_model(int8_ir: Path, monkeypatch):
    monkeypatch.setenv("MINICPM_DEVICE", "gpu")
    with _client(monkeypatch, int8_ir) as client:
        response = client.post("/api/set-device", json={"device": "npu"})

    assert response.status_code == 400
    assert "symmetric INT4" in response.json()["error"]
    # Rejection must not mutate the env — same convention as the other
    # rejected-device tests below.
    assert ov.os.environ["MINICPM_DEVICE"] == "gpu"


@pytest.mark.parametrize("device", ["vulkan", "metal", "cuda", "cpu"])
def test_set_device_rejects_devices_this_build_does_not_offer(
    device, int8_ir: Path, monkeypatch
):
    monkeypatch.setenv("MINICPM_DEVICE", "gpu")
    with _client(monkeypatch, int8_ir) as client:
        response = client.post("/api/set-device", json={"device": device})

    assert response.status_code == 400
    assert "unknown device" in response.json()["error"]
    # Rejection must not mutate the env.
    assert ov.os.environ["MINICPM_DEVICE"] == "gpu"


def test_set_device_accepts_npu_for_a_sym_int4_model(int4_sym_ir: Path, monkeypatch):
    monkeypatch.setenv("MINICPM_DEVICE", "gpu")
    with _client(monkeypatch, int4_sym_ir) as client:
        response = client.post("/api/set-device", json={"device": "npu"})

    assert response.status_code == 200
    assert ov.os.environ["MINICPM_DEVICE"] == "npu"
