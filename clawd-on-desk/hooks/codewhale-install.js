#!/usr/bin/env node
// Register Clawd's CodeWhale hooks in the user's codewhale config.
//
// Strategy: append [[hooks.hooks]] entries into ~/.codewhale/config.toml.
// Idempotent — existing clawd-managed entries are updated, others preserved.
//
// CodeWhale hook config format ([[hooks.hooks]] TOML array of tables):
//
//   [hooks]
//   enabled = true
//
//   [[hooks.hooks]]
//   event = "session_start"
//   command = "node /path/to/codewhale-hook.js session_start"
//   background = true
//
// CodeWhale provides context via environment variables:
//   DEEPSEEK_SESSION_ID, DEEPSEEK_TOOL_NAME, DEEPSEEK_MODE,
//   DEEPSEEK_WORKSPACE, DEEPSEEK_MODEL, DEEPSEEK_ERROR, etc.

const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  asarUnpackedPath,
  extractExistingNodeBinFromCommands,
  formatNodeHookCommand,
} = require("./json-utils");
const { resolveNodeBin } = require("./server-config");

const CODEWHALE_CONFIG_PATH = path.join(os.homedir(), ".codewhale", "config.toml");
const MANAGED_MARKER = "managed by clawd-on-desk";
const HOOK_SCRIPT_MARKER = "codewhale-hook.js";
const TOML_HEADER_RE = /^\s*\[[^\]]+\]/;

// Hook events to register. Each entry: [event, background]
// session_end is NOT background — must await delivery.
// shell_env is excluded (not relevant for state animation).
const HOOK_ENTRIES = [
  ["session_start", true],
  ["session_end", false],
  ["message_submit", true],
  ["tool_call_before", true],
  ["tool_call_after", true],
  ["mode_change", true],
  ["on_error", true],
];

function resolveHookScriptPath(baseDir) {
  const dir = path.resolve(baseDir || __dirname, "codewhale-hook.js");
  return asarUnpackedPath(dir).replace(/\\/g, "/");
}

function normalizePath(p) {
  return String(p || "").replace(/\\/g, "/");
}

function envConfigPath(options = {}) {
  const env = options.env || process.env;
  const value = env && (
    (typeof env.CODEWHALE_CONFIG_PATH === "string" && env.CODEWHALE_CONFIG_PATH.trim())
    || (typeof env.DEEPSEEK_CONFIG_PATH === "string" && env.DEEPSEEK_CONFIG_PATH.trim())
  );
  return value ? path.resolve(String(value).trim()) : null;
}

function resolveCodewhaleConfigPath(options = {}) {
  if (typeof options.configPath === "string" && options.configPath.trim()) {
    return path.resolve(options.configPath);
  }
  return envConfigPath(options) || CODEWHALE_CONFIG_PATH;
}

function hasExplicitConfigPath(options = {}) {
  return !!(typeof options.configPath === "string" && options.configPath.trim()) || !!envConfigPath(options);
}

function extractExistingCodewhaleNodeBin(sections) {
  const commands = [];
  for (const section of sections || []) {
    if (!section || section.header !== "hooks.hooks" || !Array.isArray(section.lines)) continue;
    for (const line of section.lines) {
      if (
        /^\s*command\s*=/.test(String(line || "")) &&
        String(line || "").includes(HOOK_SCRIPT_MARKER)
      ) {
        commands.push(String(line));
      }
    }
  }
  return extractExistingNodeBinFromCommands(commands, HOOK_SCRIPT_MARKER);
}

function buildHookEntry(event, background, hookScriptPath, options = {}) {
  const nodeBin = options.nodeBin !== undefined
    ? options.nodeBin
    : (resolveNodeBin(options) || options.existingNodeBin || "node");
  const nodePath = normalizePath(nodeBin);
  const hookPath = normalizePath(hookScriptPath);

  // Use the same node binary that runs Clawd, so the hook can require() our
  // shared modules (server-config, shared-process). Windows node.exe must be
  // quoted in TOML when the path contains spaces.
  const command = formatNodeHookCommand(nodePath, hookPath, {
    platform: options.platform || process.platform,
    windowsWrapper: "none",
    args: [event],
  });

  const lines = [];
  lines.push("");
  lines.push("[[hooks.hooks]]");
  lines.push(`# ${MANAGED_MARKER}`);
  lines.push(`event = "${event}"`);
  lines.push(`command = '''${command}'''`);
  if (background) {
    lines.push("background = true");
  }
  // timeout_secs = 5 is safe for fire-and-forget; session_end gets 30s default
  if (!background) {
    lines.push("timeout_secs = 30");
    lines.push("continue_on_error = true");
  } else {
    lines.push("timeout_secs = 5");
  }
  return lines.join("\n");
}

