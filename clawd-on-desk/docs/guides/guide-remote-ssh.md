# Remote SSH Guide

The default entry point for Remote SSH is **Settings → Remote SSH** inside the
Clawd app. The older `scripts/remote-deploy.sh` is now only a fallback for
source checkout / debugging, and is no longer the primary flow for DMG /
installer users.

## Prerequisites

- A local Clawd instance is running
- Your machine can reach the remote host via the system `ssh`
- Node.js is installed on the remote
- At least one supported remote agent is installed on the remote: Claude Code, Codex CLI, or Copilot CLI

Clawd does not store SSH passwords or private-key passphrases. First-time host
key confirmation, passphrase entry, and ssh-agent loading are all handled by
the system `ssh` and your system terminal.

## In-app flow

1. Open **Settings → Remote SSH**.
2. Click **Add profile** and fill in:
   - **Host**: `user@remote-host`, or a Host alias defined in your `~/.ssh/config`
   - **SSH port**: defaults to `22`
   - **Private key file**: optional; leave blank to use ssh-agent or `~/.ssh/config`
   - **Remote forward port**: defaults to `23333`; only change to `23334-23337` when you run multiple profiles against the same remote
   - **Host prefix**: optional, used in Sessions / Dashboard to disambiguate the remote
3. If SSH needs first-time host-key confirmation, a passphrase, or an ssh-agent load, click **Authenticate**. Clawd opens your system terminal to run a plain `ssh` once.
4. Click **One-click deploy**.
   - Clawd opens and maintains the `ssh -R` reverse tunnel
   - Then it copies hook files from the currently installed Clawd to the remote's `~/.claude/hooks/`
   - Then it registers Claude Code hooks, Codex official hooks, and Copilot CLI hooks in remote mode when the matching remote agent is installed
   - Connection / deployment logs are shown directly below the profile
5. Start Claude Code, Codex CLI, or Copilot CLI on the remote. The Dashboard will show the session once the first remote hook event arrives.

For remote-only Copilot CLI tracking on a fresh local install, turn on
**Copilot CLI** in **Settings → Agents** so Clawd accepts those remote hook
events. You do not need to click **Install** unless you also want local Copilot
hooks on this machine.

If the profile has **Auto-start Codex fallback monitor on connect** enabled,
Clawd will SSH in after connect to launch `~/.claude/hooks/codex-remote-monitor.js`.
The fallback is not needed when Codex official hooks are working.

## Key concepts

The `127.0.0.1:<port>` shown in Doctor is normal — it's the Clawd HTTP service
on **your** machine, not an IP on the remote cluster. Remote hooks don't reach
your LAN IP directly either.

The actual chain is:

```
Remote Claude/Codex/Copilot hook
  -> POST http://127.0.0.1:<remote forward port>
  -> SSH reverse tunnel
  -> Local Clawd http://127.0.0.1:<local runtime port>
  -> Dashboard / Session HUD / pet state
```

So "Connected" only means the tunnel is up. For a remote session to actually
appear in the Dashboard, you still need:

- Remote hooks deployed successfully
- The remote agent started, with at least one hook event emitted
- For Codex, the remote Codex TUI has reviewed the hooks via `/hooks` if your version requires it
- For remote-only Copilot CLI on a fresh local install, local **Settings → Agents → Copilot CLI** is turned on

## Doctor vs. remote boundary

Doctor's **Agent integration** check only diagnoses local config — e.g. the
hook path in your local `~/.claude/settings.json`. It does **not** SSH into the
remote to inspect the remote's `~/.claude/settings.json`, `~/.codex/hooks.json`,
or `~/.copilot/hooks/hooks.json`.

So a local `broken path` only means your local Claude hook path is off; it
does not imply the remote SSH deployment failed. Check the **Hook status** and
deployment log inside the Remote SSH profile for the remote-side state.

## Source-checkout fallback

Only when running from a source checkout, you can fall back to:

```bash
bash scripts/remote-deploy.sh user@remote-host
```

This script copies `hooks/` from your current source tree and prints manual SSH
config suggestions. DMG / installer users don't need a source checkout and
should use **Settings → Remote SSH → One-click deploy** instead.

## Troubleshooting

### No remote session shows up in Dashboard

Check the Remote SSH profile first:

- If Hook status is "Never deployed", click **One-click deploy**
- If status is "Connected" but Dashboard is empty, send a message in the remote agent to trigger a hook
- For Codex, the remote Codex may still need `/hooks` review

### Remote port conflict

If the connection fails with a "remote port in use" error, change the profile's
**Remote forward port** from `23333` to one of `23334-23337`, then redeploy.

### Remote has no Node.js

Deployment fails at the `check-node` step. Install Node.js on the remote first,
then redeploy.

### Still want to open the SSH tunnel manually

You can run the equivalent reverse forward yourself:

```bash
ssh -R 127.0.0.1:23333:127.0.0.1:23333 user@remote-host
```

But this only opens the tunnel — it does not deploy hooks. You still need to
finish remote hook deployment via Remote SSH or the source script.
