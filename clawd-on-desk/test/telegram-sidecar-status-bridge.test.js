"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createTelegramSidecarStatusBridge,
  decideSidecarRuntimeEvent,
} = require("../src/telegram-sidecar-status-bridge");
const { EVENTS } = require("../src/telegram-migration-state");

// ── Pure decision ──────────────────────────────────────────────────────────

test("decide: running resets dedupe + requests recovery (onlyIfRuntimeFailed)", () => {
  const out = decideSidecarRuntimeEvent({ everReady: false, lastFailureKey: "stale" }, { status: "running" });
  assert.equal(out.memory.everReady, true);
  assert.equal(out.memory.lastFailureKey, "");
  assert.equal(out.event.type, EVENTS.SIDECAR_RUNTIME_RECOVERED);
  assert.equal(out.event.onlyIfRuntimeFailed, true);
});

test("decide: failed before ever-ready → no event (startup failure, owned elsewhere)", () => {
  const out = decideSidecarRuntimeEvent({ everReady: false, lastFailureKey: "" }, { status: "failed", message: "startup timed out" });
  assert.equal(out.event, null);
  assert.equal(out.memory.everReady, false);
});

test("decide: failed after ready → RUNTIME_FAILED with reason + message", () => {
  const out = decideSidecarRuntimeEvent(
    { everReady: true, lastFailureKey: "" },
    { status: "failed", message: "sidecar exited (signal SIGTERM)" },
  );
  assert.equal(out.event.type, EVENTS.SIDECAR_RUNTIME_FAILED);
  assert.equal(out.event.reason, "sidecar_runtime_failed");
  assert.equal(out.event.message, "sidecar exited (signal SIGTERM)");
});

test("decide: rate-limit message maps to its own reason key", () => {
  const out = decideSidecarRuntimeEvent(
    { everReady: true, lastFailureKey: "" },
    { status: "failed", message: "sidecar restart rate limit reached" },
  );
  assert.equal(out.event.reason, "sidecar_restart_rate_limit");
});

test("decide: identical failure key dedupes to null", () => {
  const key = "sidecar_runtime_failed\nboom";
  const out = decideSidecarRuntimeEvent({ everReady: true, lastFailureKey: key }, { status: "failed", message: "boom" });
  assert.equal(out.event, null);
  assert.equal(out.memory.lastFailureKey, key);
});

// ── Stateful bridge (fake timers + injected controller) ──────────────────────

function makeHarness({ state = "LEGACY_ACTIVE", runtimeStatus = null } = {}) {
  const timers = [];
  const dispatched = [];
  let snap = { state, runtimeStatus };
  const bridge = createTelegramSidecarStatusBridge({
    getSnapshot: () => snap,
    dispatch: (event) => { dispatched.push(event); return Promise.resolve({ ok: true }); },
    setTimer: (cb) => { const t = { cb, fired: false }; timers.push(t); return t; },
    settleDelayMs: 0,
    settleRetryLimit: 5,
  });
  return {
    bridge,
    dispatched,
    setSnap: (patch) => { snap = { ...snap, ...patch }; },
    flushAll: () => {
      let guard = 0;
      while (timers.some((t) => !t.fired) && guard < 100) {
        const t = timers.find((x) => !x.fired);
        t.fired = true;
        t.cb();
        guard += 1;
      }
    },
    flushOnce: () => {
      const pending = timers.filter((t) => !t.fired);
      for (const t of pending) { t.fired = true; t.cb(); }
    },
    failedEvents: () => dispatched.filter((e) => e.type === EVENTS.SIDECAR_RUNTIME_FAILED),
    recoveredEvents: () => dispatched.filter((e) => e.type === EVENTS.SIDECAR_RUNTIME_RECOVERED),
  };
}

