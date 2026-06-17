#!/usr/bin/env bash
# ci/wayland-smoke.sh — headless-Wayland smoke test for the XWayland
# auto-relaunch (issue #441 / PR #443).
#
# Proves, on a real Wayland compositor with the shipped AppImage:
#   A. Manual `--ozone-platform=x11` (the reporter's known-good workaround)
#      boots, serves /state, puts a window on the X server, and does NOT
#      trigger the auto-relaunch (argv guard).
#   B. A plain, no-argument launch on a Wayland session relaunches itself
#      onto XWayland: relaunch logged exactly once, throwaway first process
#      exits 0, the relaunched browser process carries --ozone-platform=x11
#      on its REAL cmdline, /state answers, the window exists on the X
#      server, and the process set is stable (no relaunch loop).
#   C. Negative control: CLAWD_OZONE_PLATFORM=wayland boots natively with NO
#      relaunch and stays alive (the escape hatch works).
#
# What it can NOT prove: behavior on the reporter's exact Fedora/KDE box
# (KWin vs weston, their session env). That residual still needs a field test.
#
# Child-side assertions go through /proc, X, and HTTP rather than logs, so
# they hold for any relaunch mechanism (v3's app.relaunch silenced the child
# entirely; v4's spawn inherits stdio — asserted separately). Two extra eyes
# for debugging: ELECTRON_ENABLE_LOGGING=file (env is inherited, so even a
# silenced child writes Chromium logs to ELECTRON_LOG_FILE) and a /proc
# sampler that records every Clawd/relauncher process's appearance and
# disappearance.

set -u

APPIMAGE_ARG="${1:?usage: wayland-smoke.sh <path-to-AppImage>}"
APPIMAGE="$(readlink -f "$APPIMAGE_ARG")"
STATE_URL="http://127.0.0.1:23333/state"
RELAUNCH_MARK="relaunching under XWayland"
PASS=0

note() { printf '\n== %s ==\n' "$*"; }
ok() { PASS=$((PASS + 1)); printf 'PASS %s: %s\n' "$PASS" "$*"; }

proc_timeline() {
  # procwatch.raw: "<time> <pid> <cmd...>" — collapse to one line per pid with
  # first/last sighting so short-lived processes and their lifespan are visible.
  awk '{
    key = $2
    if (!(key in first)) { first[key] = $1; cmd[key] = substr($0, index($0, $3)) }
    last[key] = $1
  } END {
    for (k in first) printf "pid %-7s %s -> %s  %.160s\n", k, first[k], last[k], cmd[k]
  }' procwatch.raw 2>/dev/null | sort -k3
}

dump_diagnostics() {
  note "diagnostics: process timeline (first seen -> last seen)"
  proc_timeline || true
  note "diagnostics: manual-x11 log (manual.log)"
  cat manual.log 2>/dev/null || true
  note "diagnostics: first-process log (first.log)"
  cat first.log 2>/dev/null || true
  note "diagnostics: negative-control log (negative.log)"
  cat negative.log 2>/dev/null || true
  note "diagnostics: chromium log of the most recent process (electron-child.log)"
  tail -n 80 electron-child.log 2>/dev/null || true
  note "diagnostics: weston log (tail)"
  tail -n 30 weston.log 2>/dev/null || true
  note "diagnostics: live processes"
  ps ax -o pid,ppid,stat,etime,args | grep -iE 'clawd|\.mount_|relauncher' | grep -v grep || true
  note "diagnostics: port 23333"
  ss -tlnp 2>/dev/null | grep 23333 || echo "(nothing listening)"
  note "diagnostics: X clients on ${XDISPLAY:-unset}"
  [ -n "${XDISPLAY:-}" ] && xlsclients -display "$XDISPLAY" -l 2>/dev/null | head -30 || true
}

fail() {
  printf '\nFAIL: %s\n' "$*"
  dump_diagnostics
  exit 1
}

# poll <seconds> <cmd...> — retry cmd (silenced) every 0.5s until the deadline
poll() {
  local deadline=$(($(date +%s) + $1))
  shift
  while true; do
    "$@" >/dev/null 2>&1 && return 0
    [ "$(date +%s)" -ge "$deadline" ] && return 1
    sleep 0.5
  done
}

