"use strict";

// ── MiniCPM chat context management ──
//
// The chat renderer keeps an in-memory `history` array of {role, content}
// turns and sends it verbatim to the sidecar on every turn. Without trimming,
// the array grows unbounded and llama-server silently drops the oldest tokens
// once the prompt exceeds its --ctx-size KV window (default 4096) — the user
// has no signal that earlier turns were forgotten.
//
// This module provides a deterministic sliding window + token-budget trim so
// the prompt is bounded *before* it reaches the sidecar. Loaded as both a
// CommonJS module (tests) and a UMD-style `<script>` (renderer) via
// `globalThis.ClawdMinicpmChatContext`. Test coverage lives in
// `test/minicpm-chat-context.test.js`.

(function initChatContext(root) {
  // Mirrors the sidecar `--ctx-size` default (MINICPM_CTX). Keep in sync if
  // that default changes.
  const DEFAULT_CTX_WINDOW_TOKENS = 4096;
  // Headroom for the chat template scaffolding + an optional system prompt the
  // gateway prepends that the renderer can't see.
  const CTX_SAFETY_TOKENS = 320;
  // Hard sliding-window cap on retained turns, independent of token budget —
  // bounds memory and keeps very long sessions from accumulating forever.
  const MAX_HISTORY_TURNS = 40;
  // Per-message overhead (role tokens + template delimiters) added to each
  // message's content estimate.
  const PER_MESSAGE_OVERHEAD_TOKENS = 4;

  // Rough token estimate without a tokenizer: CJK/Hangul/Kana code points are
  // ~1 token each; other text averages ~4 chars/token. Deliberately errs high
  // so we under-fill rather than overflow the real KV window.
  function estimateTokens(text) {
    if (typeof text !== "string" || text.length === 0) return 0;
    let cjk = 0;
    let other = 0;
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      const isCjk =
        (cp >= 0x3000 && cp <= 0x9fff) || // CJK punctuation + ideographs
        (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
        (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
        (cp >= 0xff00 && cp <= 0xffef);   // fullwidth forms
      if (isCjk) cjk++;
      else other++;
    }
    return cjk + Math.ceil(other / 4) + PER_MESSAGE_OVERHEAD_TOKENS;
  }

  // Returns a trimmed COPY of `messages` that should fit within the context
  // window once `maxNewTokens` of generation budget is reserved. Drops the
  // oldest turns first, always keeps the most recent turn, and never leaves a
  // leading assistant turn (MiniCPM's template expects a user turn first).
  function trimHistoryForContext(messages, options) {
    if (!Array.isArray(messages) || messages.length === 0) return [];
    const opts = options || {};
    const ctxWindow = Number.isFinite(opts.ctxWindowTokens)
      ? opts.ctxWindowTokens
      : DEFAULT_CTX_WINDOW_TOKENS;
    const maxNewTokens = Number.isFinite(opts.maxNewTokens) ? opts.maxNewTokens : 0;
    const maxTurns = Number.isFinite(opts.maxTurns) ? opts.maxTurns : MAX_HISTORY_TURNS;

    // 1) Hard sliding-window cap on turn count.
    let trimmed = messages.length > maxTurns ? messages.slice(-maxTurns) : messages.slice();

    // 2) Token budget: ctx window minus generation budget minus safety margin.
    const budget = Math.max(0, ctxWindow - maxNewTokens - CTX_SAFETY_TOKENS);
    const cost = trimmed.map((m) => estimateTokens(m && m.content));
    let total = cost.reduce((a, b) => a + b, 0);
    while (trimmed.length > 1 && total > budget) {
      total -= cost.shift();
      trimmed.shift();
    }

    // 3) Don't start the prompt on an assistant turn.
    while (trimmed.length > 1 && trimmed[0] && trimmed[0].role === "assistant") {
      trimmed.shift();
    }

    return trimmed;
  }

  const api = {
    DEFAULT_CTX_WINDOW_TOKENS,
    CTX_SAFETY_TOKENS,
    MAX_HISTORY_TURNS,
    estimateTokens,
    trimHistoryForContext,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) root.ClawdMinicpmChatContext = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
