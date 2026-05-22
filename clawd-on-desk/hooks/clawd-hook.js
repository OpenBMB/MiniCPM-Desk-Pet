#!/usr/bin/env node
// Clawd Desktop Pet — Claude Code Hook Script
// Usage: node clawd-hook.js <event_name>
// Reads stdin JSON from Claude Code for session_id

const crypto = require("crypto");
const fs = require("fs");
const { postStateToRunningServer, readHostPrefix } = require("./server-config");
const { createPidResolver, readStdinJson, getPlatformConfig } = require("./shared-process");

const TRANSCRIPT_TAIL_BYTES = 262144; // 256 KB
const SESSION_TITLE_CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]+/g;
const SESSION_TITLE_MAX = 80;
const LAST_SUMMARY_MAX = 110;
const TOOL_MATCH_STRING_MAX = 240;
const TOOL_MATCH_ARRAY_MAX = 16;
const TOOL_MATCH_OBJECT_KEYS_MAX = 32;
const TOOL_MATCH_DEPTH_MAX = 6;

function normalizeTitle(value) {
  if (typeof value !== "string") return null;
  const collapsed = value
    .replace(SESSION_TITLE_CONTROL_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!collapsed) return null;
  return collapsed.length > SESSION_TITLE_MAX
    ? `${collapsed.slice(0, SESSION_TITLE_MAX - 1)}\u2026`
    : collapsed;
}

// Read the tail of a Claude Code transcript JSONL and return the most recent
// user-set session title (custom-title / agent-name events). Returns null if
// the file is missing/unreadable or no title events are found.
function extractSessionTitleFromTranscript(transcriptPath) {
  if (typeof transcriptPath !== "string" || !transcriptPath) return null;

  let data;
  let truncated = false;
  let fd = null;
  try {
    const stat = fs.statSync(transcriptPath);
    fd = fs.openSync(transcriptPath, "r");
    const readLen = Math.min(stat.size, TRANSCRIPT_TAIL_BYTES);
    truncated = stat.size > readLen;
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, Math.max(0, stat.size - readLen));
    data = buf.toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }

  const lines = data.split("\n");
  // If we read a tail of a larger file, the first line is likely a truncated
  // JSON fragment — drop it so JSON.parse doesn't fail noisily on it.
  if (truncated && lines.length > 1) lines.shift();

  let latest = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || typeof obj !== "object") continue;
    const type = typeof obj.type === "string" ? obj.type : "";
    if (type !== "custom-title" && type !== "agent-name") continue;
    latest =
      normalizeTitle(obj.customTitle) ||
      normalizeTitle(obj.title) ||
      normalizeTitle(obj.custom_title) ||
      normalizeTitle(obj.agentName) ||
      normalizeTitle(obj.agent_name) ||
      latest;
  }
  return latest;
}

function normalizeToolUseId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

// Walk the Claude Code transcript JSONL forward to find the very first
// `type: "user"` message and use it as the conversation topic ("title").
// Mirrors cursor-hook's extractFirstUserQuery so narration framing has
// the actual subject (e.g. "晚餐推荐") instead of falling back to the
// cwd basename ("ekkoz").
function extractFirstUserQueryFromTranscript(transcriptPath) {
  if (typeof transcriptPath !== "string" || !transcriptPath) return null;
  let data, fd = null;
  try {
    fd = fs.openSync(transcriptPath, "r");
    // Reading from the head, not the tail — title is the first user msg.
    const stat = fs.statSync(transcriptPath);
    const readLen = Math.min(stat.size, TRANSCRIPT_TAIL_BYTES);
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, 0);
    data = buf.toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
  const lines = data.split("\n").filter(Boolean);
  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || obj.type !== "user") continue;
    const msg = obj.message;
    if (!msg) continue;
    let text = "";
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part && part.type === "text" && typeof part.text === "string") text += part.text;
      }
    }
    text = text
      .replace(SESSION_TITLE_CONTROL_RE, " ")
      .replace(/\s+/g, " ")
      .trim();
    // Skip system-injected prefaces like /init, hook tests, etc.
    if (!text || text.startsWith("/")) continue;
    if (text.length > SESSION_TITLE_MAX) text = text.slice(0, SESSION_TITLE_MAX - 1) + "…";
    return text;
  }
  return null;
}

