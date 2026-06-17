"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createTelegramCompanion,
  formatNotification,
} = require("../src/telegram-companion");

function tick() {
  // Flush the fire-and-forget microtask chain in onSnapshot.
  return new Promise((resolve) => setImmediate(resolve));
}

function doneEntry(overrides = {}) {
  return {
    id: "sess-aaaaaa1",
    agentId: "claude",
    displayTitle: "fix the bug",
    cwd: "/home/me/proj",
    host: null,
    badge: "done",
    lastEvent: { rawEvent: "Stop", at: 1000 },
    assistantLastOutput: null,
    assistantLastOutputTruncated: false,
    ...overrides,
  };
}

function makeClient() {
  const sent = [];
  return {
    sent,
    client: {
      sendNotification: async (text) => { sent.push(text); return { ok: true }; },
    },
  };
}

function makeCompanion({ enabled = true, client, getLang, getCompletionOutputMode, getNotifyOnComplete } = {}) {
  const sink = client || makeClient();
  const comp = createTelegramCompanion({
    getClient: () => sink.client,
    isEnabled: () => enabled,
    getLang,
    getCompletionOutputMode,
    getNotifyOnComplete,
  });
  return { comp, sent: sink.sent };
}

test("first snapshot primes dedupe without notifying", async () => {
  const { comp, sent } = makeCompanion();
  comp.onSnapshot({ sessions: [doneEntry()] });
  await tick();
  assert.deepEqual(sent, [], "backlog of already-finished sessions must not re-ping on start");
});

test("factory defaults to no completion output", async () => {
  const { comp, sent } = makeCompanion();
  comp.onSnapshot({ sessions: [] });
  comp.onSnapshot({ sessions: [doneEntry()] });
  await tick();
  assert.deepEqual(sent, [], "default factory should not send a bare ping");

  comp.onSnapshot({
    sessions: [doneEntry({
      lastEvent: { rawEvent: "Stop", at: 2000 },
      assistantLastOutput: "Implemented the fix.",
    })],
  });
  await tick();
  assert.deepEqual(sent, [], "default factory should not send assistant output");
});

test("factory sends assistant output only when full output is explicit", async () => {
  const { comp, sent } = makeCompanion({ getCompletionOutputMode: () => "full" });
  comp.onSnapshot({ sessions: [] });
  comp.onSnapshot({
    sessions: [doneEntry({
      assistantLastOutput: "Implemented the fix.",
    })],
  });
  await tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Assistant output:/);
  assert.match(sent[0], /Implemented the fix/);
});

test("notifies a fresh completion after priming", async () => {
  const { comp, sent } = makeCompanion({ getNotifyOnComplete: () => true });
  comp.onSnapshot({ sessions: [] }); // prime empty
  comp.onSnapshot({ sessions: [doneEntry()] });
  await tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /fix the bug/);
  assert.match(sent[0], /done/);
});

test("registers completion notification message ids after successful sends", async () => {
  const registrations = [];
  const sink = {
    sent: [],
    client: {
      sendNotification: async (text) => {
        sink.sent.push(text);
        return { ok: true, messageId: 4242 };
      },
    },
  };
  const comp = createTelegramCompanion({
    getClient: () => sink.client,
    isEnabled: () => true,
    getNotifyOnComplete: () => true,
    onNotificationSent: (payload) => registrations.push({
      messageId: payload.messageId,
      sessionId: payload.entry && payload.entry.id,
    }),
  });

  comp.onSnapshot({ sessions: [] });
  comp.onSnapshot({ sessions: [doneEntry({ id: "sess-for-map" })] });
  await tick();

  assert.equal(sink.sent.length, 1);
  assert.deepEqual(registrations, [{ messageId: 4242, sessionId: "sess-for-map" }]);
});

test("does not register direct-send mapping when notification delivery fails", async () => {
  const registrations = [];
  const comp = createTelegramCompanion({
    getClient: () => ({
      sendNotification: async () => ({ ok: false, errorClass: "403" }),
    }),
    isEnabled: () => true,
    getNotifyOnComplete: () => true,
    onNotificationSent: (payload) => registrations.push(payload),
  });

  comp.onSnapshot({ sessions: [] });
  comp.onSnapshot({ sessions: [doneEntry()] });
  await tick();

  assert.deepEqual(registrations, []);
});