# Electron BROWSER processes of our AppImage: cmdline runs through the squashfs
# mountpoint (/tmp/.mount_Clawd*) and has no Chromium --type= child marker.
# Pass "x11" to keep only those carrying --ozone-platform=x11.
browser_pids() {
  local want_flag="${1:-}" d pid cmd
  for d in /proc/[0-9]*; do
    pid="${d#/proc/}"
    cmd="$(tr '\0' ' ' <"$d/cmdline" 2>/dev/null)" || continue
    case "$cmd" in *".mount_Clawd"*) ;; *) continue ;; esac
    case "$cmd" in *"--type="*) continue ;; esac
    if [ "$want_flag" = "x11" ]; then
      case "$cmd" in *"--ozone-platform=x11"*) echo "$pid" ;; esac
    else
      echo "$pid"
    fi
  done
}

has_x11_browser() { [ -n "$(browser_pids x11)" ]; }
no_x11_browser() { [ -z "$(browser_pids x11)" ]; }
state_ok() { curl -fsS --max-time 2 "$STATE_URL" >/dev/null; }
state_gone() { ! curl -fsS --max-time 1 "$STATE_URL" >/dev/null 2>&1; }
x_has_clawd() {
  xlsclients -display "$XDISPLAY" -l 2>/dev/null | grep -qi clawd ||
    xwininfo -root -tree -display "$XDISPLAY" 2>/dev/null | grep -qi clawd
}

kill_app() {
  local p
  for p in $(browser_pids); do kill "$p" 2>/dev/null || true; done
  sleep 1
  for p in $(browser_pids); do kill -9 "$p" 2>/dev/null || true; done
  pkill -9 -f '\.mount_Clawd' 2>/dev/null || true
  poll 15 state_gone || fail "port 23333 still occupied after teardown"
}

chmod +x "$APPIMAGE"

# ── headless Wayland compositor + Xwayland ──────────────────────────────────
note "starting weston (headless) + Xwayland"
XDG_RUNTIME_DIR="$(mktemp -d /tmp/xdg-runtime.XXXXXX)"
export XDG_RUNTIME_DIR
chmod 700 "$XDG_RUNTIME_DIR"
weston --backend=headless --xwayland --socket=wayland-smoke \
  --width=1280 --height=800 --idle-time=0 >weston.log 2>&1 &
WESTON_PID=$!
poll 15 test -e "$XDG_RUNTIME_DIR/wayland-smoke" ||
  fail "weston wayland socket never appeared"

# weston spawns Xwayland lazily but logs which display it listens on; fall back
# to probing :0..:5 (a probe connection also forces the lazy spawn).
XDISPLAY="$(grep -oE 'display :[0-9]+' weston.log | head -1 | grep -oE ':[0-9]+' || true)"
if [ -z "${XDISPLAY:-}" ]; then
  for n in 0 1 2 3 4 5 0 1 2 3 4 5; do
    if env DISPLAY=":$n" timeout 5 xdpyinfo >/dev/null 2>&1; then
      XDISPLAY=":$n"
      break
    fi
  done
fi
[ -n "${XDISPLAY:-}" ] || fail "could not find the Xwayland display"
poll 15 env DISPLAY="$XDISPLAY" xdpyinfo || fail "Xwayland on $XDISPLAY not answering"
echo "weston up (pid $WESTON_PID), Xwayland on $XDISPLAY"

# The reporter's broken scenario: a Wayland session with XWayland available.
export WAYLAND_DISPLAY=wayland-smoke
export XDG_SESSION_TYPE=wayland
export DISPLAY="$XDISPLAY"
export LIBGL_ALWAYS_SOFTWARE=1 # headless runner: keep GL in software

# Inherited by every process, including the relauncher's silenced child —
# Chromium-level errors land in this file even when stdio is /dev/null.
export ELECTRON_ENABLE_LOGGING=file
export ELECTRON_LOG_FILE="$PWD/electron-child.log"

# 10 Hz process sampler: catches even short-lived Clawd/relauncher processes.
(
  while :; do
    t="$(date +%H:%M:%S.%2N)"
    for d in /proc/[0-9]*; do
      cmd="$(tr '\0' ' ' <"$d/cmdline" 2>/dev/null)" || continue
      case "$cmd" in
      *[Cc]lawd* | *relauncher*) printf '%s %s %s\n' "$t" "${d#/proc/}" "$cmd" ;;
      esac
    done
    sleep 0.1
  done
) >procwatch.raw 2>/dev/null &
PROCWATCH_PID=$!

