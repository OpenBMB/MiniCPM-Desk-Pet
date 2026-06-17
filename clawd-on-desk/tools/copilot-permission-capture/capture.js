#!/usr/bin/env node
// Copilot CLI permissionRequest diagnostic harness.
//
// Originally written for Phase 0 schema capture; kept around as a long-lived
// ops aid for re-verifying Copilot CLI wire format whenever a new version
// ships. See tools/copilot-permission-capture/README.md for the playbook.
//
// Usage: invoked by Copilot CLI as a permissionRequest hook. Behavior switches
// on argv[2]:
//
//   capture      append stdin JSON to debug.log, exit 0 with empty stdout
//                (lets Copilot continue to its native prompt so 鹿鹿 can
//                finish the action; this is the main payload-capture path)
//   exit0-empty  exit 0 with empty stdout (fallback A)
//   exit0-brace  exit 0 with "{}" stdout (fallback B)
//   exit0-unknown exit 0 with {"behavior":"unknown"} (probe unknown behavior)
//   exit1        append, exit 1 (fail-open per docs)
//   exit2        append, exit 2 (deny per docs)
//   hang         append, sleep forever (lets Copilot kill via timeout)
//
// stdin (if present) is appended to debug.log along with mode + ts + exit
// code. Never writes to stdout for "capture" mode — Copilot parses stdout as
// hook decision JSON.
//
// debug.log default: %APPDATA%/clawd-on-desk/debug.log (Windows). Override
// with CLAWD_COPILOT_HOOK_DEBUG_PATH.

const fs = require("fs");
const os = require("os");
const path = require("path");

function resolveDebugPath() {
  if (process.env.CLAWD_COPILOT_HOOK_DEBUG_PATH) {
    return process.env.CLAWD_COPILOT_HOOK_DEBUG_PATH;
  }
  const appData = process.env.APPDATA
    || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(appData, "clawd-on-desk", "debug.log");
}

function appendLog(mode, stdinRaw, extra) {
  const debugPath = resolveDebugPath();
  try {
    fs.mkdirSync(path.dirname(debugPath), { recursive: true });
  } catch {}
  const record = {
    at: new Date().toISOString(),
    source: "copilot-permission-capture",
    mode,
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    stdinBytes: stdinRaw ? Buffer.byteLength(stdinRaw, "utf8") : 0,
    stdinRaw,
    env: {
      COPILOT_HOME: process.env.COPILOT_HOME || null,
      CLAWD_REMOTE: process.env.CLAWD_REMOTE || null,
    },
    ...extra,
  };
  try {
    fs.appendFileSync(debugPath, JSON.stringify(record) + "\n", "utf8");
  } catch {
    // swallow — never block the hook on logging failure
  }
}

function readStdinUtf8() {
  return new Promise((resolve) => {
    let buf = "";
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(buf); } };
    // If Copilot doesn't pipe stdin (shouldn't happen for permissionRequest
    // but defend anyway), exit after a short window.
    const guard = setTimeout(finish, 5000);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { buf += chunk; });
    process.stdin.on("end", () => { clearTimeout(guard); finish(); });
    process.stdin.on("error", () => { clearTimeout(guard); finish(); });
  });
}

async function main() {
  const mode = (process.argv[2] || "capture").trim();
  const stdinRaw = await readStdinUtf8();

  switch (mode) {
    case "capture": {
      appendLog(mode, stdinRaw, { stdoutPlan: "empty", exitPlan: 0 });
      process.exit(0);
      return;
    }
    case "exit0-empty": {
      appendLog(mode, stdinRaw, { stdoutPlan: "empty", exitPlan: 0 });
      process.exit(0);
      return;
    }
    case "exit0-brace": {
      appendLog(mode, stdinRaw, { stdoutPlan: "{}", exitPlan: 0 });
      process.stdout.write("{}");
      process.exit(0);
      return;
    }
    case "exit0-unknown": {
      const payload = '{"behavior":"unknown-probe"}';
      appendLog(mode, stdinRaw, { stdoutPlan: payload, exitPlan: 0 });
      process.stdout.write(payload);
      process.exit(0);
      return;
    }
    case "exit1": {
      appendLog(mode, stdinRaw, { stdoutPlan: "empty", exitPlan: 1 });
      process.exit(1);
      return;
    }
    case "exit2": {
      appendLog(mode, stdinRaw, { stdoutPlan: "empty", exitPlan: 2 });
      process.exit(2);
      return;
    }
    case "hang": {
      appendLog(mode, stdinRaw, { stdoutPlan: "empty", exitPlan: "killed" });
      // Block forever — let Copilot kill us via timeoutSec.
      // setInterval keeps the event loop alive.
      setInterval(() => {}, 60_000);
      return;
    }
    default: {
      appendLog("unknown-mode", stdinRaw, { stdoutPlan: "empty", exitPlan: 0, modeRaw: mode });
      process.exit(0);
      return;
    }
  }
}

main();