// Read the tail of a Claude Code transcript JSONL and return the last
// assistant text message (truncated). Powers the narration's "AI 最后说"
// summary so the local model can react to outcomes, not just topics.
//
// Claude transcript format (different from Cursor):
//   { type: "user" | "assistant" | "permission-mode" | ...,
//     message: { role, content: string | [{ type: "text", text: "..." }, ...] } }
function extractLastAssistantSummary(transcriptPath) {
  if (typeof transcriptPath !== "string" || !transcriptPath) return null;

  // Race-condition guard: Claude Code can fire Stop hooks BEFORE the last
  // assistant turn is fully flushed to the JSONL transcript on disk. Wait
  // for the file size to settle (no growth for ~120ms) up to a hard cap,
  // so we don't extract a stale "previous turn" summary.
  const POLL_INTERVAL_MS = 60;
  const SETTLE_MS = 120;
  const MAX_WAIT_MS = 1200;
  const startedAt = Date.now();
  let lastSize = -1;
  let lastChange = startedAt;
  // Synchronous busy-wait via a child-process sleep would block too long;
  // use Atomics.wait on a SAB instead — works in all Node 18+.
  const sleep = (ms) => {
    const sab = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(sab), 0, 0, ms);
  };
  while (Date.now() - startedAt < MAX_WAIT_MS) {
    let size;
    try { size = fs.statSync(transcriptPath).size; } catch { return null; }
    if (size !== lastSize) {
      lastSize = size;
      lastChange = Date.now();
    } else if (Date.now() - lastChange >= SETTLE_MS) {
      break;  // file size hasn't changed for SETTLE_MS — assume flushed
    }
    sleep(POLL_INTERVAL_MS);
  }

  let data, fd = null;
  try {
    const stat = fs.statSync(transcriptPath);
    fd = fs.openSync(transcriptPath, "r");
    const readLen = Math.min(stat.size, TRANSCRIPT_TAIL_BYTES);
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, Math.max(0, stat.size - readLen));
    data = buf.toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }

  // Iterate lines bottom-up, find first assistant entry with text content.
  const lines = data.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let obj;
    try { obj = JSON.parse(lines[i]); } catch { continue; }
    if (!obj || obj.type !== "assistant") continue;
    const msg = obj.message;
    if (!msg) continue;
    let text = "";
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part && part.type === "text" && typeof part.text === "string") {
          text += part.text;
        }
      }
    }
    text = text
      .replace(SESSION_TITLE_CONTROL_RE, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    // Prefer the first sentence boundary so we don't dump a wall of text.
    const stop = text.search(/[。！？!?\n]/);
    if (stop > 0 && stop < LAST_SUMMARY_MAX) text = text.slice(0, stop + 1);
    if (text.length > LAST_SUMMARY_MAX) text = text.slice(0, LAST_SUMMARY_MAX - 1) + "…";
    return text;
  }
  return null;
}

function normalizeToolMatchValue(value, depth = 0) {
  if (depth > TOOL_MATCH_DEPTH_MAX) return null;
  if (Array.isArray(value)) {
    return value
      .slice(0, TOOL_MATCH_ARRAY_MAX)
      .map((entry) => normalizeToolMatchValue(entry, depth + 1));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort().slice(0, TOOL_MATCH_OBJECT_KEYS_MAX)) {
      out[key] = normalizeToolMatchValue(value[key], depth + 1);
    }
    return out;
  }
  if (typeof value === "string") {
    return value.length > TOOL_MATCH_STRING_MAX
      ? `${value.slice(0, TOOL_MATCH_STRING_MAX - 1)}…`
      : value;
  }
  return value;
}

function buildToolInputFingerprint(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return null;
  const normalized = normalizeToolMatchValue(toolInput);
  return crypto
    .createHash("sha1")
    .update(JSON.stringify(normalized))
    .digest("hex");
}

const EVENT_TO_STATE = {
  SessionStart: "idle",
  SessionEnd: "sleeping",
  UserPromptSubmit: "thinking",
  PreToolUse: "working",
  PostToolUse: "working",
  PostToolUseFailure: "error",
  Stop: "attention",
  StopFailure: "error",
  SubagentStart: "juggling",
  SubagentStop: "working",
  PreCompact: "sweeping",
  PostCompact: "attention",
  Notification: "notification",
  // PermissionRequest is handled by HTTP hook (blocking) — not command hook
  Elicitation: "notification",
  WorktreeCreate: "carrying",
};

function isTaskToolStart(event, payload) {
  // Claude Code may report subagent launches as PreToolUse(Task) without a
  // matching SubagentStart. Keep PostToolUse(Task) as a normal working update:
  // state.js holds juggling through working events and releases it on a later
  // Stop/UserPromptSubmit, or on a real SubagentStop if Claude emits one.
  return event === "PreToolUse"
    && payload
    && typeof payload.tool_name === "string"
    && payload.tool_name === "Task";
}