test("dedupes repeated broadcasts of the same completion", async () => {
  const { comp, sent } = makeCompanion({ getNotifyOnComplete: () => true });
  comp.onSnapshot({ sessions: [] });
  comp.onSnapshot({ sessions: [doneEntry()] });
  await tick();
  // Same id + rawEvent + at — re-broadcast from ack / stale-cleanup.
  comp.onSnapshot({ sessions: [doneEntry()] });
  await tick();
  assert.equal(sent.length, 1, "must not re-notify the same completion");
});

test("a later completion on the same session (new at) notifies again", async () => {
  const { comp, sent } = makeCompanion({ getNotifyOnComplete: () => true });
  comp.onSnapshot({ sessions: [] });
  comp.onSnapshot({ sessions: [doneEntry()] });
  await tick();
  comp.onSnapshot({ sessions: [doneEntry({ lastEvent: { rawEvent: "Stop", at: 2000 } })] });
  await tick();
  assert.equal(sent.length, 2);
});

test("disabled: advances dedupe but sends nothing, and never backfills", async () => {
  const sink = makeClient();
  let enabled = false;
  const comp = createTelegramCompanion({
    getClient: () => sink.client,
    isEnabled: () => enabled,
  });
  comp.onSnapshot({ sessions: [] });
  comp.onSnapshot({ sessions: [doneEntry()] });
  await tick();
  assert.deepEqual(sink.sent, [], "no sends while disabled");
  // Flip on — the already-seen completion must not retroactively fire.
  enabled = true;
  comp.onSnapshot({ sessions: [doneEntry()] });
  await tick();
  assert.deepEqual(sink.sent, [], "flipping the toggle on must not backfill old completions");
});

test("notifies each completing session with identity fields", async () => {
  const { comp, sent } = makeCompanion({ getNotifyOnComplete: () => true });
  comp.onSnapshot({ sessions: [] });
  comp.onSnapshot({
    sessions: [
      doneEntry({ id: "sess-aaaaaa1", displayTitle: "task A", cwd: "/a/projA" }),
      doneEntry({ id: "sess-bbbbbb2", displayTitle: "task B", cwd: "C:\\work\\projB", host: "laptop" }),
    ],
  });
  await tick();
  assert.equal(sent.length, 2);
  const joined = sent.join("\n---\n");
  assert.match(joined, /task A/);
  assert.match(joined, /projA/);
  assert.match(joined, /task B/);
  assert.match(joined, /projB/); // Windows cwd basename
  assert.match(joined, /laptop/); // host
});

test("ignores non-completion badges and events", async () => {
  const { comp, sent } = makeCompanion();
  comp.onSnapshot({ sessions: [] });
  comp.onSnapshot({
    sessions: [
      doneEntry({ id: "r1", badge: "running", lastEvent: { rawEvent: "PreToolUse", at: 1 } }),
      doneEntry({ id: "i1", badge: "idle", lastEvent: { rawEvent: "Notification", at: 1 } }),
      // done badge but a non-completion rawEvent should not fire.
      doneEntry({ id: "d1", badge: "done", lastEvent: { rawEvent: "PostCompact", at: 1 } }),
    ],
  });
  await tick();
  assert.deepEqual(sent, []);
});

test("interrupted badge uses the warning marker", async () => {
  const { comp, sent } = makeCompanion({ getNotifyOnComplete: () => true });
  comp.onSnapshot({ sessions: [] });
  comp.onSnapshot({
    sessions: [doneEntry({ badge: "interrupted", lastEvent: { rawEvent: "ApiError", at: 5 } })],
  });
  await tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /interrupted/);
});

test("completion notification follows the current Clawd language", async () => {
  let lang = "zh";
  const { comp, sent } = makeCompanion({ getLang: () => lang, getNotifyOnComplete: () => true });
  comp.onSnapshot({ sessions: [] });
  comp.onSnapshot({ sessions: [doneEntry()] });
  await tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /已完成/);
  assert.doesNotMatch(sent[0], /\(done\)/);

  lang = "ja";
  comp.onSnapshot({ sessions: [doneEntry({ lastEvent: { rawEvent: "Stop", at: 2000 } })] });
  await tick();
  assert.equal(sent.length, 2);
  assert.match(sent[1], /完了/);
});

