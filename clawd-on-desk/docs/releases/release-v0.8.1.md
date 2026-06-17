## v0.8.1

### New Features

- **Qwen Code integration** - Added first-class Qwen Code support via `~/.qwen/settings.json` command hooks. Clawd now tracks Qwen Code sessions, working / completion-attention transitions, model and cwd metadata, and blocking `PermissionRequest` approvals through desktop permission bubbles. Windows hook commands use an encoded PowerShell wrapper so Node paths with spaces survive Qwen's `cmd.exe /s` execution path.
- **Antigravity CLI (agy) integration** - Added state-only Antigravity CLI support through `~/.gemini/config/hooks.json`. Clawd reflects agy working / idle / attention state while intentionally leaving permissions to agy's native 5-option terminal menu; `PreToolUse` is not registered so users do not get double-confirmation loops.
- **Copilot CLI hook auto-sync** (#341) - Copilot CLI hooks now auto-register at Clawd startup like Claude Code / Codex / Cursor — no more manual `~/.copilot/hooks/hooks.json` setup. Path resolution honors `$COPILOT_HOME` (trimmed; empty / whitespace falls back to `~/.copilot`); 10 events are covered, including the previously missing `preCompact` so compaction shows the sweeping animation. Doctor now uses a dedicated `copilot-hooks` mode that scans `bash` / `powershell` / `command` fields, validates per-event coverage, and reports `disableAllHooks: true` as a warning without offering Fix so Clawd never overrides an explicit opt-out. Marker-based merge preserves other hook entries and other `hooks/*.json` files.
- **Hardware Buddy groundwork (experimental)** - Hardened Clawd's adapter for an external [Clawstick runtime](https://github.com/rullerzhou-afk/clawstick), including the Settings panel, permission-reply toggle, internal quick-command event path, test approval flow, Unicode hardening, missing-runtime status, and BLE link preservation when permission routing is toggled. Clawd v0.8.1 does not bundle, download, or advertise Hardware Buddy as an out-of-the-box user feature.
- **Quick Commands plumbing** - Added an internal validated event path that adapters can use to enqueue preset actions for the active session. The v0.8.1 Settings panel does not expose local preset buttons yet.
- **Background update checks** (#329, #345) - Clawd can now quietly check GitHub releases on a scheduler, remember a pending version, surface the hint in About/tray/update bubbles, reconcile yanked releases, and keep manual update checks explicit.
- **Task-complete tray flash** (#335) - The tray icon can flash when an AI task completes, making completion visible even when the pet is covered.
- **Session HUD click-to-reveal** (#327, #337, #339) - Replaced hover auto-hide with a more deliberate click-to-reveal interaction and added optional HUD state labels so live sessions are easier to scan.
- **Claude Code API error events** (#338) - Claude API errors are now surfaced as `ApiError` events so Dashboard/HUD history and visual state have a clearer failure signal.
- **Clawd idle animation refresh** - Refreshed Clawd idle / reading / bubble assets and added the new bubble idle animation and GIF preview.

### Bug Fixes

- **Pi agent restored to state-only mode** (#322) - Pi extension reports lifecycle and tool activity only. Clawd no longer shows Pi permission bubbles, no longer calls Pi terminal confirmation, and preserves Pi's default YOLO execution behavior.
- **Legacy Pi permission hook compatibility** - Older in-memory Pi extension instances that still POST `/permission` now receive an allow response from Clawd, so they do not get blocked by stale bubble logic while the user is upgrading.
- **Claude cold-start hook blocking** (#349) - Fixed a startup path where Claude hook handling could block during cold start.
- **Codex native prompt sound muted by default** (#346) - Codex fallback/native prompt paths no longer play the desktop prompt sound by default.
- **Remote SSH interactive password prompt unblocked** (#351) - Reordered SSH options so `ssh -o` first-wins behavior does not suppress interactive password prompts.
- **Remote SSH deploy shell safety** (#332) - In-app one-click deploy now blocks Windows `cmd.exe` remote shell paths. The `scripts/remote-deploy.sh` CLI fallback is unchanged and still expects a POSIX-style remote shell.
- **Remote Codex completion retention** (#318) - Fixed stale cleanup controls and remote Codex retention so completed remote sessions do not vanish too aggressively.
- **Windows hook Node path resolution** (#317) - Hook installers now prefer absolute Node paths and share the Windows resolver across Antigravity/Qwen-style wrappers. Antigravity Windows hooks now use the encoded PowerShell command path so `cmd.exe` does not split Node paths with spaces.
- **Qwen Code event sequencing** - Dropped generic Qwen completion notifications from state updates, filtered synthetic self-submit prompts, mapped true Stop events back to attention, and split tool/stop boundary tracking so Qwen sessions animate predictably.
- **OpenClaw agent titles** - Hardened OpenClaw session title caching and displays the OpenClaw agent name, including emoji, when provided by the plugin.
- **Eye tracking clamp** (#327, #340) - Horizontal pupil movement is clamped so Clawd's eyes stay visually anchored near the face.
- **Mini enter rendering** (#333) - Avoided overly crisp mini enter rendering by restoring the expected asset behavior.
- **Windows event sound warmup** - Improved first-play reliability for event sounds on Windows.
- **Dashboard scrollbar polish** (#328) - Dashboard `.content` now matches Settings scrollbar styling.

### Upgrade Notes

- Existing v0.8.0 profiles with the Pi permission bubble subgate enabled are migrated back to `false` because the subgate no longer has runtime effect.
- Restart already-running Pi agent sessions after upgrading. Until restart, an old in-memory extension may still try the former `/permission` path; Clawd online will allow it, but if Clawd is offline that old extension can still fall back to Pi terminal confirmation.
- Codex native prompt sound is migrated to muted by default. If you previously relied on the Codex native prompt sound, re-enable it from Settings after upgrading.
- **Copilot CLI hooks are now auto-synced on first launch.** If you previously hand-wrote `~/.copilot/hooks/hooks.json` (or `$COPILOT_HOME/hooks/hooks.json`), Clawd-owned entries — anything whose `bash` / `powershell` / `command` references `copilot-hook.js` — get rewritten to use the resolved absolute Node binary path and the canonical 10-event set. Non-Clawd entries and other files under `hooks/` are left untouched. Back up `hooks.json` first if you have customized any Clawd-marker entries you want to preserve. (#341)
- **Qwen Code hooks are auto-synced when Qwen is installed.** Clawd manages entries containing `qwen-code-hook.js` in `~/.qwen/settings.json`; user hooks not owned by Clawd are preserved. `disableAllHooks: true` still prevents Qwen from firing hooks until the user removes that flag.
- **Antigravity remains state-only by design.** If agy asks for permission, answer in agy's native terminal menu. Clawd will not show a second approval bubble for agy.
- **Hardware Buddy is opt-in and external.** Existing installs start with Hardware Buddy disabled. To use it, install or checkout the [Clawstick runtime](https://github.com/rullerzhou-afk/clawstick) separately, place it next to Clawd as `../clawstick`, or set `CLAWD_HARDWARE_BUDDY_ROOT`, then enable Hardware Buddy from Settings or environment-backed development flags.
- Release metadata is bumped to `0.8.1` in both `package.json` and `package-lock.json`.

### Docs & Contributors

- README and setup guides now document Qwen Code, Antigravity CLI, Copilot auto-sync, Remote SSH guide entry points, Pi state-only behavior, and Hermes plugin install boundaries. Setup guides and known limitations document Hardware Buddy's external Clawstick runtime requirement.
- Traditional Chinese localization was improved by @pan93412 (#310).
- Contributor surfaces now include @linnin233 and @xiyouMc in README and About.
- 6 contributors shipped code, docs, tests, or release polish in this release.

### Contributors

Huge thanks to everyone who shipped code, tests, docs, or release polish for v0.8.1:

- **@rullerzhou-afk** - Qwen Code integration and dogfood fixes, Hardware Buddy external-runtime groundwork and hardening, Copilot release notes, OpenClaw title hardening, Remote Codex retention, refreshed Clawd idle assets, and release/documentation cleanup.
- **@Ruller_Lulu** - Antigravity CLI integration, Copilot auto-sync, background update scheduler, Session HUD click-to-reveal and labels, Quick Commands, Pi state-only fix, Remote SSH fixes, Claude/Codex hook hardening, Windows hook path fixes, mini/eye tracking/sound polish, and release review merges.
- **@linnin233** - Tray icon flash on AI task completion (#335).
- **@nmsn** - Dashboard scrollbar styling polish (#328).
- **@xiyouMc** (machao) - OpenClaw agent display name support with emoji.
- **@pan93412 / Yi-Jyun Pan** - Traditional Chinese localization improvements (#310).

### Known Limitations

- **Qwen Code support is hook-driven.** If Qwen disables hooks globally with `disableAllHooks: true`, Clawd can register entries but Qwen will not fire them until the flag is removed.
- **Antigravity CLI has no Clawd permission bubble.** This is intentional; agy's own terminal menu owns permissions to avoid duplicate confirmations.
- **Hardware Buddy depends on the external Clawstick runtime and local BLE/backend availability.** The fake backend is useful for testing, but real hardware behavior still needs device-level validation.
- **Remote SSH terminal focus remains local-only.** Remote sessions can report state and permissions through the tunnel, but terminal focus is not available for remote hosts.
- **macOS / Linux real-machine QA remains best-effort.** CI builds artifacts, but Windows remains the primary hands-on validation environment.
