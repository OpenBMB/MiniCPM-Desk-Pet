"""Lock down ThinkBlockFilter behaviour ported from the legacy bridge.

These tests are the protocol between Electron and the gateway: the renderer
(clawd-on-desk/src/minicpm-chat.html) relies on these exact event shapes
to switch between the "think" and the "reply" bubbles.
"""

from __future__ import annotations

from gateway.think_filter import ThinkBlockFilter


def _events(filter_: ThinkBlockFilter, pieces: list[str]) -> list[dict]:
    out: list[dict] = []
    for p in pieces:
        out.extend(filter_.feed(p))
    out.extend(filter_.flush())
    return out


def test_plain_text_only():
    f = ThinkBlockFilter(expose=False)
    assert _events(f, ["hello ", "world"]) == [
        {"event": "delta", "content": "hello "},
        {"event": "delta", "content": "world"},
    ]


def test_think_exposed():
    f = ThinkBlockFilter(expose=True)
    events = _events(f, ["<think>reasoning</think>\n\nactual"])
    assert events == [
        {"event": "think", "content": "reasoning"},
        {"event": "delta", "content": "actual"},
    ]


def test_think_hidden_drops_reasoning():
    f = ThinkBlockFilter(expose=False)
    events = _events(f, ["<think>secret</think>\n\nuser-visible"])
    assert events == [{"event": "delta", "content": "user-visible"}]


def test_open_tag_split_across_chunks():
    f = ThinkBlockFilter(expose=True)
    events = _events(f, ["text <thi", "nk>raw</think>\n\nbody"])
    assert events == [
        {"event": "delta", "content": "text "},
        {"event": "think", "content": "raw"},
        {"event": "delta", "content": "body"},
    ]


def test_close_tag_split_across_chunks():
    f = ThinkBlockFilter(expose=True)
    events = _events(f, ["<think>a</thi", "nk>b"])
    assert events == [
        {"event": "think", "content": "a"},
        {"event": "delta", "content": "b"},
    ]


def test_start_inside_thinking():
    f = ThinkBlockFilter(expose=True, start_inside=True)
    events = _events(f, ["raw reasoning</think>\n\nreply"])
    assert events == [
        {"event": "think", "content": "raw reasoning"},
        {"event": "delta", "content": "reply"},
    ]


def test_trailing_partial_tag_flushed_as_delta():
    # When the stream ends mid-tag we must still flush whatever is in the
    # buffer so the user doesn't lose tokens — even if it looks like a
    # half-open <think>.
    f = ThinkBlockFilter(expose=True)
    events = _events(f, ["hello <thi"])
    assert events == [
        {"event": "delta", "content": "hello "},
        {"event": "delta", "content": "<thi"},
    ]


# ── Tag-adjacent newlines (real bug, observed 2026-09-02) ──────────────────
#
# The chat template writes "<think>\n" and "</think>\n\n". Those newlines are
# punctuation belonging to the tag, not content — but they used to be emitted
# verbatim, so the desk pet's reasoning bubble opened with a blank first line
# and the reply began with blank lines.
#
# The close tag had a partial fix that only looked at the bytes already
# buffered; with OpenVINO the newline usually arrives in the *next* chunk, so
# it slipped through. These lock down both tags and both arrival patterns.


def test_open_tag_newline_is_not_emitted_as_reasoning():
    events = _events(ThinkBlockFilter(expose=True), ["<think>\n", "reasoning", "</think>", "\n\n", "answer"])
    think = [e["content"] for e in events if e["event"] == "think"]
    assert think == ["reasoning"]
    assert not any(c.startswith("\n") for c in think)


def test_close_tag_newlines_are_eaten_across_a_chunk_boundary():
    # "\n\n" lands in its own chunk — the case the old inline strip missed.
    events = _events(ThinkBlockFilter(expose=True), ["<think>\n", "why", "</think>", "\n\n", "the answer"])
    delta = "".join(e["content"] for e in events if e["event"] == "delta")
    assert delta == "the answer"


def test_tag_newlines_eaten_when_everything_arrives_at_once():
    events = _events(ThinkBlockFilter(expose=True), ["<think>\nwhy</think>\n\nthe answer"])
    assert [(e["event"], e["content"]) for e in events] == [
        ("think", "why"),
        ("delta", "the answer"),
    ]


def test_only_the_run_directly_after_a_tag_is_trimmed():
    # A blank line *inside* the reasoning is real formatting; keep it.
    events = _events(ThinkBlockFilter(expose=True), ["<think>\n", "para one\n\npara two", "</think>", "answer"])
    think = "".join(e["content"] for e in events if e["event"] == "think")
    assert think == "para one\n\npara two"


def test_trimming_does_not_swallow_content_that_starts_with_text():
    events = _events(ThinkBlockFilter(expose=True), ["<think>", "no newline here", "</think>", "answer"])
    think = [e["content"] for e in events if e["event"] == "think"]
    assert think == ["no newline here"]
