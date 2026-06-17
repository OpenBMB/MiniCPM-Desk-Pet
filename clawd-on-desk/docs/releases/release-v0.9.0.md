## v0.9.0

v0.9.0 is a milestone release built around three larger pieces of work: a ground-up
rework of Telegram remote approval into a native Node bot, a brand-new read-only
mobile companion over LAN, and Hermes Agent clarify / permission-bubble groundwork
— plus the usual round of Codex / opencode / macOS hardening.

### New Features

- **Telegram remote approval — native Node bot rework** (#354, #369, #390, #393) - Clawd's Telegram remote approval moves from the bundled Go `cc-connect-clawd` sidecar to a native Node bot. The migration follows a compatibility-first path: the legacy sidecar stays shipped and keeps working, new installs default to the native setup, and existing users switch only when they explicitly tap **"Test native and switch"**. A runtime owner manager guarantees that the sidecar and the native bot never long-poll the same bot token at once (Telegram allows only one `getUpdates` consumer, otherwise 409 Conflict). Native mode unlocks two things legacy never had: **rich approval** (Always allow / one-time approval and `permission_suggestions` buttons) and **completion notifications**.
- **Telegram completion notifications (R1a)** (#369) - When a session finishes, the native bot can send a completion notification to Telegram. This is **native-only**, **off by default**, and tied to the approval switch — turning Telegram approval off also stops notifications, so there is no orphaned toggle that keeps messaging after you think you turned it off. `completionOutputMode` controls whether the message includes the assistant's final text (`full`) or sends no completion output (`off`, the default).
- **Telegram R3 Direct Send (beta, opt-in, Windows-first)** (#390, #393) - Reply to a completion notification from Telegram and Clawd resolves the matching local session, focuses its terminal, and pastes a one-line next prompt into it. This is an **opt-in beta** (`tgApproval.r3DirectSendEnabled`, default off). It deliberately **does not auto-press Enter** — text is pasted and you press Enter locally — and it only delivers after a positive focus confirmation; anything ambiguous falls back to copying the text to the clipboard with a Telegram acknowledgement. Multi-line replies also fall back to clipboard instead of being pasted. Windows is the only platform with the paste primitive in v1; macOS / Linux are fallback-only (copy to clipboard). Direct Send reuses the existing `session-focus.js` eligibility rules: remote / host / web-UI sessions and sessions waiting on a permission decision are never paste targets. On successful Windows paste, Clawd restores the previous text clipboard where available.
- **Mobile companion — read-only PWA LAN preview (M1)** (#391, #412, #419) - A new read-only mobile companion serves a small PWA over the local network so you can watch your sessions from a phone on the same Wi-Fi. It shows live session cards (agent type, active time, event icons), pushes updates event-driven with smooth expand animation and live timers, and hardens reliability with visibility-based reconnect, an uncapped retry, and a socket guard. This is a preview / read-only surface — it does not approve permissions or send prompts.
- **Hermes Agent permission bubble + elicitation** (#387, #398) - Hermes' clarify tool now flows through Clawd's unified `/permission` route and bubble UI instead of the legacy `/clarify` native dialog. General Hermes tool permission interception is also wired through the same route, but remains opt-in behind `CLAWD_HERMES_PERMISSION_TOOLS` while Hermes' native approval flow stays the fallback.
- **Launch Claude Code from the pet** (#409) - A "New Session" entry in the pet's right-click menu launches a fresh Claude Code session in a terminal; resume session ids are validated before use.
- **Qoder integration (state-only)** (#423) - Added state-only Qoder support: Clawd reflects Qoder working / idle / attention state without injecting a separate permission bubble.
- **Keep the system awake while agent tasks run** (#358) - Clawd can block system sleep while an AI task is in progress so long-running work is not interrupted by the machine dozing off, with the wake lock reconciled against live task state.
- **Directional Codex Pet drag animations** (#388) - The Codex Pet theme now supports directional drag animations that respond to which way the pet is being dragged.
- **Mini-mode controls** (#424, #426) - Added a toggle to disable mini-mode auto-snap on screen edges, and a setting to disable mini mode entirely.

### Bug Fixes

- **Codex same-process session ghosts** (#427) - Fixed duplicate / ghost Codex sessions when multiple turns share one process.
- **Stuck local Codex turns** (#422) - Local Codex turns that never received a Stop now fall back to a JSONL `task_complete` signal so sessions do not hang in a working state.
- **Premature completion celebration** (#406, #421) - Stopped the completion celebration from firing mid-task before the work actually finished.
- **Remote completion session timeout** (#414, #418) - Remote completion sessions now respect the session timeout instead of lingering.
- **opencode plugin loading and state flow** (#417, #401, #366) - A single default export so opencode reliably loads the plugin; child sessions are marked headless via `parentID`; and plugin state-flow dedup / sessionID capture were repaired.
- **macOS dock and pet visibility** (#416, #425, #396, #410) - The pet now hides on Dock / ⌘H "Hide", the Dock icon is right-sized and scaled to fill the 1024×1024 canvas without aliasing, and the dock-icon override is guarded against null states.
- **Claude hook shrink guard visibility** (#407) - The Claude hook shrink guard is now visible so the state transition is observable.
- **Mini post-completion notification alert** (#404) - Fixed a missing post-completion alert in mini mode.
- **Stale ExitPlanMode bubble** (#402) - Clears a stale plan-mode bubble and adds a "give feedback on the plan" button.
- **Ghostty same-cwd tab focus** (#355) - Fixed Ghostty tab focusing for sessions that share a working directory.
- **Windows Codex Desktop focus fallback** (#381) - Hardened the focus fallback for Codex Desktop on Windows.
- **Codex working state during silent permission turns** (#385) - Long, silent permission turns no longer flip Codex out of its working state.
- **Updater GitHub API fallback** (#386) - The background update check falls back correctly when the GitHub releases API response is unavailable.
- **Cloudling low-power idle RAF** (#364) - Reduced idle `requestAnimationFrame` churn for the Cloudling theme in low-power conditions.

### Upgrade Notes

- **Telegram remote approval — no action required for existing users.** Your Telegram approval keeps working on legacy (Go sidecar) mode after upgrading. To move to native mode, open Settings → Remote Approval → Telegram and tap **"Test native and switch"**. If the test fails, your legacy configuration stays intact and Clawd does not auto-deny or auto-allow real permission requests during the switch. The Go sidecar remains shipped in v0.9.0; its removal is a later, separately-gated decision.
- **Telegram completion notifications are off by default** and are tied to the approval switch. Switch completion output to **Full answer** from Telegram settings after switching to native mode if you want assistant text sent to Telegram; turning approval off also stops notifications.
- **R3 Direct Send is an opt-in beta, default off, and Windows-first.** Enable it only if you want phone-to-terminal prompt delivery. It pastes a single-line reply without auto-Enter, confirms focus before pasting, restores the previous text clipboard after successful Windows paste where available, and falls back to the clipboard on any ambiguity, on multi-line replies, or on macOS / Linux.
- **The mobile companion is read-only.** It previews sessions over the LAN and cannot approve permissions or send prompts.
- **Telegram bot token storage is unchanged** — the token still lives only in `userData/telegram-approval.env` and is never read from environment variables. Secure OS-keystore storage is planned for a later release.
- Release metadata is bumped to `0.9.0` in both `package.json` and `package-lock.json`.

### Docs & Contributors

- A new `docs/connections/` plan set documents the Telegram native rework end to end: the D-migration path, the native companion architecture, the R3 Direct Send design, and the code-state reviews that corrected it.
- Added five bundled Clawd SVG animation assets (`clawd-coffee-hand`, `clawd-coffee-head-flip`, `clawd-aegyo-shy`, `clawd-dizzy`, `clawd-idle-low-battery`) for future theme wiring; they are not yet bound to the default state map.
- External contributors shipped code across mobile preview, launch-session, Hermes, keep-awake, opencode, theme, and UI fixes, including two first-time contributors (@QingXB, @29206394 / 藤知).

### Contributors

Huge thanks to everyone who shipped code, tests, docs, or release polish for v0.9.0:

- **@rullerzhou-afk** (鹿鹿 · creator) - Telegram native rework end to end (migration state machine + owner manager, native client, rich approval, R1a completion notifications, R3 Direct Send), Codex session / state fixes, opencode attribution and loading fixes, macOS dock behavior, Qoder state-only integration, and release work.
- **@Bynlk** - Read-only mobile PWA companion (LAN preview M1, session cards, event-driven push, smooth expand + live timers, PWA reliability), macOS Dock icon sizing, and the mini-mode edge auto-snap toggle.
- **@QingXB** - Launch a Claude Code session from the pet's right-click menu (#409). *First-time contributor.*
- **@29206394 (藤知)** - Hermes Agent permission bubble + elicitation integration (#387). *First-time contributor.*
- **@zxypro1** (Zone Tome) - Block system sleep while agent tasks are in progress (#358).
- **@NeroAyase** - opencode plugin headless child sessions and state-flow / sessionID fixes (#401, #366).
- **@divergentD** - Directional Codex Pet drag animations (#388).
- **@Ne9roni** - Stale ExitPlanMode bubble fix and the plan-feedback button (#402).

### Known Limitations

- **Telegram native mode is dogfood-validated mainly on Windows.** The migration state machine and Telegram API handling are covered by unit tests and a fake Telegram server, but hands-on approval / migration testing is Windows-first. macOS / Linux rely on CI plus code review.
- **R3 Direct Send paste delivery is Windows-only in v1.** macOS / Linux are fallback-only (clipboard copy) until each has a real, tested paste / Enter primitive. Direct Send only pastes single-line replies, never pastes into a session that is waiting on a permission decision, and never auto-presses Enter.
- **The mobile companion is read-only and LAN-only.** It is a preview surface on the local network; it does not expose approval or prompt-sending, and it is not a remote-over-internet control channel.
- **The Go Telegram sidecar still ships in v0.9.0.** It is kept as the legacy / rollback path; removal is gated on native stability and migration feedback in a later release.
- **macOS / Linux real-machine QA remains best-effort.** CI builds artifacts, but Windows remains the primary hands-on validation environment.