test("bridge: running→failed (after ready) dispatches RUNTIME_FAILED once in LEGACY_ACTIVE", () => {
  const h = makeHarness({ state: "LEGACY_ACTIVE" });
  h.bridge.onStatusChanged({ status: "running" });
  h.flushAll();
  // recovery is a no-op (controller not failed)
  assert.equal(h.recoveredEvents().length, 0);

  h.bridge.onStatusChanged({ status: "failed", message: "sidecar exited (signal SIGTERM)" });
  h.flushAll();
  const failed = h.failedEvents();
  assert.equal(failed.length, 1);
  assert.equal(failed[0].message, "sidecar exited (signal SIGTERM)");
  assert.equal(failed[0].reason, "sidecar_runtime_failed");
  // control flag must be stripped before dispatch
  assert.equal("onlyIfRuntimeFailed" in failed[0], false);
});

test("bridge: repeated identical failed is deduped to a single dispatch", () => {
  const h = makeHarness();
  h.bridge.onStatusChanged({ status: "running" }); h.flushAll();
  h.bridge.onStatusChanged({ status: "failed", message: "boom" }); h.flushAll();
  h.bridge.onStatusChanged({ status: "failed", message: "boom" }); h.flushAll();
  assert.equal(h.failedEvents().length, 1);
});

test("bridge: a later, more specific failure (rate limit) dispatches again", () => {
  const h = makeHarness();
  h.bridge.onStatusChanged({ status: "running" }); h.flushAll();
  h.bridge.onStatusChanged({ status: "failed", message: "sidecar exited (signal SIGTERM)" }); h.flushAll();
  h.bridge.onStatusChanged({ status: "failed", message: "sidecar restart rate limit reached" }); h.flushAll();
  const failed = h.failedEvents();
  assert.equal(failed.length, 2);
  assert.equal(failed[1].reason, "sidecar_restart_rate_limit");
});

test("bridge: a startup failure before ever running never dispatches", () => {
  const h = makeHarness();
  h.bridge.onStatusChanged({ status: "starting" }); h.flushAll();
  h.bridge.onStatusChanged({ status: "failed", message: "startup timed out" }); h.flushAll();
  assert.equal(h.dispatched.length, 0);
});

test("bridge: recovery dispatches RUNTIME_RECOVERED only when controller shows failed", () => {
  const failedSnap = makeHarness({ state: "LEGACY_ACTIVE", runtimeStatus: { status: "failed" } });
  failedSnap.bridge.onStatusChanged({ status: "running" });
  failedSnap.flushAll();
  assert.equal(failedSnap.recoveredEvents().length, 1);
  assert.equal("onlyIfRuntimeFailed" in failedSnap.recoveredEvents()[0], false);

  const healthySnap = makeHarness({ state: "LEGACY_ACTIVE", runtimeStatus: null });
  healthySnap.bridge.onStatusChanged({ status: "running" });
  healthySnap.flushAll();
  assert.equal(healthySnap.recoveredEvents().length, 0);
});

test("bridge: SWITCHING_TO_LEGACY window holds the failure until state settles", () => {
  // Reproduces the narrow rollback window: sidecar ready (running emitted) then
  // crashes before SIDECAR_STARTED settles the state to LEGACY_ACTIVE.
  const h = makeHarness({ state: "SWITCHING_TO_LEGACY" });
  h.bridge.onStatusChanged({ status: "running" });
  h.bridge.onStatusChanged({ status: "failed", message: "sidecar exited (signal SIGTERM)" });

  // While SWITCHING, nothing is dispatched — the events reschedule themselves.
  h.flushOnce();
  assert.equal(h.dispatched.length, 0);

  // State settles to LEGACY_ACTIVE; the held failure is now delivered.
  h.setSnap({ state: "LEGACY_ACTIVE" });
  h.flushAll();
  assert.equal(h.failedEvents().length, 1);
  assert.equal(h.failedEvents()[0].message, "sidecar exited (signal SIGTERM)");
});

test("bridge: never dispatches while state is non-legacy (e.g. user switched to native)", () => {
  const h = makeHarness({ state: "NATIVE_ACTIVE" });
  h.bridge.onStatusChanged({ status: "running" });
  h.bridge.onStatusChanged({ status: "failed", message: "late failure from a dying legacy instance" });
  h.flushAll();
  assert.equal(h.dispatched.length, 0);
});
