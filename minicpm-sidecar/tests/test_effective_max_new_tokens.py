from gateway.server import (
    ChatMessage,
    ChatRequest,
    THINKING_MIN_MAX_NEW_TOKENS,
    _effective_max_new_tokens,
)


def _req(**kwargs) -> ChatRequest:
    defaults = {
        "messages": [ChatMessage(role="user", content="hi")],
        "max_new_tokens": 768,
        "thinking": False,
    }
    defaults.update(kwargs)
    return ChatRequest(**defaults)


def test_thinking_bumps_default_budget():
    assert _effective_max_new_tokens(_req(thinking=True)) == THINKING_MIN_MAX_NEW_TOKENS


def test_thinking_preserves_higher_budget():
    assert _effective_max_new_tokens(_req(max_new_tokens=2000, thinking=True)) == 2000


def test_no_thinking_leaves_budget_unchanged():
    assert _effective_max_new_tokens(_req(max_new_tokens=768, thinking=False)) == 768


def test_clamps_absurd_input_before_bump():
    assert _effective_max_new_tokens(_req(max_new_tokens=99999, thinking=True)) == 4096
