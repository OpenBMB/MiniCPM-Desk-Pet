## v0.10.0

v0.10.0 is built around five larger pieces of work: a rework of **how agent
integrations get installed** (on-demand and opt-in per agent, so startup is no
longer slowed by probing agents you do not use), **two new state-only agent
integrations** (Reasonix and CodeWhale), a danger-gated **auto-pilot** that
auto-approves permissions for a single session, **global / per-display text
sizing** across every Clawd surface, and **mobile companion token-rotation
security** — plus a broad round of platform hardening across Linux/Wayland,
tmux, Windows focus, and macOS.

This release also welcomes **seven first-time contributors**.

### New Features

- **On-demand agent integrations** (#476, #481, #488, #489) - Clawd now separates "supported agent" from "integration installed on this machine." A fresh install defaults to managing only **Claude Code and Codex**; the other 15 agents start *Not installed* and are installed explicitly from **Settings → Agents** (each row gets an Installed / Not installed badge and Install / Uninstall buttons). This removes the startup cost of serially probing every agent's hooks/plugins/extensions (cold `/state` was ~4.2s of that being integration sync). Install commits only after a real sync succeeds; Uninstall runs a marker-scoped cleaner (backups on by default) that removes only Clawd-managed entries and leaves your other hooks intact. Doctor now shows unmanaged agents as an info-level *not-managed* state instead of misreporting them as broken. The data model migrates `prefs` v10 → v11.
- **Reasonix CLI integration — state-only** (#483) - Added Phase 1 state-only Reasonix support: Clawd reflects Reasonix working / idle / attention state without injecting its own permission bubble. *Thanks to first-time contributor @sLingli.*
- **CodeWhale integration — state-only** (#415) - Added Phase 1 state-only CodeWhale support, wired through the on-demand install model and mode-change notifications. *Thanks to first-time contributor @ustin-star.*
- **Auto-pilot — danger auto-approve, session-only** (#448, #455) - A new **danger-gated** toggle in its own **Permissions** section auto-approves *all* agent permission requests for the current session. It is **off by default**, **never persists across restarts** (ephemeral by design), is labeled red / "Danger" in the menu, answers elicitation prompts with a deferral reply, and treats the confirm dialog as a real security boundary rather than UI-only. *Thanks to @zxypro1 (Zone Tome).*
- **Global / per-display text size** (#463) - A text-size slider scales bubbles, the Session HUD, the Dashboard, and Settings together, injected as CSS zoom so it survives reloads. Sizing is stored **per display**, the HUD dampens its width growth at large scales so chips and collapsible rows do not clip, and the auto-hide hot zone scales with it so the pin stays reachable.
- **Mobile companion — token-rotation security (M2)** (#452, #475) - The read-only mobile companion gains a static-token **rotation / revocation / grace-period** protocol, plus **rotate-on-use**: the 24h rotation is deferred when no clients are online and a grace token is delivered after the heartbeat starts so a connected phone is never abruptly locked out. *Thanks to core contributor @Bynlk.*
- **Drag a folder onto the pet to open a terminal** (#472) - Drop a folder onto the pet and Clawd opens a terminal there. **Windows / Linux only** in this release (see Upgrade Notes); the macOS OS-drop path is intentionally disabled. The macOS "New Session" flow still `cd`s explicitly into the target directory.
- **Hide / show the pet from the right-click menu** (#469) - The context menu gains a "Hide pet" / "Show pet" entry (theme-agnostic wording, localized across all five languages). Hiding is **not** do-not-disturb: it tucks away the pet / HUD / update bubble, but newly arriving permission requests still bubble as before — use DND to silence those.
- **Silence Task-subagent permission bubbles per agent** (#454) - A per-agent sub-gate suppresses permission bubbles raised by Claude Code Task subagents, scoped to `claude-code` so it does not affect other agents.
- **Claude & Codex context usage** (#397) - Sessions can surface Claude and Codex context-window usage. *Thanks to first-time contributor @Tsdsj.*

### Bug Fixes

- **Linux: relaunch under XWayland on Wayland sessions** (#443, #441) - On a Wayland session Clawd now relaunches itself under XWayland (spawning the replacement directly rather than via `app.relaunch`, with a guarded spawn fallback), fixing transparency / positioning regressions. Covered by a headless-Wayland CI smoke test.
- **tmux: switch to the focused pane on terminal focus** (#462) - Focus resolution now resolves the terminal PID and switches the correct tmux pane / client for tmux users instead of grabbing the wrong client. *Thanks to first-time contributor @cod3hulk.*
- **Windows: validate cached focus targets** (#477) - Cached Windows focus targets are validated before reuse so a stale handle no longer focuses the wrong window. *Thanks to first-time contributor @lxgxhsy.*
- **Windows: position persistence on restart** (#405) - Fixed the pet not restoring its saved position on Windows restart.
- **Windows: new-session launch failure 0x800700c1** (#438) - "New Session" on Windows now resolves the `claude.cmd` shim and routes `wt.exe` through `cmd.exe`, fixing the 0x800700c1 launch error.
- **macOS: restore minimized windows when jumping back to a session** (#468, #465) - Jumping back to a session now restores a minimized macOS terminal window instead of silently failing.
- **macOS: harden hook stdout safety and permission-bubble clicks** (#420) - Hardened hook stdout handling and fixed a macOS permission-bubble click path. *Thanks to first-time contributor @godlockin.*
- **macOS: permission hotkeys no longer refocus the terminal** (#492, #482) - Answering a permission with the keyboard shortcut (Ctrl+Shift+Y / Ctrl+Shift+N) on macOS no longer pulls focus back to the agent terminal when the frontmost app cannot be captured — focus stays where you are. *Reported by @Easton518.*
- **Packaging: agents unpacked from asar** (#488) - Added `agents/**/*` to `asarUnpack`, fixing a `MODULE_NOT_FOUND` for hook scripts in packaged release builds. *Thanks to first-time contributor @rebootcrab-blip.*
- **Doctor: don't flag all-info integrations as critical** (#491, #490) - A set of agent integrations that are all info-level no longer summarizes to a false "critical" in Doctor.
- **Codex: relabel MCP tool calls** (#450, #445) - Codex MCP tool calls are labeled as the tool instead of a generic "Permission Request."
- **Codex: deterministic subagent headless gate** (#455, #448) - Codex subagent permissions are detected as headless by hook source and kept out of the auto-pilot allow path, with doc/comment cleanups.
- **State: debounce Stop completion for headless sessions** (#453, #449) - Headless sessions get a default Stop-completion debounce so they stop celebrating completion prematurely.
- **State: stop replaying completion animation on duplicate Stop** (#447) - A duplicate Stop no longer replays the end-of-session animation.
- **Telegram: honor the system proxy for the native bot** (#440, #359) - The native Telegram bot routes through the system proxy via Electron `session.fetch`.
- **Telegram: surface legacy sidecar runtime failures** (#439, #430) - Legacy Go-sidecar runtime failures now surface in the migration state instead of failing silently.
- **Telegram: strip the approval keyboard when resolved on desktop** (#446) - Resolving an approval on the desktop strips the inline keyboard from the Telegram message. *Thanks to @zxypro1 (Zone Tome).*
- **Kiro: build Windows CLI candidate paths with `path.win32`** (#442) - Fixed Kiro CLI path resolution on Windows.
- **Updater: drop the duplicated `v` prefix in update labels** (#434) - Update labels no longer render a doubled `vv` prefix.
- **Antigravity: harden hook fail-open** (#433) - The Antigravity hook fails open more robustly.
- **Qwen Code: official icon** (#458, #456) - Swapped the Qwen Code icon to the official mark.

### Upgrade Notes

- **On-demand agent integrations — existing users keep their setup.** Upgrading does **not** change your current behavior: migration backfills `integrationInstalled` only for agents that already exist in your prefs and preserves each one's `enabled` state, so nothing you already use is silently disconnected. What changes is the **fresh-install default** (only Claude Code / Codex are managed up front) and the fact that adding a *new* agent integration is now an explicit **Settings → Agents → Install**. Turning on a not-installed agent's `enabled` switch only opens its event/monitor entry and writes no integration files. Uninstall removes only Clawd-managed hook/plugin/extension entries (backups on by default).
- **Auto-pilot is a danger feature, off by default, and session-only.** It auto-approves every agent permission request for the current session, never persists across restarts, and lives behind a red "Danger" confirm. Enable it only when you intend to let an agent run unattended for that session.
- **Drag-folder-to-terminal is Windows / Linux only.** The macOS OS-drop path is intentionally disabled in this release; use the pet's "New Session" entry on macOS.
- **Text size is stored per display.** Existing defaults are unchanged; the slider unifies bubble / HUD / Dashboard / Settings scaling and is applied via injected CSS zoom.
- Release metadata is bumped to `0.10.0` in both `package.json` and `package-lock.json`; `prefs` migrates v10 → v11 on first launch.

### Contributors

Huge thanks to everyone who shipped code, tests, docs, or release polish for v0.10.0 — and an especially warm welcome to this release's **seven first-time contributors**:

- **@rullerzhou-afk** (鹿鹿 · creator) - On-demand agent integration install/uninstall model and prefs v10→v11 migration, auto-pilot follow-ups and Codex headless gating, global / per-display text sizing, drag-folder-to-terminal, hide/show pet, Task-subagent permission sub-gate, Telegram system-proxy / sidecar-runtime fixes, Windows new-session and position fixes, Linux XWayland relaunch, macOS window restore and permission-hotkey focus fix, Doctor and updater fixes, and release work.
- **@sLingli** - Reasonix CLI state-only integration (#483). *First-time contributor.*
- **@ustin-star** - CodeWhale state-only integration (#415). *First-time contributor.*
- **@Tsdsj** - Claude & Codex context-usage display (#397). *First-time contributor.*
- **@godlockin** - Hook stdout safety hardening and the macOS permission-bubble click fix (#420). *First-time contributor.*
- **@cod3hulk** - tmux pane/client focus resolution (#462). *First-time contributor.*
- **@lxgxhsy** - Windows cached-focus-target validation (#477). *First-time contributor.*
- **@rebootcrab-blip** - `asarUnpack` fix for packaged hook scripts (#488). *First-time contributor.*
- **@Bynlk** - Mobile companion M2: static-token rotation / revocation / grace-period and rotate-on-use (#452, #475).
- **@zxypro1** (Zone Tome) - Danger auto-pilot toggle (#448) and the Telegram desktop-resolve keyboard strip (#446).

### Known Limitations

- **Reasonix and CodeWhale are Phase 1, state-only.** Clawd reflects their working / idle / attention state but does not take over permission decisions or raise its own permission bubble. Real CLI smoke validation is still pending.
- **Drag-folder-to-terminal does not work on macOS, and Linux is not yet real-machine verified.** On macOS the screen-saver-layer window is not visible to the OS drag-target search, so the OS-drop path is disabled there; Linux drag delivery is verified post-release.
- **Auto-pilot disables interactive permission review for the session it is on.** It is a deliberate convenience-vs-safety trade-off; it stays off unless you explicitly enable it and resets on restart.
- **macOS / Linux real-machine QA remains best-effort.** CI builds artifacts and there is now a headless-Wayland smoke test, but Windows is still the primary hands-on validation environment.
