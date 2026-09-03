"""Parent watchdog: exit when the Electron host that launched us dies.

The engine runs in-process, so there is no child server to reap — but a
`kill -9` on Electron would still leave this process holding :18765 and a
compiled 2.6B model in memory forever. `ParentWatchdog` notices ppid drift
(or a re-parent to init), then signals ourselves SIGTERM so the FastAPI
lifespan can release the pipeline. Cross-platform; ~2s detection window.

Cooperative and failure-tolerant: exceptions are logged and swallowed,
never propagated, so a buggy watchdog can't keep the gateway from booting.
"""

from __future__ import annotations

import os
import platform
import signal
import threading
import time
from typing import Callable, Optional

from .log_setup import get_logger


#: Seconds the graceful path gets before we exit hard. Overridable via
#: MINICPM_FORCE_EXIT_GRACE_S so the force path can actually be exercised.
_DEFAULT_FORCE_EXIT_GRACE_S = 5.0


def _grace_seconds() -> float:
    raw = (os.environ.get("MINICPM_FORCE_EXIT_GRACE_S") or "").strip()
    if raw:
        try:
            return max(0.0, float(raw))
        except ValueError:
            get_logger().warning(
                "ignoring MINICPM_FORCE_EXIT_GRACE_S=%r (not a number)", raw
            )
    return _DEFAULT_FORCE_EXIT_GRACE_S


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

    The Electron host passes its own pid via `MINICPM_PARENT_PID` so the
    watchdog pins the process that actually matters. `os.getppid()` answers
    "who launched this executable", which is not the same question: under a
    PyInstaller onefile build it is the bootloader rather than Electron, and
    even in the onedir build we use, a shell or launcher in between would
    shift it. Pinning removes the guesswork.
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
            # The parent may have died before the watchdog booted; the port
            # and the model still need releasing.
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
        """Signal ourselves so uvicorn / FastAPI lifespan winds down.

          POSIX   SIGTERM is delivered to the handler; uvicorn shuts down
                  gracefully and the lifespan releases the pipeline.
          Windows `os.kill(pid, SIGTERM)` routes through TerminateProcess,
                  so this is already a hard kill and no handler runs.

        Either way a native `generate()` can sit uninterruptible inside the
        OpenVINO runtime, so both need the force-exit fallback.
        """
        # Arm the fallback *first*: the signal call itself may not return.
        threading.Thread(target=_force_exit_after_grace,
                         name="watchdog-force-exit", daemon=True).start()
        try:
            os.kill(os.getpid(), signal.SIGTERM)
        except Exception:
            hard_exit(1)


def _force_exit_after_grace() -> None:
    grace = _grace_seconds()
    time.sleep(grace)
    get_logger().warning(
        "graceful shutdown did not finish in %.1fs; terminating", grace
    )
    hard_exit(1)


def hard_exit(code: int = 1) -> None:
    """Leave the process without running DLL_PROCESS_DETACH.

    `os._exit()` routes through `ExitProcess`, which detaches every loaded
    module on the way out. That deadlocks against the OpenVINO GPU plugin's
    TBB pool — measured on Windows: uvicorn stopped, :18765 released, and the
    process then sat at 45 threads holding ~2 GB forever. TerminateProcess
    skips detach entirely.
    """
    if platform.system() == "Windows":
        try:
            import ctypes

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.TerminateProcess(kernel32.GetCurrentProcess(), int(code))
        except Exception:
            pass
    os._exit(code)


def _pid_alive(pid: int) -> bool:
    """Return True iff `pid` is currently a live process we can probe.

    On Unix we use `kill(pid, 0)` which only checks for the existence of
    the pid (no signal delivered). EPERM means the pid exists but we
    don't own it — still alive for our purposes.

    On Windows, `os.kill(pid, 0)` is not a safe existence probe: CPython's
    Windows implementation routes non-console-control signals through
    TerminateProcess. Use WinAPI query calls there instead.
    """
    if pid <= 0:
        return False
    if platform.system() == "Windows":
        return _pid_alive_windows(pid)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False


def _pid_alive_windows(pid: int) -> bool:
    """Windows-only process existence probe that never signals the target."""

    try:
        import ctypes
        from ctypes import wintypes
    except Exception:
        return False

    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    ERROR_ACCESS_DENIED = 5
    STILL_ACTIVE = 259

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel32.GetExitCodeProcess.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL

    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
    if not handle:
        # Access denied still proves the process exists; invalid parameter /
        # not found means it does not.
        return ctypes.get_last_error() == ERROR_ACCESS_DENIED

    try:
        code = wintypes.DWORD()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
            return False
        return code.value == STILL_ACTIVE
    finally:
        kernel32.CloseHandle(handle)
