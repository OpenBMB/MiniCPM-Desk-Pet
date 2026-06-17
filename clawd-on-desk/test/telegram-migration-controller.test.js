"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createTelegramMigrationController,
} = require("../src/telegram-migration-controller");
const { STATES, EVENTS } = require("../src/telegram-migration-state");
const { buildTelegramStatusDiagnostic } = require("../src/telegram-approval-runtime-status");

class FakeSidecar {
  constructor() { this.running = false; this.stopCalls = []; this.failStart = false; }
  isRunning() { return this.running; }
  async start() {
    if (this.failStart) {
      const err = new Error("fake sidecar start failed");
      err.code = "SIDECAR_START_FAILED";
      throw err;
    }
    this.running = true;
  }
  async stop() { this.stopCalls.push(true); this.running = false; }
}

class FakeNative {
  constructor() { this.polling = false; this.cards = []; }
  isPolling() { return this.polling; }
  async start() { this.polling = true; }
  async stop() { this.polling = false; }
  async sendTestCard(payload) { this.cards.push(payload); }
}

function makeController(overrides = {}) {
  const sidecar = new FakeSidecar();
  const native = new FakeNative();
  let prefsState = { ...overrides.initialPrefs };
  let filesState = { ...overrides.initialFiles };
  const persisted = [];
  const timers = [];
  const ctrl = createTelegramMigrationController({
    sidecar,
    native,
    readPrefs: () => prefsState,
    writePrefs: async (patch) => { prefsState = { ...prefsState, ...patch }; persisted.push(patch); },
    readFiles: () => filesState,
    settleMs: 0,
    stopGraceMs: 0,
    setTimer: (cb, ms) => { const t = { cb, ms, cancelled: false }; timers.push(t); return t; },
    clearTimer: (t) => { if (t) t.cancelled = true; },
    log: () => {},
    ...overrides.opts,
  });
  return { ctrl, sidecar, native, persisted,
    setFiles(f) { filesState = { ...filesState, ...f }; },
    setPrefs(p) { prefsState = { ...prefsState, ...p }; },
    getPrefs: () => prefsState,
    fireTimer: async () => {
      const t = timers.find((x) => !x.cancelled && !x.fired);
      if (!t) throw new Error("no pending timer");
      t.fired = true;
      t.cb();
      // Let async dispatch + manager.apply chain settle.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    },
    pendingTimer: () => timers.find((x) => !x.cancelled && !x.fired) || null,
  };
}

test("init: legacy user with full env → LEGACY_ACTIVE + starts sidecar", async () => {
  const env = makeController({
    initialFiles: { hasLegacyEnvFile: true, legacyConfigComplete: true },
  });
  const state = await env.ctrl.init();
  assert.equal(state, STATES.LEGACY_ACTIVE);
  assert.equal(env.sidecar.running, true);
});

test("init: fresh user → IDLE, nothing started", async () => {
  const env = makeController({ initialFiles: {} });
  const state = await env.ctrl.init();
  assert.equal(state, STATES.IDLE);
  assert.equal(env.sidecar.running, false);
  assert.equal(env.native.polling, false);
});

test("init: v0.8 opt-out user (legacyEnabled=false) → IDLE NOT re-activated", async () => {
  const env = makeController({
    initialPrefs: { legacyEnabled: false },
    initialFiles: { hasLegacyEnvFile: true, legacyConfigComplete: true },
  });
  const state = await env.ctrl.init();
  assert.equal(state, STATES.IDLE);
  assert.equal(env.sidecar.running, false);
});

test("dispatch USER_TEST_NATIVE from LEGACY_ACTIVE: stops sidecar, starts native, sends test card", async () => {
  const env = makeController({
    initialFiles: { hasLegacyEnvFile: true, legacyConfigComplete: true, nativeConfigComplete: true },
  });
  await env.ctrl.init();
  assert.equal(env.sidecar.running, true);

  const res = await env.ctrl.dispatch({ type: EVENTS.USER_TEST_NATIVE });
  assert.equal(res.ok, true);
  assert.equal(res.state, STATES.TESTING_NATIVE);
  assert.equal(env.sidecar.running, false);
  assert.equal(env.native.polling, true);
  assert.equal(env.native.cards.length, 1);
});

test("dispatch TEST_SUCCESS from TESTING_NATIVE: persists transport=native + clears test timer", async () => {
  const env = makeController({
    initialFiles: { nativeConfigComplete: true },
  });
  await env.ctrl.init();
  await env.ctrl.dispatch({ type: EVENTS.USER_TEST_NATIVE });
  const res = await env.ctrl.dispatch({ type: EVENTS.TEST_SUCCESS, at: 12345 });
  assert.equal(res.ok, true);
  assert.equal(res.state, STATES.NATIVE_ACTIVE);
  const persistedPatches = env.persisted;
  const lastPatch = persistedPatches[persistedPatches.length - 1];
  assert.equal(lastPatch.transport, "native");
  assert.equal(lastPatch.nativeVerifiedAt, 12345);
});

test("dispatch USER_ROLLBACK_TO_LEGACY auto-finalizes after sidecar start", async () => {
  const env = makeController({
    initialPrefs: { transport: "native", nativeVerifiedAt: 1 },
    initialFiles: { hasLegacyEnvFile: true, legacyConfigComplete: true, nativeConfigComplete: true },
  });
  await env.ctrl.init();
  assert.equal(env.native.polling, true);

  const res = await env.ctrl.dispatch({ type: EVENTS.USER_ROLLBACK_TO_LEGACY });
  assert.equal(res.ok, true);
  assert.equal(res.state, STATES.LEGACY_ACTIVE);
  assert.equal(env.native.polling, false);
  assert.equal(env.sidecar.running, true);
  assert.equal(env.persisted.at(-1).transport, "legacy");
});

test("dispatch USER_ROLLBACK_TO_LEGACY records failed legacy runtime when sidecar start returns false", async () => {
  const env = makeController({
    initialPrefs: { transport: "native", nativeVerifiedAt: 1 },
    initialFiles: { hasLegacyEnvFile: true, legacyConfigComplete: true, nativeConfigComplete: true },
  });
  env.sidecar.start = async () => false;
  await env.ctrl.init();

  const res = await env.ctrl.dispatch({ type: EVENTS.USER_ROLLBACK_TO_LEGACY });
  assert.equal(res.ok, false);
  assert.equal(res.state, STATES.LEGACY_ACTIVE);
  assert.equal(env.native.polling, false);
  const snap = env.ctrl.getSnapshot();
  assert.equal(snap.runtimeStatus.status, "failed");
  assert.equal(env.persisted.at(-1).transport, "legacy");
});

test("dispatch: illegal event returns ok:false + errorCode + state unchanged", async () => {
  const env = makeController({
    initialFiles: { hasLegacyEnvFile: true, legacyConfigComplete: true },
  });
  await env.ctrl.init();
  const res = await env.ctrl.dispatch({ type: EVENTS.TEST_SUCCESS });
  assert.equal(res.ok, false);
  assert.equal(res.errorCode, "ILLEGAL_TRANSITION");
  assert.equal(res.state, STATES.LEGACY_ACTIVE);
});

test("test timer is armed on entering TESTING_NATIVE and cancelled on success", async () => {
  const env = makeController({
    initialFiles: { hasLegacyEnvFile: true, legacyConfigComplete: true, nativeConfigComplete: true },
  });
  await env.ctrl.init();
  await env.ctrl.dispatch({ type: EVENTS.USER_TEST_NATIVE });
  assert.ok(env.pendingTimer(), "timer should be armed in TESTING_NATIVE");

  await env.ctrl.dispatch({ type: EVENTS.TEST_SUCCESS, at: 1 });
  assert.equal(env.pendingTimer(), null, "successful test should cancel timer");
});

test("test timer firing dispatches TEST_TIMEOUT → falls back to LEGACY_ACTIVE", async () => {
  const env = makeController({
    initialFiles: { hasLegacyEnvFile: true, legacyConfigComplete: true, nativeConfigComplete: true },
  });
  await env.ctrl.init();
  await env.ctrl.dispatch({ type: EVENTS.USER_TEST_NATIVE });
  await env.fireTimer();
  const snap = env.ctrl.getSnapshot();
  assert.equal(snap.state, STATES.LEGACY_ACTIVE);
  assert.equal(env.sidecar.running, true);
});

test("getSnapshot exposes state + runtime status + owner snapshot", async () => {
  const env = makeController({});
  await env.ctrl.init();
  const snap = env.ctrl.getSnapshot();
  assert.equal(snap.state, STATES.IDLE);
  assert.equal(typeof snap.ownerSnapshot.sidecarRunning, "boolean");
  assert.equal(typeof snap.ownerSnapshot.nativePolling, "boolean");
  // Undecided prefs surface as transport=undefined, not "off" (we distinguish
  // "user explicitly disabled" from "v0.8 user with no transport key yet").
  assert.equal(snap.transport, undefined);
});

test("init: legacy sidecar start failure → LEGACY_ACTIVE but runtimeStatus failed", async () => {
  const env = makeController({
    initialFiles: { hasLegacyEnvFile: true, legacyConfigComplete: true },
  });
  env.sidecar.failStart = true;
  const state = await env.ctrl.init();
  // Selected transport stays legacy; the failure must surface as runtime status,
  // not by snapping the state away (issue #430).
  assert.equal(state, STATES.LEGACY_ACTIVE);
  const snap = env.ctrl.getSnapshot();
  assert.equal(snap.ownerSnapshot.sidecarRunning, false);
  assert.equal(snap.runtimeStatus.transport, "legacy");
  assert.equal(snap.runtimeStatus.status, "failed");
});

test("dispatch SIDECAR_RUNTIME_FAILED @ LEGACY_ACTIVE records failure without lifecycle change", async () => {
  const env = makeController({
    initialFiles: { hasLegacyEnvFile: true, legacyConfigComplete: true },
  });
  await env.ctrl.init();
  assert.equal(env.sidecar.running, true);
  const res = await env.ctrl.dispatch({
    type: EVENTS.SIDECAR_RUNTIME_FAILED,
    reason: "died",
    message: "sidecar exited (signal SIGTERM)",
  });
  assert.equal(res.ok, true);
  assert.equal(res.state, STATES.LEGACY_ACTIVE);
  const snap = env.ctrl.getSnapshot();
  assert.equal(snap.runtimeStatus.status, "failed");
  assert.equal(snap.runtimeStatus.message, "sidecar exited (signal SIGTERM)");
});

test("dispatch SIDECAR_RUNTIME_RECOVERED clears a prior failure incl. message", async () => {
  const env = makeController({
    initialFiles: { hasLegacyEnvFile: true, legacyConfigComplete: true },
  });
  env.sidecar.failStart = true;
  await env.ctrl.init();
  assert.equal(env.ctrl.getSnapshot().runtimeStatus.status, "failed");
  // Manual retry / auto-restart reaching "running" → bridge dispatches recovered.
  const res = await env.ctrl.dispatch({ type: EVENTS.SIDECAR_RUNTIME_RECOVERED });
  assert.equal(res.ok, true);
  const snap = env.ctrl.getSnapshot();
  assert.equal(snap.runtimeStatus.status, "running");
  assert.equal(snap.runtimeStatus.message, "");
});

test("SIDECAR_RUNTIME_FAILED is rejected outside LEGACY_ACTIVE", async () => {
  const env = makeController({ initialFiles: {} });
  await env.ctrl.init(); // IDLE
  const res = await env.ctrl.dispatch({ type: EVENTS.SIDECAR_RUNTIME_FAILED, reason: "x" });
  assert.equal(res.ok, false);
  assert.equal(env.ctrl.getSnapshot().runtimeStatus.status, "stopped");
});

test("USER_DISABLE clears a stale legacy runtime failure (no leak after disable)", async () => {
  const env = makeController({
    initialFiles: { hasLegacyEnvFile: true, legacyConfigComplete: true },
  });
  await env.ctrl.init(); // LEGACY_ACTIVE, sidecar running
  await env.ctrl.dispatch({ type: EVENTS.SIDECAR_RUNTIME_FAILED, reason: "died", message: "boom" });
  assert.equal(env.ctrl.getSnapshot().runtimeStatus.status, "failed");

  const res = await env.ctrl.dispatch({ type: EVENTS.USER_DISABLE });
  assert.equal(res.ok, true);
  assert.equal(res.state, STATES.IDLE);
  const rs = env.ctrl.getSnapshot().runtimeStatus;
  assert.equal(rs.status, "stopped");
  assert.equal(rs.transport, "off");
  assert.equal(rs.message, "");
});

test("switching legacy→native clears stale legacy runtime failure (no /status leak)", async () => {
  const env = makeController({
    initialFiles: { hasLegacyEnvFile: true, legacyConfigComplete: true, nativeConfigComplete: true },
  });
  await env.ctrl.init(); // LEGACY_ACTIVE
  await env.ctrl.dispatch({ type: EVENTS.SIDECAR_RUNTIME_FAILED, reason: "died", message: "boom" });
  assert.equal(env.ctrl.getSnapshot().runtimeStatus.status, "failed");

  await env.ctrl.dispatch({ type: EVENTS.USER_TEST_NATIVE }); // → TESTING_NATIVE
  await env.ctrl.dispatch({ type: EVENTS.TEST_SUCCESS, at: 1 }); // → NATIVE_ACTIVE
  assert.equal(env.ctrl.getSnapshot().state, STATES.NATIVE_ACTIVE);
  const rs = env.ctrl.getSnapshot().runtimeStatus;
  assert.equal(rs.status, "stopped");
  assert.equal(rs.transport, "off");
});

test("/status diagnostic does not leak a stale legacy failure after switching to native", async () => {
  const env = makeController({
    initialFiles: { hasLegacyEnvFile: true, legacyConfigComplete: true, nativeConfigComplete: true },
  });
  await env.ctrl.init();
  await env.ctrl.dispatch({ type: EVENTS.SIDECAR_RUNTIME_FAILED, reason: "died", message: "boom" });
  await env.ctrl.dispatch({ type: EVENTS.USER_TEST_NATIVE });
  await env.ctrl.dispatch({ type: EVENTS.TEST_SUCCESS, at: 1 });

  // Feed the real post-flow snapshot into the Telegram /status builder.
  const diagnostic = buildTelegramStatusDiagnostic({
    config: { enabled: true, allowedTgUserId: "1", targetSessionKey: "telegram:1" },
    token: { tokenConfigured: true, tokenStored: true },
    approvalStatus: { status: "stopped", transport: "native" },
    migrationSnapshot: env.ctrl.getSnapshot(),
    nativeRunnerStatus: { polling: true },
    pendingApprovalCount: 0,
    sessionSnapshot: { sessions: [] },
    now: 1000,
  });
  assert.equal(diagnostic.lastError, null);
});

test("Retry legacy (USER_ENABLE_LEGACY) failing again refreshes the stale runtime message", async () => {
  const env = makeController({
    initialFiles: { hasLegacyEnvFile: true, legacyConfigComplete: true },
  });
  await env.ctrl.init(); // LEGACY_ACTIVE, sidecar running
  await env.ctrl.dispatch({ type: EVENTS.SIDECAR_RUNTIME_FAILED, reason: "old", message: "old failure" });
  assert.equal(env.ctrl.getSnapshot().runtimeStatus.message, "old failure");

  env.sidecar.failStart = true; // retry will fail again
  const res = await env.ctrl.dispatch({ type: EVENTS.USER_ENABLE_LEGACY });
  assert.equal(res.ok, false);
  assert.equal(res.state, STATES.LEGACY_ACTIVE); // stays legacy-selected
  const rs = env.ctrl.getSnapshot().runtimeStatus;
  assert.equal(rs.status, "failed");
  assert.equal(rs.reason, "SIDECAR_START_FAILED");
  assert.notEqual(rs.message, "old failure"); // refreshed, not stale
});
