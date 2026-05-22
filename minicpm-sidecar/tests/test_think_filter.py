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