test("output mode off keeps the R1a bare notification", async () => {
  const { comp, sent } = makeCompanion({
    getCompletionOutputMode: () => "off",
    getNotifyOnComplete: () => true,
  });
  comp.onSnapshot({ sessions: [] });
  comp.onSnapshot({ sessions: [doneEntry({ assistantLastOutput: "assistant text" })] });
  await tick();
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0], /assistant text/);
  assert.doesNotMatch(sent[0], /Assistant output/);
});

test("full output mode appends redacted assistant text", async () => {
  const { comp, sent } = makeCompanion({
    getCompletionOutputMode: () => "full",
  });
  comp.onSnapshot({ sessions: [] });
  comp.onSnapshot({
    sessions: [doneEntry({
      assistantLastOutput: `${"line ".repeat(600)}\nsecret=sk-1234567890abcdef\nTAIL`,
    })],
  });
  await tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Assistant output \(truncated\):/);
  assert.match(sent[0], /TAIL/);
  assert.match(sent[0], /secret=<redacted>/);
  assert.doesNotMatch(sent[0], /sk-1234567890abcdef/);
  assert.doesNotMatch(sent[0], /Last output/);
});

test("full output mode with bare ping disabled skips completions with no assistant text", async () => {
  const { comp, sent } = makeCompanion({
    getCompletionOutputMode: () => "full",
    getNotifyOnComplete: () => false,
  });
  comp.onSnapshot({ sessions: [] });
  comp.onSnapshot({ sessions: [doneEntry()] });
  await tick();
  assert.deepEqual(sent, [], "no assistant text means no default bare completion ping");

  comp.onSnapshot({
    sessions: [doneEntry({
      lastEvent: { rawEvent: "Stop", at: 2000 },
      assistantLastOutput: "Implemented the fix.",
    })],
  });
  await tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Assistant output:/);
  assert.match(sent[0], /Implemented the fix/);
});

test("output mode off with bare ping disabled sends no completion message", async () => {
  const { comp, sent } = makeCompanion({
    getCompletionOutputMode: () => "off",
    getNotifyOnComplete: () => false,
  });
  comp.onSnapshot({ sessions: [] });
  comp.onSnapshot({ sessions: [doneEntry({ assistantLastOutput: "assistant text" })] });
  await tick();
  assert.deepEqual(sent, []);
});

test("legacy tail output mode is treated as full output", async () => {
  const { comp, sent } = makeCompanion({
    getCompletionOutputMode: () => "tail",
  });
  comp.onSnapshot({ sessions: [] });
  comp.onSnapshot({
    sessions: [doneEntry({ assistantLastOutput: "Implemented the fix." })],
  });
  await tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Assistant output:/);
  assert.match(sent[0], /Implemented the fix/);
  assert.doesNotMatch(sent[0], /Last output/);
});

test("full output mode appends assistant text and marks extractor truncation", async () => {
  const { comp, sent } = makeCompanion({
    getCompletionOutputMode: () => "full",
  });
  comp.onSnapshot({ sessions: [] });
  comp.onSnapshot({
    sessions: [doneEntry({
      assistantLastOutput: "Implemented X.\nTests pass.",
      assistantLastOutputTruncated: true,
    })],
  });
  await tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Assistant output \(truncated\):/);
  assert.match(sent[0], /Implemented X/);
  assert.match(sent[0], /Tests pass/);
});

test("full output mode with bare ping enabled degrades to R1a when no assistant text is available", async () => {
  const { comp, sent } = makeCompanion({
    getCompletionOutputMode: () => "full",
    getNotifyOnComplete: () => true,
  });
  comp.onSnapshot({ sessions: [] });
  comp.onSnapshot({ sessions: [doneEntry()] });
  await tick();
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0], /Assistant output/);
});

test("forgets sessions that drop out of the snapshot", async () => {
  const { comp } = makeCompanion();
  comp.onSnapshot({ sessions: [doneEntry()] }); // prime + record key
  comp.onSnapshot({ sessions: [] }); // session gone -> key dropped
  assert.equal(comp._lastNotified.size, 0);
});

test("formatNotification falls back to short id when title missing", () => {
  const text = formatNotification({
    id: "sess-zzzzzz9", badge: "done", lastEvent: { rawEvent: "Stop", at: 1 },
  });
  assert.match(text, /sess-z/);
  assert.match(text, /#sess-z/);
});
