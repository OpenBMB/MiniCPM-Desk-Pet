"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  STATES,
  EVENTS,
  SIDE_EFFECTS,
  ERROR_CODES,
  defaultPrefs,
  defaultFiles,
  normalizePrefs,
  normalizeFiles,
  applyEvent,
  computeInitial,
  checkInvariants,
} = require("../src/telegram-migration-state");

const { ALL_CASES } = require("./fakes/migration-transitions");

function effectTypes(fx) {
  return (fx || []).map((e) => e && e.type).filter(Boolean);
}

test("normalizePrefs handles undefined/null/invalid transport", () => {
  const out = normalizePrefs(undefined);
  assert.equal(out.prefs.transport, "off");
  assert.equal(out.normalized, true);

  const out2 = normalizePrefs({ transport: "garbage" });
  assert.equal(out2.prefs.transport, "off");
  assert.equal(out2.normalized, true);

  const out3 = normalizePrefs({ transport: "legacy" });
  assert.equal(out3.prefs.transport, "legacy");
  assert.equal(out3.normalized, false);
});

test("normalizeFiles tolerates missing input", () => {
  assert.deepEqual(normalizeFiles(undefined), defaultFiles());
  assert.deepEqual(normalizeFiles(null), defaultFiles());
  assert.deepEqual(
    normalizeFiles({ hasLegacyEnvFile: 1, legacyConfigComplete: "yes", nativeConfigComplete: 0 }),
    { hasLegacyEnvFile: true, legacyConfigComplete: true, nativeConfigComplete: false },
  );
});

test("defaultPrefs / defaultFiles are stable", () => {
  assert.equal(defaultPrefs().transport, "off");
  assert.equal(defaultPrefs().nativeVerifiedAt, null);
  assert.deepEqual(defaultFiles(), {
    hasLegacyEnvFile: false,
    legacyConfigComplete: false,
    nativeConfigComplete: false,
  });
});

for (const c of ALL_CASES) {
  test(c.name, () => {
    const ctx = { state: c.state, prefs: c.prefs, files: c.files };
    const result =
      c.event.type === EVENTS.INIT
        ? computeInitial({ prefs: c.prefs, files: c.files })
        : applyEvent(ctx, c.event);

    assert.equal(result.state, c.expect.state, `state mismatch for ${c.name}`);
    assert.deepEqual(
      effectTypes(result.sideEffects),
      c.expect.sideEffectTypes,
      `sideEffectTypes mismatch for ${c.name}`,
    );

    if (c.expect.errorCode !== undefined) {
      assert.equal(result.errorCode, c.expect.errorCode, `errorCode mismatch for ${c.name}`);
    } else {
      assert.equal(result.errorCode, null, `unexpected errorCode for ${c.name}`);
    }

    if (c.expect.prefsPatch) {
      assert.deepEqual(result.prefsPatch, c.expect.prefsPatch, `prefsPatch mismatch for ${c.name}`);
    }

    // Invariant: mutual exclusion must never be violated by emitted side effects.
    const violations = checkInvariants(result);
    assert.deepEqual(violations, [], `invariant violations: ${violations.join("; ")}`);

    // Invariant: illegal transitions return the same state unchanged.
    if (c.expect.errorCode === ERROR_CODES.ILLEGAL_TRANSITION) {
      assert.equal(result.state, c.state, "illegal event must leave state unchanged");
      assert.deepEqual(result.sideEffects, [], "illegal event must emit no side effects");
    }
  });
}

test("applyEvent: unknown event type → illegal, state unchanged", () => {
  const result = applyEvent(
    { state: STATES.LEGACY_ACTIVE, prefs: { transport: "legacy" }, files: { legacyConfigComplete: true } },
    { type: "UNKNOWN_NOISE" },
  );
  assert.equal(result.state, STATES.LEGACY_ACTIVE);
  assert.equal(result.errorCode, ERROR_CODES.ILLEGAL_TRANSITION);
  assert.deepEqual(result.sideEffects, []);
});