function parseTomlSections(content) {
  // Minimal TOML parser: split into sections, preserving raw text.
  // We only need to find/replace [[hooks.hooks]] entries with the managed marker.
  const sections = [];
  const lines = content.split("\n");
  let current = { header: null, startLine: 0, lines: [] };
  let inHooksTable = false;

  function takeTrailingManagedMarker(lines) {
    let markerIndex = lines.length - 1;
    while (markerIndex >= 0 && !String(lines[markerIndex] || "").trim()) markerIndex--;
    if (markerIndex < 0 || !String(lines[markerIndex]).includes(MANAGED_MARKER)) return [];
    return lines.splice(markerIndex);
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Detect [[hooks.hooks]] entries
    if (/^\[\[hooks\.hooks\]\]/.test(trimmed)) {
      const leadingMarker = takeTrailingManagedMarker(current.lines);
      if (current.lines.length > 0 || current.header) {
        sections.push({ ...current, endLine: i - 1 });
      }
      current = { header: "hooks.hooks", startLine: i - leadingMarker.length, lines: [...leadingMarker, line] };
      inHooksTable = true;
      continue;
    }

    // Detect [hooks] section header (without the double brackets)
    if (/^\[hooks\]/.test(trimmed) && !trimmed.startsWith("[[")) {
      if (current.lines.length > 0 || current.header) {
        sections.push({ ...current, endLine: i - 1 });
      }
      current = { header: "hooks", startLine: i, lines: [line] };
      inHooksTable = true;
      continue;
    }

    // End of hooks-related section when hitting any different TOML table.
    if (inHooksTable && TOML_HEADER_RE.test(trimmed)) {
      sections.push({ ...current, endLine: i - 1 });
      current = { header: null, startLine: i, lines: [line] };
      inHooksTable = false;
      continue;
    }

    current.lines.push(line);
  }
  if (current.lines.length > 0 || current.header) {
    sections.push({ ...current, endLine: lines.length - 1 });
  }

  return sections;
}

function sectionHasMarker(section) {
  return section.lines.some((line) => line.includes(MANAGED_MARKER));
}

function sectionHasClawdHookCommand(section) {
  return section.lines.some((line) => (
    /^\s*command\s*=/.test(String(line || "")) &&
    String(line || "").includes(HOOK_SCRIPT_MARKER)
  ));
}

function sectionIsManagedHook(section) {
  if (!section || section.header !== "hooks.hooks") return false;
  return sectionHasMarker(section) || sectionHasClawdHookCommand(section);
}

