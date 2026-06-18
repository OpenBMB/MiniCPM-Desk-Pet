"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  DEFAULT_CTX_WINDOW_TOKENS,
  MAX_HISTORY_TURNS,
  estimateTokens,
  trimHistoryForContext,
} = require("../src/minicpm-chat-context");

describe("estimateTokens", () => {
  it("returns 0 for empty / non-string input", () => {
    assert.strictEqual(estimateTokens(""), 0);
    assert.strictEqual(estimateTokens(null), 0);
    assert.strictEqual(estimateTokens(undefined), 0);
  });

  it("counts CJK code points at ~1 token each plus per-message overhead", () => {
    // 4 CJK chars + 4 overhead.
    assert.strictEqual(estimateTokens("你好世界"), 8);
  });

  it("counts latin text at ~4 chars/token plus overhead", () => {
    // 8 chars -> ceil(8/4)=2, +4 overhead.
    assert.strictEqual(estimateTokens("abcdefgh"), 6);
  });
});

describe("trimHistoryForContext", () => {
  it("returns [] for empty input", () => {
    assert.deepStrictEqual(trimHistoryForContext([]), []);
    assert.deepStrictEqual(trimHistoryForContext(null), []);
  });

  it("returns a copy, not the original array", () => {
    const msgs = [{ role: "user", content: "hi" }];
    const out = trimHistoryForContext(msgs);
    assert.notStrictEqual(out, msgs);
    assert.deepStrictEqual(out, msgs);
  });

  it("keeps short histories intact", () => {
    const msgs = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "how are you" },
    ];
    assert.deepStrictEqual(trimHistoryForContext(msgs), msgs);
  });

  it("drops oldest turns when the token budget is exceeded", () => {
    const big = "x".repeat(4000); // ~1000 tokens each
    const msgs = [
      { role: "user", content: big },
      { role: "assistant", content: big },
      { role: "user", content: big },
      { role: "assistant", content: big },
      { role: "user", content: "latest" },
    ];
    const out = trimHistoryForContext(msgs, { maxNewTokens: 768 });
    // The most recent turn must survive, and the result must be shorter.
    assert.ok(out.length < msgs.length);
    assert.strictEqual(out[out.length - 1].content, "latest");
  });

  it("always keeps at least the most recent turn even if it alone exceeds budget", () => {
    const huge = "y".repeat(40000);
    const msgs = [
      { role: "user", content: "old" },
      { role: "user", content: huge },
    ];
    const out = trimHistoryForContext(msgs, { maxNewTokens: 768 });
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].content, huge);
  });

  it("does not leave a leading assistant turn after trimming", () => {
    const big = "z".repeat(4000);
    const msgs = [
      { role: "user", content: big },
      { role: "assistant", content: big },
      { role: "user", content: big },
      { role: "assistant", content: big },
      { role: "user", content: "latest" },
    ];
    const out = trimHistoryForContext(msgs, { maxNewTokens: 768, ctxWindowTokens: 2600 });
    assert.notStrictEqual(out[0].role, "assistant");
  });

  it("applies the hard sliding-window turn cap", () => {
    const msgs = [];
    for (let i = 0; i < MAX_HISTORY_TURNS + 10; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: "t" + i });
    }
    const out = trimHistoryForContext(msgs, { ctxWindowTokens: DEFAULT_CTX_WINDOW_TOKENS });
    assert.ok(out.length <= MAX_HISTORY_TURNS);
    assert.strictEqual(out[out.length - 1].content, "t" + (msgs.length - 1));
  });

  it("respects a custom maxTurns option", () => {
    const msgs = [];
    for (let i = 0; i < 20; i++) msgs.push({ role: "user", content: "m" + i });
    const out = trimHistoryForContext(msgs, { maxTurns: 5 });
    assert.strictEqual(out.length, 5);
    assert.strictEqual(out[0].content, "m15");
  });
});