test("applyEvent: missing event → illegal, state unchanged", () => {
  const result = applyEvent({ state: STATES.NATIVE_ACTIVE, prefs: {}, files: {} }, null);
  assert.equal(result.state, STATES.NATIVE_ACTIVE);
  assert.equal(result.errorCode, ERROR_CODES.ILLEGAL_TRANSITION);
});

test("checkInvariants flags simultaneous START_SIDECAR + START_NATIVE_POLLER", () => {
  const violations = checkInvariants({
    state: STATES.TESTING_NATIVE,
    sideEffects: [
      { type: SIDE_EFFECTS.START_SIDECAR },
      { type: SIDE_EFFECTS.START_NATIVE_POLLER },
    ],
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /START_SIDECAR and START_NATIVE_POLLER/);
});

test("Full migration happy path: IDLE → TESTING_NATIVE → NATIVE_ACTIVE", () => {
  let state = STATES.IDLE;
  let prefs = defaultPrefs();
  const files = { hasLegacyEnvFile: false, legacyConfigComplete: false, nativeConfigComplete: true };

  const r1 = applyEvent({ state, prefs, files }, { type: EVENTS.USER_TEST_NATIVE });
  assert.equal(r1.state, STATES.TESTING_NATIVE);
  state = r1.state;

  const r2 = applyEvent({ state, prefs, files }, { type: EVENTS.TEST_SUCCESS, at: 1234567890 });
  assert.equal(r2.state, STATES.NATIVE_ACTIVE);
  assert.deepEqual(r2.prefsPatch, { transport: "native", nativeVerifiedAt: 1234567890 });
  prefs = { ...prefs, ...r2.prefsPatch };
  state = r2.state;

  // After restart: INIT should rehydrate to NATIVE_ACTIVE.
  const r3 = computeInitial({ prefs, files });
  assert.equal(r3.state, STATES.NATIVE_ACTIVE);
  assert.deepEqual(effectTypes(r3.sideEffects), [SIDE_EFFECTS.START_NATIVE_POLLER]);
});

test("Legacy migration path: LEGACY_ACTIVE → TESTING_NATIVE → TEST_FAILED → LEGACY_ACTIVE", () => {
  let state = STATES.LEGACY_ACTIVE;
  const prefs = { transport: "legacy", nativeVerifiedAt: null, migration: {} };
  const files = { hasLegacyEnvFile: true, legacyConfigComplete: true, nativeConfigComplete: true };

  const r1 = applyEvent({ state, prefs, files }, { type: EVENTS.USER_TEST_NATIVE });
  assert.equal(r1.state, STATES.TESTING_NATIVE);
  assert.deepEqual(effectTypes(r1.sideEffects), [
    SIDE_EFFECTS.STOP_SIDECAR,
    SIDE_EFFECTS.START_NATIVE_POLLER,
    SIDE_EFFECTS.SEND_TEST_CARD,
  ]);
  state = r1.state;

  const r2 = applyEvent({ state, prefs, files }, { type: EVENTS.TEST_FAILED, errorClass: "401" });
  assert.equal(r2.state, STATES.LEGACY_ACTIVE);
  assert.deepEqual(effectTypes(r2.sideEffects), [
    SIDE_EFFECTS.STOP_NATIVE_POLLER,
    SIDE_EFFECTS.START_SIDECAR,
  ]);
});

test("Rollback path: NATIVE_ACTIVE → SWITCHING_TO_LEGACY → LEGACY_ACTIVE", () => {
  let state = STATES.NATIVE_ACTIVE;
  let prefs = { transport: "native", nativeVerifiedAt: 1, migration: {} };
  const files = { hasLegacyEnvFile: true, legacyConfigComplete: true, nativeConfigComplete: true };

  const r1 = applyEvent({ state, prefs, files }, { type: EVENTS.USER_ROLLBACK_TO_LEGACY });
  assert.equal(r1.state, STATES.SWITCHING_TO_LEGACY);
  state = r1.state;

  const r2 = applyEvent({ state, prefs, files }, { type: EVENTS.SIDECAR_STARTED });
  assert.equal(r2.state, STATES.LEGACY_ACTIVE);
  assert.deepEqual(r2.prefsPatch, { transport: "legacy" });
});

test("SIDECAR_RUNTIME_FAILED @ LEGACY_ACTIVE → LEGACY_ACTIVE + only EMIT_RUNTIME_STATUS", () => {
  const r = applyEvent(
    { state: STATES.LEGACY_ACTIVE, prefs: { transport: "legacy" }, files: {} },
    { type: EVENTS.SIDECAR_RUNTIME_FAILED, reason: "boom", message: "sidecar exited (signal SIGTERM)" },
  );
  assert.equal(r.errorCode, null);
  assert.equal(r.state, STATES.LEGACY_ACTIVE);
  assert.deepEqual(effectTypes(r.sideEffects), [SIDE_EFFECTS.EMIT_RUNTIME_STATUS]);
  const payload = r.sideEffects[0].payload;
  assert.equal(payload.transport, "legacy");
  assert.equal(payload.status, "failed");
  assert.equal(payload.reason, "boom");
  assert.equal(payload.message, "sidecar exited (signal SIGTERM)");
  // Runtime health never persists prefs nor transitions state.
  assert.equal(r.prefsPatch, undefined);
});

test("SIDECAR_RUNTIME_FAILED is illegal outside LEGACY_ACTIVE (incl. SWITCHING_TO_LEGACY)", () => {
  for (const state of [
    STATES.IDLE,
    STATES.NATIVE_ACTIVE,
    STATES.TESTING_NATIVE,
    STATES.SWITCHING_TO_LEGACY,
    STATES.NEEDS_SETUP,
  ]) {
    const r = applyEvent({ state, prefs: {}, files: {} }, { type: EVENTS.SIDECAR_RUNTIME_FAILED, reason: "x" });
    assert.equal(r.errorCode, ERROR_CODES.ILLEGAL_TRANSITION, `state=${state}`);
    assert.equal(r.state, state);
    assert.deepEqual(r.sideEffects, []);
  }
});

test("SIDECAR_RUNTIME_RECOVERED @ LEGACY_ACTIVE clears message (shallow-merge safe)", () => {
  const r = applyEvent(
    { state: STATES.LEGACY_ACTIVE, prefs: { transport: "legacy" }, files: {} },
    { type: EVENTS.SIDECAR_RUNTIME_RECOVERED },
  );
  assert.equal(r.state, STATES.LEGACY_ACTIVE);
  assert.deepEqual(effectTypes(r.sideEffects), [SIDE_EFFECTS.EMIT_RUNTIME_STATUS]);
  const payload = r.sideEffects[0].payload;
  assert.equal(payload.status, "running");
  assert.equal(payload.reason, null);
  assert.equal(payload.message, "");
});

test("SIDECAR_RUNTIME_RECOVERED is illegal outside LEGACY_ACTIVE", () => {
  const r = applyEvent(
    { state: STATES.SWITCHING_TO_LEGACY, prefs: {}, files: {} },
    { type: EVENTS.SIDECAR_RUNTIME_RECOVERED },
  );
  assert.equal(r.errorCode, ERROR_CODES.ILLEGAL_TRANSITION);
  assert.deepEqual(r.sideEffects, []);
});

test("SIDECAR_START_FAILED carries message through runtime-status", () => {
  const r = applyEvent(
    { state: STATES.SWITCHING_TO_LEGACY, prefs: {}, files: {} },
    { type: EVENTS.SIDECAR_START_FAILED, reason: "RB", message: "boom detail" },
  );
  assert.equal(r.state, STATES.LEGACY_ACTIVE);
  const emit = r.sideEffects.find((e) => e.type === SIDE_EFFECTS.EMIT_RUNTIME_STATUS);
  assert.ok(emit, "expected EMIT_RUNTIME_STATUS");
  assert.equal(emit.payload.message, "boom detail");
});

test("checkInvariants: runtime failure event emits no start side-effects", () => {
  const r = applyEvent(
    { state: STATES.LEGACY_ACTIVE, prefs: { transport: "legacy" }, files: {} },
    { type: EVENTS.SIDECAR_RUNTIME_FAILED, reason: "x" },
  );
  assert.deepEqual(checkInvariants(r), []);
});
