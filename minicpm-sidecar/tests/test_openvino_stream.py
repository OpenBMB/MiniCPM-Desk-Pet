"""The OpenVINO stream has to arrive shaped the way ThinkBlockFilter expects.

Everything here is checked against a fake `openvino_genai`, so the suite
runs on machines without the extra installed.

Two behaviours are load-bearing and were both established by measuring the
real 2.6B checkpoint rather than by reading the template:

  1. **The model emits `<think>` itself.** The chat template also prefills
     `<think>\\n` into the prompt, which suggests the model would only ever
     emit the *closing* tag — but it opens its own regardless (verified
     with the marker present, absent, and pre-closed). Injecting one
     unconditionally therefore doubles it and drops a stray "<think>" into
     the reasoning bubble. Hence the lookahead: synthesise only when the
     stream did not supply one, so a future runtime that behaves the other
     way still works.

  2. **`thinking=false` does not skip reasoning, it only hides it.** So the
     hidden reasoning still spends the token budget, and without a floor a
     sampled reply can burn the whole allowance before `</think>` and leave
     the user with an empty bubble.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from gateway import openvino_client as ov
from gateway.think_filter import ThinkBlockFilter


# ── A stand-in for openvino_genai ───────────────────────────────────────────


class _FakeConfig:
    def __init__(self):
        self.max_new_tokens = 0
        self.do_sample = False
        self.temperature = None
        self.top_p = None
        self.top_k = None
        self.repetition_penalty = None
        self.stop_token_ids = None


class _FakeTokenizer:
    def __init__(self):
        self.calls: list[dict] = []

    def apply_chat_template(self, messages, add_generation_prompt=True, **kwargs):
        self.calls.append(dict(kwargs))
        tail = "<think>\n" if kwargs.get("extra_context", {}).get("enable_thinking") else ""
        return "PROMPT" + tail


class _FakePipeline:
    """Records concurrency and replays a canned chunk list."""

    def __init__(self, chunks: list[str]):
        self.chunks = chunks
        self.tokenizer = _FakeTokenizer()
        self.configs: list[_FakeConfig] = []
        self.in_flight = 0
        self.max_in_flight = 0
        self.stopped_early = False

    def get_tokenizer(self):
        return self.tokenizer

    def generate(self, prompt, config, streamer=None):
        self.in_flight += 1
        self.max_in_flight = max(self.max_in_flight, self.in_flight)
        self.configs.append(config)
        try:
            for chunk in self.chunks:
                if streamer is not None and streamer(chunk) is True:
                    self.stopped_early = True
                    break
            return type("_R", (), {"texts": ["".join(self.chunks)]})()
        finally:
            self.in_flight -= 1


class _FakeGenai:
    GenerationConfig = _FakeConfig
    # No StreamingStatus attribute → exercises the legacy bool protocol.


def _engine(chunks: list[str], tmp_path: Path) -> ov.OpenVinoEngine:
    eng = ov.OpenVinoEngine(model_path=tmp_path)
    eng._genai = _FakeGenai
    eng._pipe = _FakePipeline(chunks)
    eng._tokenizer = eng._pipe.get_tokenizer()
    eng._supports_extra_context = True
    eng.device = "gpu"
    return eng


async def _collect(eng, **kwargs):
    defaults = dict(max_tokens=128, temperature=0.7, top_p=0.95, top_k=0,
                    repetition_penalty=1.05, enable_thinking=True)
    defaults.update(kwargs)
    out = []
    async for item in eng.stream_chat(messages=[{"role": "user", "content": "hi"}], **defaults):
        out.append(item)
    return out


# ── The <think> lookahead ───────────────────────────────────────────────────


def test_opening_tag_is_not_duplicated_when_the_model_supplies_it(tmp_path):
    eng = _engine(["<think>\n", "reasoning", "</think>", "answer"], tmp_path)
    got = asyncio.run(_collect(eng))
    joined = "".join(text for _kind, text in got)

    assert joined.count("<think>") == 1
    assert joined.startswith("<think>\n")


def test_opening_tag_is_synthesised_when_the_model_omits_it(tmp_path):
    eng = _engine(["reasoning", "</think>", "answer"], tmp_path)
    joined = "".join(t for _k, t in asyncio.run(_collect(eng)))

    assert joined.startswith("<think>\n")
    assert joined.count("<think>") == 1


def test_lookahead_survives_a_tag_split_across_chunks(tmp_path):
    eng = _engine(["<th", "ink>", "\nreasoning", "</think>", "answer"], tmp_path)
    joined = "".join(t for _k, t in asyncio.run(_collect(eng)))

    assert joined.count("<think>") == 1


def test_no_tag_is_synthesised_when_thinking_is_off(tmp_path):
    eng = _engine(["plain answer"], tmp_path)
    joined = "".join(t for _k, t in asyncio.run(_collect(eng, enable_thinking=False)))

    assert "<think>" not in joined


def test_stream_pipes_cleanly_into_the_shared_think_filter(tmp_path):
    eng = _engine(["<think>\n", "why I said it", "</think>", "\n\n", "the reply"], tmp_path)
    filt = ThinkBlockFilter(expose=True)
    think, delta = [], []
    for _kind, text in asyncio.run(_collect(eng)):
        for ev in filt.feed(text):
            (think if ev["event"] == "think" else delta).append(ev["content"])
    for ev in filt.flush():
        (think if ev["event"] == "think" else delta).append(ev["content"])

    assert "why I said it" in "".join(think)
    assert "<think>" not in "".join(think)   # the tag itself never leaks through
    assert "".join(delta).strip() == "the reply"


def test_only_content_events_are_emitted(tmp_path):
    # OpenVINO cannot pre-split reasoning the way llama-server does, so the
    # engine must never claim to — ThinkBlockFilter owns the split.
    eng = _engine(["<think>\n", "a", "</think>", "b"], tmp_path)
    kinds = {kind for kind, _text in asyncio.run(_collect(eng))}
    assert kinds == {"content"}


# ── Generation config ───────────────────────────────────────────────────────


def test_hidden_reasoning_gets_a_token_floor(tmp_path):
    eng = _engine(["x"], tmp_path)
    asyncio.run(_collect(eng, enable_thinking=False, max_tokens=128))
    assert eng._pipe.configs[-1].max_new_tokens == ov.HIDDEN_REASONING_FLOOR


def test_visible_thinking_leaves_the_budget_to_the_caller(tmp_path):
    # server.py already applies its own floor for thinking=true; don't
    # second-guess it here.
    eng = _engine(["x"], tmp_path)
    asyncio.run(_collect(eng, enable_thinking=True, max_tokens=1280))
    assert eng._pipe.configs[-1].max_new_tokens == 1280


def test_npu_forces_greedy_decoding(tmp_path):
    eng = _engine(["x"], tmp_path)
    eng._greedy_only = True
    asyncio.run(_collect(eng, temperature=0.7))
    cfg = eng._pipe.configs[-1]
    assert cfg.do_sample is False


def test_gpu_keeps_sampling(tmp_path):
    eng = _engine(["x"], tmp_path)
    asyncio.run(_collect(eng, temperature=0.7))
    cfg = eng._pipe.configs[-1]
    assert cfg.do_sample is True
    assert cfg.temperature == pytest.approx(0.7)


# ── Prompt rendering ────────────────────────────────────────────────────────


def test_thinking_false_omits_extra_context_entirely(tmp_path):
    # Sending {"enable_thinking": False} makes the template emit a
    # pre-closed empty block, after which the model opens a fresh one and
    # rambles — measured at 571-871 chars of reasoning versus 110-119 when
    # the kwarg is simply left out. Same hidden reasoning, 5x the cost.
    eng = _engine(["x"], tmp_path)
    eng._render_prompt([{"role": "user", "content": "hi"}], enable_thinking=False)
    assert "extra_context" not in eng._tokenizer.calls[-1]


def test_thinking_true_passes_extra_context(tmp_path):
    eng = _engine(["x"], tmp_path)
    eng._render_prompt([{"role": "user", "content": "hi"}], enable_thinking=True)
    assert eng._tokenizer.calls[-1]["extra_context"] == {"enable_thinking": True}


# ── Concurrency + failure ───────────────────────────────────────────────────


def test_concurrent_requests_are_serialised(tmp_path):
    # LLMPipeline is not re-entrant, and the pet really does overlap
    # requests: the narrator posts /api/chat with silent=true while the
    # chat bubble is still streaming.
    eng = _engine(["a", "b", "c"], tmp_path)

    async def both():
        await asyncio.gather(_collect(eng), _collect(eng))

    asyncio.run(both())
    assert eng._pipe.max_in_flight == 1


def test_worker_errors_reach_the_consumer(tmp_path):
    eng = _engine(["x"], tmp_path)

    def _boom(*_a, **_k):
        raise RuntimeError("device fell over")

    eng._pipe.generate = _boom
    with pytest.raises(RuntimeError, match="device fell over"):
        asyncio.run(_collect(eng))


def test_stream_chat_without_start_is_a_clear_error(tmp_path):
    eng = ov.OpenVinoEngine(model_path=tmp_path)
    with pytest.raises(RuntimeError, match="not loaded"):
        asyncio.run(_collect(eng))


# ── Stop tokens ─────────────────────────────────────────────────────────────


def test_both_eos_ids_are_collected(tmp_path):
    # MiniCPM5 declares </s> and <|im_end|>. GenerationConfig only carries a
    # scalar eos_token_id, so missing the second one means every turn runs
    # to max_new_tokens, continuing past its own reply with <|im_start|>user.
    (tmp_path / "generation_config.json").write_text(
        json.dumps({"eos_token_id": [1, 130073]}), encoding="utf-8"
    )
    assert ov.resolve_stop_token_ids(tmp_path) == {1, 130073}


def test_scalar_eos_id_is_accepted(tmp_path):
    (tmp_path / "config.json").write_text(
        json.dumps({"eos_token_id": 2}), encoding="utf-8"
    )
    assert ov.resolve_stop_token_ids(tmp_path) == {2}


def test_missing_generation_config_is_not_fatal(tmp_path):
    assert ov.resolve_stop_token_ids(tmp_path) == set()