# ── phase A: manual --ozone-platform=x11 (reporter's known-good workaround) ──
note "phase A: manual --ozone-platform=x11"
"$APPIMAGE" --ozone-platform=x11 >manual.log 2>&1 &
MANUAL_PID=$!

poll 90 state_ok || fail "manual x11: state server $STATE_URL never answered"
kill -0 "$MANUAL_PID" 2>/dev/null || fail "manual x11: process died"
poll 60 x_has_clawd || fail "manual x11: no Clawd client/window on the X server"
if grep -q "$RELAUNCH_MARK" manual.log; then
  fail "manual x11 triggered the auto-relaunch (argv guard broken)"
fi
ok "manual --ozone-platform=x11 boots, healthy, window on X, no relaunch"

note "phase A done — tearing down"
kill_app

# ── phase B: plain launch must relaunch onto XWayland ───────────────────────
note "phase B: launching AppImage with NO arguments (reporter's scenario)"
"$APPIMAGE" >first.log 2>&1 &
LAUNCH_PID=$!

poll 30 grep -q "$RELAUNCH_MARK" first.log ||
  fail "first process never logged the XWayland relaunch line"
ok "first process planned + logged the relaunch"

poll 30 sh -c "! kill -0 $LAUNCH_PID 2>/dev/null" ||
  fail "throwaway first process still alive after 30s"
wait "$LAUNCH_PID"
FIRST_RC=$?
[ "$FIRST_RC" -eq 0 ] || fail "first process exited rc=$FIRST_RC (expected 0)"
ok "throwaway first process exited 0"

poll 45 has_x11_browser ||
  fail "no relaunched browser process with --ozone-platform=x11 on its cmdline"
X11_PIDS="$(browser_pids x11 | sort | tr '\n' ' ')"
ok "relaunched browser process up with --ozone-platform=x11 (pid(s): $X11_PIDS)"

poll 90 state_ok || fail "state server $STATE_URL never answered after relaunch"
ok "GET /state answers — relaunched app is healthy"

# v4 spawns with stdio "inherit", so unlike app.relaunch (which piped the
# child to /dev/null) the replacement's logs must reach the original terminal.
poll 30 grep -q "state server listening" first.log ||
  fail "child logs missing from the launching terminal (stdio inherit broken?)"
ok "child logs flow back to the launching terminal (stdio inherit)"

poll 60 x_has_clawd ||
  fail "no Clawd client/window on the X server — not running as an XWayland client?"
ok "app window present on the X server => really an XWayland client"

sleep 5
X11_PIDS_LATER="$(browser_pids x11 | sort | tr '\n' ' ')"
[ "$X11_PIDS" = "$X11_PIDS_LATER" ] ||
  fail "browser pid set changed ('$X11_PIDS' -> '$X11_PIDS_LATER') — relaunch loop?"
RELAUNCH_LINES="$(grep -c "$RELAUNCH_MARK" first.log)"
[ "$RELAUNCH_LINES" -eq 1 ] ||
  fail "expected exactly 1 relaunch log line, got $RELAUNCH_LINES"
ok "stable: exactly one relaunch, pid set unchanged after 5s"

note "phase B done — tearing down"
kill_app

# ── phase C: explicit native Wayland must NOT relaunch ──────────────────────
note "phase C: launching with CLAWD_OZONE_PLATFORM=wayland (escape hatch)"
CLAWD_OZONE_PLATFORM=wayland "$APPIMAGE" >negative.log 2>&1 &
NEG_PID=$!

poll 90 state_ok || fail "negative control: state server never answered under native Wayland"
kill -0 "$NEG_PID" 2>/dev/null || fail "negative control: process died"
if grep -q "$RELAUNCH_MARK" negative.log; then
  fail "negative control relaunched despite CLAWD_OZONE_PLATFORM=wayland"
fi
no_x11_browser || fail "negative control: found a browser process with --ozone-platform=x11"
ok "escape hatch works: native Wayland boot, no relaunch, app healthy"

kill_app
kill "$PROCWATCH_PID" 2>/dev/null || true
kill "$WESTON_PID" 2>/dev/null || true

note "ALL $PASS CHECKS PASSED"
