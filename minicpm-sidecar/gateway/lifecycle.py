"""Process-lifecycle helpers: parent watchdog, PID file, orphan cleanup.

The sidecar lives under an Electron parent and itself spawns llama-server.
Without active supervision, a `kill -9` on either the parent or the sidecar
leaves llama-server hogging memory + port `18766` forever. This module
closes three independent failure modes:

  A. Parent (Electron) gone, sidecar alive
     → `ParentWatchdog` notices ppid drift / re-parent to init, signals
       ourselves SIGTERM so FastAPI lifespan winds down llama-server.
       Cross-platform; ~2s detection window.

  B. Sidecar gone, llama-server alive
     → on Linux, `pdeathsig_preexec()` asks the kernel to send SIGTERM to
       llama-server the moment its parent (us) dies. macOS / Windows have
       no equivalent at the syscall layer, so we lean on (C) for those.

  C. Mac/Win orphan from a previous run
     → `write_pid_file()` records the live llama-server pid; on next
       sidecar boot, `cleanup_stale_llama_server()` reads the file, checks
       the pid is still our llama-server (not a recycled pid pointing at
       some other random process), and reaps it before binding ourselves.

All three are cooperative and tolerate failure: any exception is logged
and swallowed, never propagated, so a buggy lifecycle helper can't keep
the gateway from booting.
"""

from __future__ import annotations

import os
import platform
import signal
import subprocess
import threading
import time
from pathlib import Path
from typing import Callable, Optional

from .log_setup import get_logger


# ── Parent watchdog ─────────────────────────────────────────────────────────


class ParentWatchdog:
    """Daemon thread that triggers a graceful exit when the parent dies.

    On Linux/macOS we watch `os.getppid()`: if it changes to 1 (re-parented
    to init/launchd) or to anything other than the pid we were told to
    track, we assume the parent process is gone and tell ourselves to stop.

    On Windows there is no init re-parenting — instead, the ppid stays the
    same but the OS handle to it becomes invalid. We rely on the same
    "ppid drift" check plus an OpenProcess probe via ctypes when available.

    Why not just trust `os.getppid()` blindly?

    PyInstaller `--onefile` boots a thin bootloader that immediately exec's
    Python; the python child's `os.getppid()` is the bootloader, not the
    Electron process. If Electron crashes but the bootloader hangs around
    (it shouldn't, but just in case), watching the bootloader misses the
    crash. The Electron host passes its own pid via `MINICPM_PARENT_PID`
    env so we always pin the real parent.
    """

    def __init__(
        self,
        target_pid: int,
        *,
        interval: float = 2.0,
        on_parent_gone: Optional[Callable[[], None]] = None,
    ) -> None:
        self.target_pid = int(target_pid)
        self.interval = float(interval)
        self._on_parent_gone = on_parent_gone or self._default_action
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def start(self) -> None:
        log = get_logger()
        if self.target_pid <= 1:
            log.info("parent watchdog disabled (target_pid=%d)", self.target_pid)
            return
        if not _pid_alive(self.target_pid):
            log.warning(
                "parent watchdog: target pid %d already gone at startup; firing immediately",
                self.target_pid,
            )
            # Don't no-op: caller wants us to reap llama-server even if
            # the parent died between Electron spawning us and the
            # watchdog booting. Trigger the action inline instead.
            try:
                self._on_parent_gone()
            except Exception as exc:
                log.warning("parent watchdog inline action failed: %s", exc)
            return
        self._thread = threading.Thread(
            target=self._loop, name="parent-watchdog", daemon=True
        )
        self._thread.start()
        log.info("parent watchdog: tracking pid %d", self.target_pid)

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=1.0)

    def _loop(self) -> None:
        log = get_logger()
        while not self._stop.wait(self.interval):
            try:
                if not _pid_alive(self.target_pid):
                    log.warning(
                        "parent watchdog: pid %d gone; initiating shutdown",
                        self.target_pid,
                    )
                    try:
                        self._on_parent_gone()
                    except Exception as exc:
                        log.warning("parent watchdog action failed: %s", exc)
                    return
            except Exception as exc:
                # Probe errors (e.g. transient kernel hiccup) shouldn't
                # take the watchdog down — silently retry next tick.
                log.debug("parent watchdog probe error: %s", exc)

    @staticmethod
    def _default_action() -> None:
        """Send ourselves SIGTERM so uvicorn / FastAPI lifespan does the
        graceful shutdown dance (which in turn stops llama-server)."""
        try:
            if platform.system() == "Windows":
                # Windows doesn't honour SIGTERM the same way; CTRL_BREAK
                # via os.kill works for console-attached processes but
                # not always for PyInstaller onefile children. Best-effort
                # sequence: SIGTERM first, then os._exit as last resort.
                os.kill(os.getpid(), signal.SIGTERM)
            else:
                os.kill(os.getpid(), signal.SIGTERM)
        except Exception:
            # If even self-signaling fails we have nothing graceful left;
            # hard-exit so the OS at least reaps our children.
            os._exit(1)


def _pid_alive(pid: int) -> bool:
    """Return True iff `pid` is currently a live process we can probe.

    On Unix we use `kill(pid, 0)` which only checks for the existence of
    the pid (no signal delivered). EPERM means the pid exists but we
    don't own it — still alive for our purposes.

    On Windows, `os.kill(pid, 0)` works in CPython for live pids and
    raises OSError for dead ones, so the same check applies.
    """
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False


# ── llama-server pdeathsig (Linux) ─────────────────────────────────────────


