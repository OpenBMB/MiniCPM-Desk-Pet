const { describe, it } = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

function runReasonixHook(payload) {
  const scriptPath = path.resolve(__dirname, "..", "hooks", "reasonix-hook.js");
  const blockerPath = path.resolve(__dirname, "hook-http-blocker.js");
  return spawnSync(process.execPath, ["--require", blockerPath, scriptPath], {
    input: `${JSON.stringify(payload)}\n`,
    encoding: "utf8",
    windowsHide: true,
  });
}

describe("Reasonix hook script", () => {
  it("keeps PreCompact stdout empty so Reasonix does not inject summary guidance", () => {
    const result = runReasonixHook({ event: "PreCompact", cwd: "/tmp" });

    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout, "");
    assert.strictEqual(result.stderr, "");
  });

  it("stays silent for regular state-only events too", () => {
    const result = runReasonixHook({
      event: "PreToolUse",
      cwd: "/tmp",
      toolName: "bash",
    });

    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout, "");
    assert.strictEqual(result.stderr, "");
  });
});
