#!/usr/bin/env node
// Long-lived end-to-end harness for hooks/copilot-hook.js permissionRequest
// path. Run before shipping any change to copilot-hook.js or copilot-install.js
// to catch regressions in allow/deny/no-decision wire format, exit-0
// guarantees, and fail-open paths. Documented in this directory's README.
//
// Spins up a mock Clawd HTTP server on 127.0.0.1:23333 returning each of
// the response shapes Clawd can actually emit (200/204/500), then spawns
// `node copilot-hook.js permissionRequest` and pipes a stdin payload in.
//
// What this verifies that copilot-hook.test.js does NOT:
//   - process.stdout writes survive a Windows pipe under safeExit(0)
//   - exit code 0 across allow / deny / 204 / 500 / connection refused /
//     malformed stdin paths (no kill-by-timeoutSec deadlock window)
//   - empty stdout on every fallback path (Phase 0 §3 native-flow signal)

"use strict";
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const HOOK_SCRIPT = path.resolve(__dirname, "..", "..", "hooks", "copilot-hook.js");
const PORT = 23333;

const SAMPLE_PAYLOAD = {
  hookName: "permissionRequest",
  sessionId: "e2e-test-session",
  timestamp: Date.now(),
  cwd: process.cwd(),
  toolName: "edit",
  toolInput: { file_path: "test.txt", diff: "+hello" },
  permissionSuggestions: [],
};

// One mock server per scenario. We make headers + body explicit so the
// hook's parseClawdPermissionResponse sees what Clawd's real route sends.
function startMockServer(responder) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => responder(req, body, res));
    });
    server.once("error", (err) => {
      if (err && err.code === "EADDRINUSE") {
        reject(new Error(
          `Port ${PORT} already in use — likely a real Clawd instance is running. ` +
          `Stop Clawd (tray → quit) before running this harness so the mock can take its port.`,
        ));
      } else {
        reject(err);
      }
    });
    server.listen(PORT, "127.0.0.1", () => resolve(server));
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function runHookWithStdin(stdinPayload, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK_SCRIPT, "permissionRequest"], {
      env: { ...process.env, CLAWD_REMOTE: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`hook did not exit within ${timeoutMs}ms; partial stdout=${JSON.stringify(stdout)}`));
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr });
    });
    if (typeof stdinPayload === "string") {
      child.stdin.write(stdinPayload);
    } else {
      child.stdin.write(JSON.stringify(stdinPayload));
    }
    child.stdin.end();
  });
}

const scenarios = [
  {
    name: "1. Clawd returns 200 allow",
    payload: SAMPLE_PAYLOAD,
    serverResponder(req, body, res) {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "x-clawd-server": "clawd-on-desk",
      });
      res.end(JSON.stringify({ behavior: "allow" }));
    },
    expect: { exitCode: 0, stdout: '{"behavior":"allow"}' },
  },
  {
    name: "2. Clawd returns 200 deny with message",
    payload: SAMPLE_PAYLOAD,
    serverResponder(req, body, res) {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "x-clawd-server": "clawd-on-desk",
      });
      res.end(JSON.stringify({ behavior: "deny", message: "Blocked by Clawd" }));
    },
    expect: { exitCode: 0, stdout: '{"behavior":"deny","message":"Blocked by Clawd"}' },
  },
  {
    name: "3. Clawd returns 204 no-decision",
    payload: SAMPLE_PAYLOAD,
    serverResponder(req, body, res) {
      res.writeHead(204, { "x-clawd-server": "clawd-on-desk" });
      res.end();
    },
    expect: { exitCode: 0, stdout: "" },
  },
  {
    name: "4. Clawd returns 500 internal error",
    payload: SAMPLE_PAYLOAD,
    serverResponder(req, body, res) {
      res.writeHead(500);
      res.end("internal error");
    },
    expect: { exitCode: 0, stdout: "" },
  },
  {
    name: "5. Clawd unreachable (no mock server bound)",
    payload: SAMPLE_PAYLOAD,
    serverResponder: null,
    expect: { exitCode: 0, stdout: "" },
  },
  {
    name: "6. Malformed stdin — non-JSON string",
    payload: "not json garbage",
    serverResponder(req, body, res) {
      res.writeHead(500);
      res.end("should not reach");
    },
    expect: { exitCode: 0, stdout: "" },
  },
  {
    name: "7. Stdin {} (empty object) — strict validator rejects missing sessionId",
    payload: {},
    serverResponder(req, body, res) {
      res.writeHead(500);
      res.end("should not reach");
    },
    expect: { exitCode: 0, stdout: "" },
  },
  {
    name: "8. Stdin missing toolInput — strict validator rejects",
    payload: { sessionId: "s1", toolName: "edit" },
    serverResponder(req, body, res) {
      res.writeHead(500);
      res.end("should not reach");
    },
    expect: { exitCode: 0, stdout: "" },
  },
  {
    name: "9. Wrong server identity header (not Clawd) — treat as no-decision",
    payload: SAMPLE_PAYLOAD,
    serverResponder(req, body, res) {
      // Same shape as Clawd would emit but missing the identity header.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ behavior: "allow" }));
    },
    expect: { exitCode: 0, stdout: "" },
  },
];

async function runOne(scenario) {
  let server = null;
  if (scenario.serverResponder) {
    server = await startMockServer(scenario.serverResponder);
  }
  let result;
  try {
    result = await runHookWithStdin(scenario.payload);
  } finally {
    if (server) await stopServer(server);
  }
  const exitOk = result.exitCode === scenario.expect.exitCode;
  const stdoutOk = result.stdout === scenario.expect.stdout;
  const pass = exitOk && stdoutOk;
  return { scenario, result, exitOk, stdoutOk, pass };
}

(async () => {
  const results = [];
  for (const scenario of scenarios) {
    process.stdout.write(`Running: ${scenario.name} ... `);
    try {
      const outcome = await runOne(scenario);
      results.push(outcome);
      process.stdout.write(outcome.pass ? "PASS\n" : "FAIL\n");
      if (!outcome.pass) {
        console.log(`    expected exit=${scenario.expect.exitCode} stdout=${JSON.stringify(scenario.expect.stdout)}`);
        console.log(`    actual   exit=${outcome.result.exitCode} stdout=${JSON.stringify(outcome.result.stdout)}`);
        if (outcome.result.stderr) console.log(`    stderr=${JSON.stringify(outcome.result.stderr)}`);
      }
    } catch (err) {
      results.push({ scenario, error: err.message, pass: false });
      console.log(`ERROR: ${err.message}`);
      // EADDRINUSE on the very first scenario means Clawd is still running and
      // every other scenario is going to fail the same way — bail early so the
      // user sees the helpful "stop Clawd" message at the top of the output.
      if (results.length === 1 && /already in use/i.test(err.message)) {
        process.exit(1);
      }
    }
  }
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} scenarios pass.`);
  process.exit(passed === results.length ? 0 : 1);
})();
