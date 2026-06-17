#!/usr/bin/env node
// Codex CLI JSONL log monitor — standalone remote version
// Polls ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl for state changes
// and POSTs them via HTTP to the local Clawd desktop pet (through SSH tunnel).
//
// Zero external dependencies — Node.js built-ins + same-directory hook helpers only.
//
// Usage:
//   node codex-remote-monitor.js            # run as long-lived daemon
//   node codex-remote-monitor.js --once     # single scan then exit (debug)
//   node codex-remote-monitor.js --port 23334  # custom server port
//
// Designed to keep running even when the SSH tunnel is down — failed POSTs
// are silently ignored, and the monitor resumes syncing as soon as the
// tunnel comes back up.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { postStateToRunningServer, readHostPrefix } = require("./server-config");
const { classifySessionMeta } = require("./codex-subagent-fields");
const {
  clampAssistantOutputText,
  extractAssistantTextFromRecord,
} = require("./codex-assistant-output");

// ── Inline config from agents/codex.js (zero-dependency requirement) ──

const SESSION_DIR = path.join(os.homedir(), ".codex", "sessions");
const POLL_INTERVAL_MS = 1500;
const STALE_MS = 300000;

// JSONL record type[:subtype] → pet state. This standalone remote monitor keeps
// a zero-dep subset of agents/codex.js because it posts final states directly
// and does not carry the full local monitor's turn-end/approval heuristics.
// Keep shared Codex JSONL event additions in sync where they affect both paths.
const LOG_EVENT_MAP = {
  "session_meta": "idle",
  "event_msg:task_started": "thinking",
  "event_msg:user_message": "thinking",
  "event_msg:agent_message": "working",
  "event_msg:guardian_assessment": "working",
  "response_item:function_call": "working",
  "response_item:custom_tool_call": "working",
  "response_item:web_search_call": "working",
  "event_msg:task_complete": "attention",
  "event_msg:context_compacted": "sweeping",
  "event_msg:turn_aborted": "idle",
};

// ── CLI args ──

const args = process.argv.slice(2);
const onceMode = args.includes("--once");
const portIndex = args.indexOf("--port");
const preferredPort = portIndex >= 0 ? parseInt(args[portIndex + 1], 10) : undefined;

const hostPrefix = readHostPrefix();

// ── State tracking ──

// Map<filePath, { offset, sessionId, cwd, lastEventTime, lastState, partial }>
const tracked = new Map();

// ── Core polling logic (mirrors agents/codex-log-monitor.js) ──

function getSessionDirs() {
  const dirs = [];
  const now = new Date();
  for (let daysAgo = 0; daysAgo <= 1; daysAgo++) {
    const d = new Date(now);
    d.setDate(d.getDate() - daysAgo);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    dirs.push(path.join(SESSION_DIR, String(yyyy), mm, dd));
  }
  return dirs;
}

function extractSessionId(fileName) {
  // rollout-2026-03-25T15-10-51-019d23d4-f1a9-7633-b9c7-758327137228.jsonl
  const base = fileName.replace(".jsonl", "");
  const parts = base.split("-");
  if (parts.length < 10) return null;
  return parts.slice(-5).join("-");
}

function buildPostStateBody(sessionId, state, event, cwd, isSubagent, host, extra = null) {
  const body = {
    state,
    session_id: sessionId,
    event,
    agent_id: "codex",
    cwd: cwd || "",
    host: host || hostPrefix,
    headless: isSubagent === true,
  };
  if (extra && typeof extra.assistantLastOutput === "string" && extra.assistantLastOutput) {
    body.assistant_last_output = extra.assistantLastOutput;
    if (extra.assistantLastOutputTruncated === true) body.assistant_last_output_truncated = true;
  }
  return JSON.stringify(body);
}

function postState(sessionId, state, event, cwd, isSubagent, extra = null) {
  const body = buildPostStateBody(sessionId, state, event, cwd, isSubagent, undefined, extra);
  postStateToRunningServer(
    body,
    { timeoutMs: 100, preferredPort, remote: true },
    () => {} // fire and forget — tunnel may be down
  );
}

function processLine(line, entry, options = {}) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return;
  }

  const type = obj.type;
  const payload = obj.payload;
  const subtype =
    payload && typeof payload === "object" ? payload.type || "" : "";
  const key = subtype ? type + ":" + subtype : type;

  // Extract CWD from session_meta
  if (type === "session_meta" && payload) {
    entry.cwd = payload.cwd || "";
    entry.isSubagent = classifySessionMeta(payload) === "subagent";
  }

  const assistantText = extractAssistantTextFromRecord(obj);
  if (assistantText) {
    const assistantOutput = clampAssistantOutputText(assistantText);
    entry.assistantLastOutput = assistantOutput ? assistantOutput.text : null;
    entry.assistantLastOutputTruncated = !!(assistantOutput && assistantOutput.truncated);
  }

  const state = LOG_EVENT_MAP[key];
  if (state === undefined || state === null) return;
  const finalState = entry.isSubagent && state === "attention" ? "idle" : state;
  if (key === "event_msg:task_started") {
    entry.assistantLastOutput = null;
    entry.assistantLastOutputTruncated = false;
  }

  // Avoid spamming same state — but never swallow the event when the session
  // is stale: after a "sleeping" post, the next working event must wake the pet
  // back up (post working, refresh lastEventTime, clear stale). Without the
  // `!entry.stale` guard a session whose last state was "working" would stay
  // asleep through every subsequent working event until a state change.
  if (finalState === entry.lastState && finalState === "working" && !entry.stale) return;
  entry.lastState = finalState;
  entry.lastEventTime = Date.now();
  // A real event re-activates the session, so a later idle window re-arms the
  // one-shot "sleeping" post in cleanStaleFiles.
  entry.stale = false;

  const postStateFn = typeof options.postState === "function" ? options.postState : postState;
  const extra = key === "event_msg:task_complete" && entry.assistantLastOutput
    ? {
      assistantLastOutput: entry.assistantLastOutput,
      assistantLastOutputTruncated: entry.assistantLastOutputTruncated === true,
    }
    : null;
  postStateFn(entry.sessionId, finalState, key, entry.cwd, entry.isSubagent, extra);
}

