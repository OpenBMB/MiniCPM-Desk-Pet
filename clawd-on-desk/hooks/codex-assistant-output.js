"use strict";

const fs = require("fs");
const { StringDecoder } = require("string_decoder");

const TRANSCRIPT_TAIL_BYTES = 262144;
const ASSISTANT_OUTPUT_MAX = 2200;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001F\u007F-\u009F]+/g;

const SKIP_RESPONSE_ITEM_TYPES = new Set([
  "function_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
  "web_search_call",
  "reasoning",
  "local_shell_call",
  "tool_call",
  "tool_result",
]);

const TEXT_RESPONSE_ITEM_TYPES = new Set([
  "message",
  "agent_message",
  "assistant_message",
  "output_text",
  "text",
]);

function normalizeAssistantOutputText(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_RE, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function clampAssistantOutputText(text, maxLen = ASSISTANT_OUTPUT_MAX) {
  const normalized = normalizeAssistantOutputText(text);
  const max = Number.isInteger(maxLen) && maxLen > 0 ? maxLen : ASSISTANT_OUTPUT_MAX;
  if (!normalized) return null;
  if (normalized.length <= max) return { text: normalized, truncated: false };

  const marker = "\n...[truncated]...\n";
  if (max <= marker.length + 20) {
    return { text: normalized.slice(Math.max(0, normalized.length - max)), truncated: true };
  }
  const keep = max - marker.length;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return {
    text: `${normalized.slice(0, head)}${marker}${normalized.slice(normalized.length - tail)}`,
    truncated: true,
  };
}

function textPartsFromContent(content) {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const parts = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (!block || typeof block !== "object") continue;
    const type = typeof block.type === "string" ? block.type : "";
    if (SKIP_RESPONSE_ITEM_TYPES.has(type)) continue;
    if ((type === "text" || type === "output_text" || type === "") && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts;
}

function collectTextCandidates(value) {
  if (!value || typeof value !== "object") return [];
  const candidates = [];
  for (const key of ["content", "text", "output_text", "message", "delta"]) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const raw = value[key];
    if (typeof raw === "string") candidates.push(raw);
    else if (Array.isArray(raw)) candidates.push(...textPartsFromContent(raw));
    else if (raw && typeof raw === "object") {
      candidates.push(...collectTextCandidates(raw));
    }
  }
  return candidates;
}

function responseItemLooksAssistantText(payload) {
  if (!payload || typeof payload !== "object") return false;
  const type = typeof payload.type === "string" ? payload.type : "";
  if (SKIP_RESPONSE_ITEM_TYPES.has(type)) return false;
  const role = typeof payload.role === "string" ? payload.role.toLowerCase() : "";
  if (role && role !== "assistant") return false;
  if (TEXT_RESPONSE_ITEM_TYPES.has(type)) return true;
  return role === "assistant";
}

function extractAssistantTextFromRecord(record) {
  if (!record || typeof record !== "object") return "";
  const payload = record.payload && typeof record.payload === "object" ? record.payload : null;
  if (!payload) return "";

  if (record.type === "event_msg" && payload.type === "agent_message") {
    return normalizeAssistantOutputText(collectTextCandidates(payload).join("\n\n"));
  }

  if (record.type !== "response_item") return "";
  if (!responseItemLooksAssistantText(payload)) return "";
  return normalizeAssistantOutputText(collectTextCandidates(payload).join("\n\n"));
}

function isTurnBoundaryRecord(record) {
  if (!record || typeof record !== "object") return false;
  const payload = record.payload && typeof record.payload === "object" ? record.payload : null;
  if (!payload) return false;
  if (record.type === "event_msg") {
    return payload.type === "task_started" || payload.type === "user_message";
  }
  if (record.type === "response_item" && payload.type === "message") {
    const role = typeof payload.role === "string" ? payload.role.toLowerCase() : "";
    return role === "user";
  }
  return false;
}

function extractLastAssistantTextFromRecords(records, options = {}) {
  if (!Array.isArray(records) || !records.length) return null;
  const maxLen = Number.isInteger(options.maxLen) && options.maxLen > 0
    ? options.maxLen
    : ASSISTANT_OUTPUT_MAX;
  for (let i = records.length - 1; i >= 0; i--) {
    const text = extractAssistantTextFromRecord(records[i]);
    if (text) return clampAssistantOutputText(text, maxLen);
    if (isTurnBoundaryRecord(records[i])) break;
  }
  return null;
}

function readCodexTranscriptTailRecords(transcriptPath, maxBytes = TRANSCRIPT_TAIL_BYTES) {
  if (typeof transcriptPath !== "string" || !transcriptPath.trim()) return [];
  let stat;
  try {
    stat = fs.statSync(transcriptPath);
  } catch {
    return [];
  }
  if (!stat || !Number.isFinite(stat.size) || stat.size <= 0) return [];
  const bytesToRead = Math.min(stat.size, maxBytes);
  const start = stat.size - bytesToRead;
  let fd;
  try {
    fd = fs.openSync(transcriptPath, "r");
    const buf = Buffer.allocUnsafe(bytesToRead);
    const bytesRead = fs.readSync(fd, buf, 0, bytesToRead, start);
    const decoder = new StringDecoder("utf8");
    let text = decoder.write(buf.subarray(0, bytesRead)) + decoder.end();
    let lines = text.split(/\r?\n/);
    if (start > 0 && lines.length) lines = lines.slice(1);
    const out = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {}
    }
    return out;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function extractLastAssistantTextFromTranscript(transcriptPath, options = {}) {
  return extractLastAssistantTextFromRecords(
    readCodexTranscriptTailRecords(transcriptPath, options.maxBytes),
    options
  );
}

module.exports = {
  ASSISTANT_OUTPUT_MAX,
  clampAssistantOutputText,
  extractAssistantTextFromRecord,
  extractLastAssistantTextFromRecords,
  extractLastAssistantTextFromTranscript,
  isTurnBoundaryRecord,
  readCodexTranscriptTailRecords,
};
