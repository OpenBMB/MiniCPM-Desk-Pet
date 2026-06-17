# Release Process

Use this flow when preparing a Clawd app release.

## Before Tagging

1. Update `package.json` to the release version.
2. Add `docs/releases/release-vX.Y.Z.md`.
3. Run the local tests that match the change scope. For full release prep, run:

```bash
npm test
node scripts/verify-sidecar-binaries.js prebuild:all
```

4. Run the `Build & Release` workflow manually on `main`.

Manual workflow dispatch builds Windows, macOS, and Linux artifacts, fetches the
pinned `cc-connect-clawd` sidecar release, verifies source-pinned checksums, and
uploads build artifacts. It does not publish a GitHub Release.

## Draft Release

After the manual build artifacts look good, create and push the final version
tag:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

Pushing a `v*` tag runs the same build workflow again and creates a draft GitHub
Release with the generated installers and release notes. Draft releases are not
visible to normal users and are not consumed by the updater.

Download and smoke-test the draft release assets before publishing the draft.
If the draft is wrong, fix the issue before publishing; do not publish a known
bad draft release.

### v0.10.0 Draft Smoke Checklist

Use the draft release installer or package artifact, not `npm start`. Windows
required items are the primary publish gate. If macOS or Linux hardware is not
available, record that platform as not real-machine validated in the release
notes.

Before launching:

- Download the draft release asset for the platform being tested.
- Confirm the packaged app shows `0.10.0` metadata.
- Confirm packaged resources include `app.asar.unpacked/hooks`,
  `app.asar.unpacked/agents`, `app.asar.unpacked/extensions`,
  `app.asar.unpacked/themes`, and `sidecars/cc-connect-clawd`.
- For Reasonix smoke, prepare a machine with Reasonix initialized so
  `~/.reasonix/` exists. A skipped install because Reasonix is missing does not
  validate the packaged hook path.
- For CodeWhale smoke, prepare a machine with CodeWhale initialized so its
  config path exists. A skipped install because CodeWhale is missing does not
  validate the packaged hook path.
- For migration smoke, install v0.9.x first and save a copy of the old
  `clawd-prefs.json` before upgrading.

Required all-platform checks:

- Fresh install, launch, pet appears, no error dialog.
- Upgrade install over v0.9.x, launch, pet appears, no error dialog. This path
  exercises prefs v10 to v11 migration.
- Settings -> About shows `v0.10.0`, sourced from `app.getVersion()`.
- Settings -> Agents -> Install Reasonix succeeds and writes hooks without
  `MODULE_NOT_FOUND`.
- Settings -> Agents -> Install CodeWhale succeeds and writes hooks without
  `MODULE_NOT_FOUND`.
- Reinstall one existing hook-based agent, such as Codex, and confirm the
  packaged hook script can `require()` its dependencies.
- Run one real Claude Code or Codex session and confirm the pet reacts to state
  changes.
- Upgraded users keep every agent that was enabled in v0.9.x enabled and
  working after v0.10.0 upgrade.
- Fresh users show only Claude Code and Codex as Installed; the other 15
  supported agents show Not installed.
- Enable auto-pilot, trigger a real permission request, and confirm the request
  is automatically approved.
- Try to enable auto-pilot without confirming the danger dialog and confirm it
  stays off.
- Restart Clawd and confirm auto-pilot is off again.

Recommended all-platform checks:

- Settings -> About contributors include all seven first-time contributors:
  `Tsdsj`, `godlockin`, `sLingli`, `ustin-star`, `cod3hulk`, `lxgxhsy`, and
  `rebootcrab-blip`.
- Uninstall one agent from Settings -> Agents, confirm the dialog appears, only
  Clawd-managed entries are removed, and user-owned hooks remain untouched.
- Cold launch is faster than v0.9.x on the same machine because Clawd no longer
  syncs every supported integration on startup.
- Text size slider scales permission bubbles, Session HUD, Dashboard, and
  Settings without clipping or overflow.
- On multi-display setups, text size is remembered per display and does not leak
  between monitors when windows move.
- Right-click Hide pet / Show pet works.
- While the pet is hidden, a newly arriving permission request still shows a
  bubble. Existing permission hotkeys may be unregistered while hidden; that is
  expected.
- Settings -> About -> Check for updates completes without an error.
- Update labels never show a duplicated prefix such as `vv0.10.0`.
- Scan the mobile PWA pairing URL on a phone and confirm session cards appear.
- Regenerate or reset the mobile token and confirm the phone can reconnect with
  the new token.

Windows checks:

- Required: drag a folder onto the pet and confirm a terminal opens in that
  directory.
- Required: right-click New Session starts Claude Code without `0x800700c1`.
- Recommended: focus jump targets the correct terminal.
- Recommended: after restart, the pet restores its saved position.

macOS checks:

- Required when macOS hardware is available: answer a permission with
  Ctrl+Shift+Y or Ctrl+Shift+N and confirm focus is not stolen back to the agent
  terminal.
- Recommended: jumping back to a session restores a minimized terminal window.
- Recommended: dragging a folder onto the pet does not open a terminal and does
  not crash. This is intentionally disabled on macOS.

Linux checks:

- Required when Linux hardware is available: Wayland session launches
  successfully and relaunches under XWayland when available; pet transparency
  and positioning work.
- Recommended for tmux users: focus jumps to the correct tmux pane.

All required Windows items must pass before publishing the draft. Required macOS
and Linux items must pass when those machines are available. If any required
item fails, fix it and create a new draft release; do not publish a known-bad
draft.

## Sidecar Dependency

Clawd release builds do not consume upstream `cc-connect` latest artifacts. They
download the fixed `cc-connect-clawd` fork release pinned by
`scripts/fetch-sidecar-binaries.js`, verify SHA256 values pinned in that script,
and package those binaries into app resources.

When the sidecar needs an upstream update, publish a new fixed sidecar release
from the fork first, then update the Clawd pin and rerun the fetch/verify tests.