function pollFile(filePath, fileName, options = {}) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return;
  }

  let entry = tracked.get(filePath);
  if (!entry) {
    const sessionId = extractSessionId(fileName);
    if (!sessionId) return;
    entry = {
      offset: 0,
      sessionId: "codex:" + sessionId,
      cwd: "",
      isSubagent: false,
      lastEventTime: Date.now(),
      lastState: null,
      assistantLastOutput: null,
      assistantLastOutputTruncated: false,
      partial: "",
      stale: false,
    };
    tracked.set(filePath, entry);
  }

  // Truncation guard: a retained offset can outlive the bytes it points into.
  // If the file is now smaller than our offset the offset is meaningless —
  // restart from 0 and drop any buffered partial, otherwise we'd skip the whole
  // file forever (and splice a stale partial onto fresh bytes). Mirrors the
  // local monitor's `stat.size >= retired.offset ? retired.offset : 0` guard.
  //
  // Known limitation (size-only): this does NOT catch a same-size or larger
  // in-place replacement of a same-named file — only file-identity tracking
  // (dev/ino, + a Windows ctime fallback) would. We deliberately don't do that:
  // Codex rollout files are append-only and uniquely named
  // (rollout-<ISO ts>-<uuid>.jsonl), never rewritten/recreated in place, so the
  // uncaught cases can't occur in practice and aren't worth the cross-platform
  // identity bookkeeping on an already-large monitor.
  if (stat.size < entry.offset) {
    entry.offset = 0;
    entry.partial = "";
  }

  if (stat.size <= entry.offset) return;

  let buf;
  try {
    const fd = fs.openSync(filePath, "r");
    const readLen = stat.size - entry.offset;
    buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, entry.offset);
    fs.closeSync(fd);
  } catch {
    return;
  }
  entry.offset = stat.size;

  const text = entry.partial + buf.toString("utf8");
  const lines = text.split("\n");
  entry.partial = lines.pop() || "";

  for (const line of lines) {
    if (!line.trim()) continue;
    processLine(line, entry, options);
  }
}

// Post a one-shot "sleeping" after a session goes idle, but KEEP the tracked
// entry (and its byte offset). Deleting it used to drop the offset, so a later
// resume of the same rollout file re-attached at offset 0 and re-read the whole
// JSONL — re-emitting historical terminal events (task_complete) as fresh ones,
// which double-fired completion notifications and dashboard state. Retaining the
// offset means a resume only ever processes newly appended lines.
function cleanStaleFiles(options = {}) {
  const now = typeof options.now === "function" ? options.now() : Date.now();
  const postStateFn = typeof options.postState === "function" ? options.postState : postState;
  for (const [, entry] of tracked) {
    if (!entry.stale && now - entry.lastEventTime > STALE_MS) {
      postStateFn(entry.sessionId, "sleeping", "stale-cleanup", entry.cwd, entry.isSubagent);
      entry.stale = true;
    }
  }
}

// Memory bound: poll() only ever reads files under today/yesterday dirs, so a
// rollout file outside that window can never be re-attached and its retained
// entry is dead weight. Drop entries whose directory left the scan window
// (e.g. once the day rolls over). Directory membership is race-free, unlike a
// readdir listing, so an in-window file is never wrongly pruned mid-flight.
function pruneTrackedOutOfWindow(options = {}) {
  const dirs = (typeof options.getSessionDirs === "function" ? options.getSessionDirs : getSessionDirs)();
  const inWindow = new Set(dirs);
  for (const filePath of Array.from(tracked.keys())) {
    if (!inWindow.has(path.dirname(filePath))) tracked.delete(filePath);
  }
}

function poll() {
  const dirs = getSessionDirs();
  for (const dir of dirs) {
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const now = Date.now();
    for (const file of files) {
      if (!file.startsWith("rollout-") || !file.endsWith(".jsonl")) continue;
      const filePath = path.join(dir, file);
      if (!tracked.has(filePath)) {
        try {
          const mtime = fs.statSync(filePath).mtimeMs;
          if (now - mtime > 120000) continue;
        } catch { continue; }
      }
      pollFile(filePath, file);
    }
  }
  cleanStaleFiles();
  pruneTrackedOutOfWindow();
}

function main() {
  console.log(`Clawd Codex remote monitor started`);
  console.log(`  Session dir: ${SESSION_DIR}`);
  console.log(`  Poll interval: ${POLL_INTERVAL_MS}ms`);
  if (preferredPort) console.log(`  Preferred port: ${preferredPort}`);
  console.log(`  Press Ctrl+C to stop\n`);

  poll();

  if (!onceMode) {
    const interval = setInterval(poll, POLL_INTERVAL_MS);

    process.on("SIGINT", () => {
      clearInterval(interval);
      console.log("\nStopped.");
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      clearInterval(interval);
      process.exit(0);
    });
  }
}

if (require.main === module) main();

module.exports.__test = {
  buildPostStateBody,
  processLine,
  pollFile,
  cleanStaleFiles,
  pruneTrackedOutOfWindow,
  tracked,
  STALE_MS,
};
