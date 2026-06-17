"use strict";

// Bridge: maps the legacy Telegram approval sidecar's `status-changed` events
// onto migration-controller runtime events, so a runtime sidecar death (or
// recovery) becomes visible in the migration state model instead of only in
// the live sidecar handle. See plan-issue-430.
//
// Design constraints (verified against the reducer + controller):
//   - Runtime health must NOT drive a lifecycle transition. The reducer only
//     accepts SIDECAR_RUNTIME_FAILED/RECOVERED in LEGACY_ACTIVE.
//   - During the narrow USER_ROLLBACK_TO_LEGACY window the sidecar can be ready
//     (`running` already emitted) while the controller is still
//     SWITCHING_TO_LEGACY and has not yet re-dispatched SIDECAR_STARTED. A
//     failure there is NOT covered by the rollback catch (which only fires when
//     manager.apply throws). So we hold the event and retry until the state
//     settles to LEGACY_ACTIVE rather than dropping it or forcing a transition.
//   - `everReady` separates startup failures (owned by start() rejection +
//     controller init/rollback handling) from genuine runtime deaths.
//   - Failures are deduped by reason+message so a later, more specific failure
//     (e.g. "sidecar restart rate limit reached") still updates runtime status.
//   - Dispatch is deferred off the emit call stack (status-changed fires from
//     inside manager.apply) so we never re-enter the serialized apply queue and
//     read a settled snapshot for the guards.

const { EVENTS } = require("./telegram-migration-state");

const DEFAULT_SETTLE_DELAY_MS = 25;
const DEFAULT_SETTLE_RETRY_LIMIT = 8;
const RATE_LIMIT_MESSAGE = "sidecar restart rate limit reached";

function emptyMemory() {
  return { everReady: false, lastFailureKey: "" };
}

// Pure decision. Given the per-instance bridge memory and a sidecar status
// object, return the next memory and the runtime event to (eventually)
// dispatch, or null. Never dispatches — kept side-effect free for unit tests.
function decideSidecarRuntimeEvent(prev, status) {
  const memory = prev || emptyMemory();
  const s = status && status.status;

  if (s === "running") {
    // Reset failure dedupe and request a recovery. `onlyIfRuntimeFailed` makes
    // this a no-op unless the controller currently shows failed, so a fresh
    // instance reaching running also clears an init-failure recorded earlier.
    return {
      memory: { everReady: true, lastFailureKey: "" },
      event: { type: EVENTS.SIDECAR_RUNTIME_RECOVERED, onlyIfRuntimeFailed: true },
    };
  }

  if (s === "failed" && memory.everReady) {
    const message = status && status.message ? String(status.message) : "";
    const reason = message === RATE_LIMIT_MESSAGE
      ? "sidecar_restart_rate_limit"
      : "sidecar_runtime_failed";
    const key = `${reason}\n${message}`;
    if (key === memory.lastFailureKey) return { memory, event: null };
    return {
      memory: { everReady: true, lastFailureKey: key },
      event: { type: EVENTS.SIDECAR_RUNTIME_FAILED, reason, message },
    };
  }

  // starting / stopped / failed-before-ready / unknown: no runtime event.
  return { memory, event: null };
}

// Stateful bridge bound to one sidecar instance. main.js calls onStatusChanged
// from sidecar.on("status-changed"); deps are injected so it is fully testable.
function createTelegramSidecarStatusBridge({
  getSnapshot,
  dispatch,
  setTimer = setTimeout,
  log = () => {},
  settleDelayMs = DEFAULT_SETTLE_DELAY_MS,
  settleRetryLimit = DEFAULT_SETTLE_RETRY_LIMIT,
} = {}) {
  let memory = emptyMemory();

  function defer(event, attempt) {
    const timer = setTimer(() => {
      const snap = (typeof getSnapshot === "function" && getSnapshot()) || {};
      // Hold during the rollback window: ready-but-not-yet-LEGACY_ACTIVE.
      if (snap.state === "SWITCHING_TO_LEGACY" && attempt < settleRetryLimit) {
        defer(event, attempt + 1);
        return;
      }
      if (snap.state !== "LEGACY_ACTIVE") return;
      if (event.onlyIfRuntimeFailed
        && !(snap.runtimeStatus && snap.runtimeStatus.status === "failed")) {
        return;
      }
      const { onlyIfRuntimeFailed, ...dispatchEvent } = event;
      try {
        Promise.resolve(dispatch(dispatchEvent)).catch((err) => {
          log("warn", "telegram runtime status dispatch failed", {
            error: err && err.message ? err.message : String(err),
          });
        });
      } catch (err) {
        log("warn", "telegram runtime status dispatch threw", {
          error: err && err.message ? err.message : String(err),
        });
      }
    }, settleDelayMs);
    if (timer && typeof timer.unref === "function") timer.unref();
    return timer;
  }

  return {
    onStatusChanged(status) {
      const decision = decideSidecarRuntimeEvent(memory, status);
      memory = decision.memory;
      if (decision.event) defer(decision.event, 0);
    },
  };
}

module.exports = {
  createTelegramSidecarStatusBridge,
  decideSidecarRuntimeEvent,
  DEFAULT_SETTLE_DELAY_MS,
  DEFAULT_SETTLE_RETRY_LIMIT,
  RATE_LIMIT_MESSAGE,
};
