"use strict";

function stdoutForAntigravityEvent(hookName) {
  if (hookName === "PreToolUse") return JSON.stringify({ decision: "ask" });
  if (hookName === "Stop") return JSON.stringify({ decision: "allow" });
  return "{}";
}

module.exports = {
  stdoutForAntigravityEvent,
};