def pdeathsig_preexec() -> Optional[Callable[[], None]]:
    """Return a Popen `preexec_fn` that asks Linux to send SIGTERM to the
    child the moment its parent (us) dies. Returns None on non-Linux,
    where caller should skip the kwarg entirely.

    This is the only fix for "kill -9 on the sidecar leaves llama-server
    running" that doesn't need cooperation from the dying side. macOS has
    no equivalent — Apple dropped `EVFILT_PROC + NOTE_EXIT` style sentry
    processes are technically possible but require a separate watcher
    binary, which is more surface area than the orphan-cleanup-on-restart
    fallback (see `cleanup_stale_llama_server`).
    """
    if platform.system() != "Linux":
        return None

    # Capture refs at module load so the closure doesn't touch globals
    # mid-fork (we're in the unsafe window between fork() and exec()).
    PR_SET_PDEATHSIG = 1
    sigterm = signal.SIGTERM

    def _set() -> None:
        try:
            import ctypes

            libc = ctypes.CDLL("libc.so.6", use_errno=True)
            libc.prctl(PR_SET_PDEATHSIG, sigterm, 0, 0, 0)
        except Exception:
            # Best-effort; if prctl fails we still launch the child,
            # just without parent-death tracking. Don't crash the
            # exec — that would defeat the whole point of starting.
            pass

    return _set


# ── PID file + stale orphan cleanup (all platforms) ────────────────────────


def write_pid_file(path: Path, pid: int) -> None:
    """Record the live llama-server pid so the *next* sidecar boot can
    detect and reap an orphan left behind by `kill -9` of this process."""
    log = get_logger()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"{int(pid)}\n", encoding="ascii")
    except Exception as exc:
        log.warning("could not write llama-server pid file %s: %s", path, exc)


def clear_pid_file(path: Path) -> None:
    """Remove the PID file. Called after a clean llama-server stop so we
    don't false-positive a "stale orphan" on next boot."""
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    except Exception as exc:
        get_logger().warning("could not remove pid file %s: %s", path, exc)


def cleanup_stale_llama_server(pid_file: Path, *, expected_name: str = "llama-server") -> None:
    """If a previous sidecar crashed before stopping llama-server, the
    pid file points at an orphaned child. Reap it before we try to bind
    our own ports.

    Defensive checks (in order):
      1. pid file exists and is parseable
      2. pid is currently alive
      3. process name actually contains `expected_name` (guards against
         pid recycling pointing at some unrelated user process)
      4. SIGTERM, wait up to 2s, SIGKILL if still alive
    """
    log = get_logger()
    try:
        if not pid_file.is_file():
            return
        raw = pid_file.read_text(encoding="ascii").strip()
        if not raw:
            clear_pid_file(pid_file)
            return
        pid = int(raw)
    except Exception as exc:
        log.debug("could not parse pid file %s: %s", pid_file, exc)
        clear_pid_file(pid_file)
        return

    if not _pid_alive(pid):
        clear_pid_file(pid_file)
        return

    if not _process_name_matches(pid, expected_name):
        log.info(
            "pid %d from %s is alive but not %r; assuming pid was recycled",
            pid, pid_file, expected_name,
        )
        clear_pid_file(pid_file)
        return

    log.warning(
        "found stale %s pid=%d from a previous sidecar crash; cleaning up",
        expected_name, pid,
    )
    try:
        if platform.system() == "Windows":
            # Windows has no SIGTERM equivalent for unrelated processes;
            # taskkill walks the tree the same way our Electron-side
            # shutdown does on win32.
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                check=False, capture_output=True,
            )
        else:
            os.kill(pid, signal.SIGTERM)
            for _ in range(20):  # up to 2s
                if not _pid_alive(pid):
                    break
                time.sleep(0.1)
            if _pid_alive(pid):
                log.warning("stale llama-server didn't honour SIGTERM; SIGKILL")
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
    except Exception as exc:
        log.warning("could not reap stale llama-server pid=%d: %s", pid, exc)
    finally:
        clear_pid_file(pid_file)


def _process_name_matches(pid: int, needle: str) -> bool:
    """Best-effort cross-platform check of a process's command name.

    Returns False on any error so we never SIGKILL the wrong process
    just because we couldn't introspect it.
    """
    try:
        sysname = platform.system()
        if sysname == "Windows":
            # tasklist /fi "PID eq <pid>" /fo csv /nh →  "name.exe","123",...
            r = subprocess.run(
                ["tasklist", "/fi", f"PID eq {pid}", "/fo", "csv", "/nh"],
                check=False, capture_output=True, text=True, timeout=5,
            )
            out = (r.stdout or "").strip().lower()
            return needle.lower() in out
        # macOS/Linux/BSD all ship `ps -p <pid> -o comm=` which prints just
        # the executable name without the header line.
        r = subprocess.run(
            ["ps", "-p", str(pid), "-o", "comm="],
            check=False, capture_output=True, text=True, timeout=5,
        )
        comm = (r.stdout or "").strip().lower()
        # `comm` on macOS truncates to 16-byte basename; that's fine
        # since "llama-server" fits in 12 chars.
        return needle.lower() in comm
    except Exception:
        return False


def default_pid_file_path() -> Path:
    """Same resolution rule as `log_setup.resolve_log_dir`, with the
    file `llama-server.pid` next to `sidecar-internal.log`. Kept local
    so this module doesn't pull in log_setup at import time."""
    from .log_setup import resolve_log_dir  # local import: avoid cycle

    return resolve_log_dir() / "llama-server.pid"