function buildStateBody(event, payload, resolve) {
  const state = EVENT_TO_STATE[event];
  if (!state) return null;

  const sessionId = payload.session_id || "default";
  const cwd = payload.cwd || "";
  const source = payload.source || payload.reason || "";
  const syntheticSubagentStart = isTaskToolStart(event, payload);

  // /clear triggers SessionEnd → SessionStart in quick succession;
  // show sweeping (clearing context) instead of sleeping
  const resolvedState = syntheticSubagentStart
    ? "juggling"
    : ((event === "SessionEnd" && source === "clear") ? "sweeping" : state);
  const resolvedEvent = syntheticSubagentStart ? "SubagentStart" : event;

  const body = { state: resolvedState, session_id: sessionId, event: resolvedEvent };
  body.agent_id = "claude-code";
  if (cwd) body.cwd = cwd;
  const toolName = typeof payload.tool_name === "string" && payload.tool_name ? payload.tool_name : null;
  const toolUseId = normalizeToolUseId(payload.tool_use_id ?? payload.toolUseId ?? payload.toolUseID);
  const toolInputFingerprint = buildToolInputFingerprint(
    payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : null
  );
  if (toolName) body.tool_name = toolName;
  if (toolUseId) body.tool_use_id = toolUseId;
  if (toolInputFingerprint) body.tool_input_fingerprint = toolInputFingerprint;
  // Session title: prefer payload field, then user-set custom-title /
  // agent-name events near the tail, then fall back to the very first
  // user message in the transcript (the actual conversation topic).
  const sessionTitle =
    normalizeTitle(payload.session_title) ||
    extractSessionTitleFromTranscript(payload.transcript_path) ||
    extractFirstUserQueryFromTranscript(payload.transcript_path);
  if (sessionTitle) body.session_title = sessionTitle;
  // Last assistant message — only attached for stop / sessionEnd because
  // mid-conversation events don't represent a "final outcome" yet, and
  // parsing the transcript on every tool-use would be wasteful.
  if (resolvedEvent === "Stop" || resolvedEvent === "SessionEnd") {
    const lastSummary = extractLastAssistantSummary(payload.transcript_path);
    if (lastSummary) body.last_summary = lastSummary;
  }
  if (process.env.CLAWD_REMOTE) {
    body.host = readHostPrefix();
  } else {
    const { stablePid, agentPid, agentCommandLine, detectedEditor, pidChain } = resolve();
    body.source_pid = stablePid;
    if (detectedEditor) body.editor = detectedEditor;
    if (agentPid) {
      body.agent_pid = agentPid;
      body.claude_pid = agentPid; // backward compat with older Clawd versions
      if (agentCommandLine && /\s(-p|--print)(\s|$)/.test(agentCommandLine)) {
        body.headless = true;
      }
    }
    if (pidChain.length) body.pid_chain = pidChain;
  }

  return body;
}

function main() {
  const event = process.argv[2];
  if (!EVENT_TO_STATE[event]) process.exit(0);

  const config = getPlatformConfig();
  const resolve = createPidResolver({
    agentNames: { win: new Set(["claude.exe"]), mac: new Set(["claude"]) },
    agentCmdlineCheck: (cmd) => cmd.includes("claude-code") || cmd.includes("@anthropic-ai"),
    platformConfig: config,
  });

  // Pre-resolve on SessionStart (runs during stdin buffering, not after)
  // Remote mode: skip PID collection — remote PIDs are meaningless on the local machine
  if (event === "SessionStart" && !process.env.CLAWD_REMOTE) resolve();

  readStdinJson().then((payload) => {
    // Cursor IDE invokes ~/.claude/settings.json hooks for its own Agent
    // events (compatibility shim), passing a Cursor-shaped payload with
    // fields like `cursor_version` / `conversation_id` / `composer_mode`.
    // Those events are already covered by hooks/cursor-hook.js via
    // ~/.cursor/hooks.json — if we also post them here they will overwrite
    // the session's agentId to "claude-code" and the HUD logo will flip
    // between Cursor and Claude Code.
    if (payload && (
      typeof payload.cursor_version !== "undefined"
      || typeof payload.conversation_id !== "undefined"
      || typeof payload.composer_mode !== "undefined"
    )) {
      process.exit(0);
    }
    const body = buildStateBody(event, payload || {}, resolve);
    if (!body) process.exit(0);
    postStateToRunningServer(
      JSON.stringify(body),
      { timeoutMs: 100 },
      () => process.exit(0)
    );
  });
}

if (require.main === module) main();

module.exports = { buildStateBody, extractSessionTitleFromTranscript };