function ensureHooksEnabled(section) {
  if (!section || section.header !== "hooks") return false;
  const enabledIdx = section.lines.findIndex((line) => /^\s*enabled\s*=/.test(String(line || "")));
  if (enabledIdx >= 0) {
    if (/^\s*enabled\s*=\s*true(?:\s*(?:#.*)?)?$/.test(String(section.lines[enabledIdx] || ""))) {
      return false;
    }
    section.lines[enabledIdx] = "enabled = true";
    return true;
  }
  section.lines.splice(1, 0, "enabled = true");
  return true;
}

function buildClawdHookSections(hookScriptPath, options = {}) {
  const sections = [];
  for (const [event, background] of HOOK_ENTRIES) {
    sections.push(buildHookEntry(event, background, hookScriptPath, options));
  }
  return sections;
}

function registerCodewhaleHooks(options = {}) {
  const hookScriptPath = options.hookScriptPath || resolveHookScriptPath();
  const configPath = resolveCodewhaleConfigPath(options);
  const explicitConfigPath = hasExplicitConfigPath(options);

  // Check if ~/.codewhale/ exists
  const configDir = path.dirname(configPath);
  let configDirExists = false;
  try {
    configDirExists = fs.statSync(configDir).isDirectory();
  } catch {}
  if (!configDirExists && !explicitConfigPath) {
    if (!options.silent) {
      console.log("Clawd: ~/.codewhale/ not found — skipping CodeWhale hook registration");
    }
    return { added: 0, removed: 0, updated: 0, skipped: true };
  }

  let content;
  try {
    content = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      content = "";
    } else {
      throw new Error(`Failed to read ${configPath}: ${err.message}`);
    }
  }

  // If config doesn't exist or is empty → bootstrap with [hooks] + entries
  if (!content.trim()) {
    const hookSections = buildClawdHookSections(hookScriptPath, options);
    const newContent = [
      "# codewhale Configuration",
      "",
      "[hooks]",
      "enabled = true",
      ...hookSections,
      "",
    ].join("\n");

    const dir = path.dirname(configPath);
    if (!configDirExists) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configPath, newContent, "utf8");

    if (!options.silent) {
      console.log(`Clawd CodeWhale hooks → ${configPath}`);
      console.log(`  Created config with ${HOOK_ENTRIES.length} hooks`);
    }
    return { added: HOOK_ENTRIES.length, removed: 0, updated: 0, skipped: false };
  }

  // Parse existing config
  const sections = parseTomlSections(content);
  const existingNodeBin = extractExistingCodewhaleNodeBin(sections);
  const entryOptions = existingNodeBin
    ? { ...options, existingNodeBin }
    : options;

  // Find existing clawd-managed hook entries
  const managedHookIndices = [];
  for (let i = 0; i < sections.length; i++) {
    if (sectionIsManagedHook(sections[i])) {
      managedHookIndices.push(i);
    }
  }

  // Build new managed entries
  const newEntries = buildClawdHookSections(hookScriptPath, entryOptions);

  // Remove old managed entries
  const matchedManagedHooks = managedHookIndices.length;
  for (const idx of managedHookIndices.reverse()) {
    sections.splice(idx, 1);
  }

  // Insert new entries after [hooks] section or at end
  let hooksIdx = sections.findIndex((s) => s.header === "hooks");

  // If no [hooks] section, add one
  if (hooksIdx < 0) {
    sections.push({ header: "hooks", startLine: -1, lines: ["[hooks]", "enabled = true"] });
    hooksIdx = sections.length - 1;
  } else {
    ensureHooksEnabled(sections[hooksIdx]);
  }

  // Insert managed entries (as raw strings — we insert them into the sections array)
  let insertIdx = hooksIdx + 1;
  for (const entry of newEntries) {
    const entryLines = entry.split("\n");
    sections.splice(insertIdx, 0, {
      header: "hooks.hooks",
      startLine: -1,
      lines: entryLines,
    });
    insertIdx++;
  }

  // Reconstruct TOML
  const newLines = [];
  for (const section of sections) {
    for (const line of section.lines) {
      if (line || newLines.length === 0 || newLines[newLines.length - 1] !== "") {
        newLines.push(line);
      }
    }
  }

  const newContent = newLines.join("\n").trim() + "\n";
  const updated = newContent !== content;
  const removed = updated ? matchedManagedHooks : 0;

  if (updated) {
    // Atomic write
    const tmpPath = path.join(configDir, `.config.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmpPath, newContent, "utf8");
    fs.renameSync(tmpPath, configPath);
  }

  const added = updated ? HOOK_ENTRIES.length : 0;
  if (!options.silent) {
    console.log(`Clawd CodeWhale hooks → ${configPath}`);
    if (updated) {
      console.log(`  Registered ${added} hooks (removed ${removed} old entries)`);
    } else {
      console.log(`  Already up to date (${HOOK_ENTRIES.length} hooks)`);
    }
  }

  return { added, removed, updated, skipped: !updated };
}

function unregisterCodewhaleHooks(options = {}) {
  const configPath = resolveCodewhaleConfigPath(options);

  let content;
  try {
    content = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      if (!options.silent) console.log("Clawd: CodeWhale config not found");
      return { removed: 0, skipped: true };
    }
    throw err;
  }

  const sections = parseTomlSections(content);
  let removed = 0;

  for (let i = sections.length - 1; i >= 0; i--) {
    if (sectionIsManagedHook(sections[i])) {
      sections.splice(i, 1);
      removed++;
    }
  }

  if (removed === 0) {
    if (!options.silent) console.log("Clawd: no managed CodeWhale hooks found");
    return { removed: 0, skipped: true };
  }

  const newLines = [];
  for (const section of sections) {
    for (const line of section.lines) {
      if (line || newLines.length === 0 || newLines[newLines.length - 1] !== "") {
        newLines.push(line);
      }
    }
  }

  const newContent = newLines.join("\n").trim() + "\n";
  const configDir = path.dirname(configPath);
  const tmpPath = path.join(configDir, `.config.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmpPath, newContent, "utf8");
  fs.renameSync(tmpPath, configPath);

  if (!options.silent) {
    console.log(`Clawd CodeWhale hooks removed: ${removed}`);
  }

  return { removed, skipped: false };
}

module.exports = {
  CODEWHALE_CONFIG_PATH,
  HOOK_ENTRIES,
  parseTomlSections,
  registerCodewhaleHooks,
  resolveCodewhaleConfigPath,
  unregisterCodewhaleHooks,
  // Exposed for tests
  __test: {
    buildHookEntry,
    parseTomlSections,
    sectionHasMarker,
    sectionHasClawdHookCommand,
    sectionIsManagedHook,
    ensureHooksEnabled,
    buildClawdHookSections,
    extractExistingCodewhaleNodeBin,
    envConfigPath,
    hasExplicitConfigPath,
    resolveHookScriptPath,
    normalizePath,
  },
};

if (require.main === module) {
  try {
    if (process.argv.includes("--uninstall")) {
      unregisterCodewhaleHooks({});
    } else {
      registerCodewhaleHooks({});
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
