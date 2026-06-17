# Copilot CLI — permissionRequest diagnostic harness

This directory carries two long-lived diagnostic tools for the Copilot CLI
permission bubble integration. They are intentionally not part of the
shipped Clawd binary — they live here as ops aids for re-validating wire
format and fallback behavior whenever Copilot CLI ships a new version.

| Tool | Purpose |
|---|---|
| `capture.js` | Records the real `permissionRequest` stdin payload Copilot CLI sends, and probes Copilot's reaction to each hook stdout / exit-code shape. Originally written for Phase 0 (`docs/investigations/copilot-permission-payload-2026-05.md`). Keep it around: a future Copilot release can change field names, exit-code semantics, or the deadlock UX, and this is how we'd catch it. |
| `e2e-hook.js` | Drives the production `hooks/copilot-hook.js` end-to-end against a mock Clawd HTTP server. Verifies allow / deny / 204 / 500 / connection-refused / malformed-stdin / wrong-server-header all end in `exit 0` with the right stdout. Run before merging any change to `copilot-hook.js` or `copilot-install.js`. |

Both scripts are safe to run by hand. Neither is invoked by Clawd itself
(no auto-sync touches this directory).

---

## `capture.js` — re-run when Copilot CLI ships a new version

1. Make sure Copilot CLI is installed and `copilot --version` reports the
   target version. Record that version + OS in any investigation note you
   produce so future schema diffs have a baseline.
2. Edit `~/.copilot/hooks/hooks.json` and **replace** the Clawd
   permissionRequest entry with one pointing at `capture.js`:

   ```json
   "permissionRequest": [
     {
       "type": "command",
       "bash": "node \"D:/path/to/capture.js\" \"capture\"",
       "powershell": "& node \"D:/path/to/capture.js\" \"capture\"",
       "timeoutSec": 5
     }
   ]
   ```

   Replacing (not appending) is on purpose: Clawd's own permission hook
   would otherwise compete with capture for the same event. After the
   capture run, restart Clawd to have it re-register its own entry.
3. Trigger a permission request from a Copilot session (e.g. ask Copilot
   to create a file under your CWD). Repeat for each `mode` in the table
   below by swapping the `"capture"` argv.
4. Read the resulting JSON lines from the configured log path (default
   `%APPDATA%\clawd-on-desk\debug.log` on Windows, or wherever
   `CLAWD_COPILOT_HOOK_DEBUG_PATH` points). Scrub any tokens / private
   paths before sharing.

### Mode table

| Priority | mode | Hook behavior | Compare against |
|---|---|---|---|
| Required | `capture` | append stdin + exit 0 + empty stdout | Phase 0 §1 schema |
| Required | `exit0-empty` | empty stdout + exit 0 | Phase 0 §3 "empty = native flow" lock |
| Required | `exit0-brace` | stdout `{}` + exit 0 | Phase 0 §3 — should also be native |
| Recommended | `exit2` | exit 2 | Phase 0 §4.1 — docs say deny, empirical fail-open |
| Optional | `exit0-unknown` | unknown behavior field + exit 0 | Should be ignored as no-decision |
| Optional | `exit1` | exit 1 | Docs say fail-open; verify |
| Optional | `hang` | never exit | Phase 0 §4.2 deadlock UX — kept as a regression marker |

---

## `e2e-hook.js` — run before shipping changes to copilot-hook.js

```
node tools/copilot-permission-capture/e2e-hook.js
```

Stopping Clawd is a prerequisite (mock server binds to `127.0.0.1:23333`,
the same port Clawd's own state server uses). The harness prints a
human-readable error if it can't take the port and bails immediately.

It runs 9 scenarios sequentially:

1. Clawd 200 allow → hook stdout `{"behavior":"allow"}`
2. Clawd 200 deny + message → hook stdout `{"behavior":"deny","message":"…"}`
3. Clawd 204 no-decision → hook empty stdout
4. Clawd 500 internal error → hook empty stdout
5. Mock server not bound → hook empty stdout (connection refused)
6. Malformed stdin (non-JSON) → hook empty stdout (strict validator)
7. Stdin `{}` (empty object) → hook empty stdout (missing sessionId)
8. Stdin missing toolInput → hook empty stdout (strict validator)
9. Server identity header missing → hook empty stdout (non-Clawd response)

All scenarios must exit code `0` so Copilot's prompt UI never hits its
`timeoutSec` deadlock window (Phase 0 §4.2).
