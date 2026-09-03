"""Tests for gateway/lifecycle.py — the parent watchdog.

The engine runs in-process, so there is no child server to supervise;
what remains is noticing that the Electron host died. Short-lived
`sleep` / `python -c` children stand in for that parent.
"""

from __future__ import annotations

import os
import subprocess
import sys
import threading
import time

import pytest

import gateway.lifecycle as lifecycle
from gateway.lifecycle import ParentWatchdog, _grace_seconds, _pid_alive, hard_exit


# ── _pid_alive ───────────────────────────────────────────────────────────


def test_pid_alive_for_self() -> None:
    assert _pid_alive(os.getpid()) is True


def test_pid_alive_rejects_clearly_dead() -> None:
    # PID 0 is reserved; PID -1 is invalid. Both should return False
    # without raising.
    assert _pid_alive(0) is False
    assert _pid_alive(-1) is False


def test_pid_alive_after_child_exits() -> None:
    proc = subprocess.Popen([sys.executable, "-c", "pass"])
    proc.wait()
    # Give the OS a beat to reap the zombie.
    time.sleep(0.05)
    assert _pid_alive(proc.pid) is False


def test_pid_alive_windows_does_not_call_os_kill(monkeypatch: pytest.MonkeyPatch) -> None:
    """Regression: on Windows, os.kill(pid, 0) can terminate the target."""

    seen: dict[str, int] = {}

    def fake_windows_probe(pid: int) -> bool:
        seen["pid"] = pid
        return True

    def fail_os_kill(_pid: int, _sig: int) -> None:
        raise AssertionError("Windows process probes must not use os.kill")

    monkeypatch.setattr(lifecycle.platform, "system", lambda: "Windows")
    monkeypatch.setattr(lifecycle, "_pid_alive_windows", fake_windows_probe)
    monkeypatch.setattr(lifecycle.os, "kill", fail_os_kill)

    assert lifecycle._pid_alive(12345) is True
    assert seen == {"pid": 12345}


# ── ParentWatchdog ───────────────────────────────────────────────────────


def test_watchdog_fires_when_target_pid_dies() -> None:
    """Spawn a short-lived child, point watchdog at it, verify the
    on_parent_gone callback runs within ~2 watchdog ticks of the child
    exiting."""
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(0.3)"])
    fired = threading.Event()

    wd = ParentWatchdog(
        child.pid,
        interval=0.1,
        on_parent_gone=lambda: fired.set(),
    )
    wd.start()
    try:
        child.wait()
        # Watchdog ticks every 100ms; should notice within a few ticks.
        assert fired.wait(timeout=2.0), "watchdog never fired after parent died"
    finally:
        wd.stop()


def test_watchdog_does_not_fire_while_target_alive() -> None:
    """If the target stays alive, the callback should never run within
    the test window."""
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(5)"])
    fired = threading.Event()

    wd = ParentWatchdog(
        child.pid,
        interval=0.1,
        on_parent_gone=lambda: fired.set(),
    )
    wd.start()
    try:
        time.sleep(0.5)  # five ticks; should be quiet
        assert not fired.is_set()
    finally:
        wd.stop()
        child.terminate()
        child.wait(timeout=2)


def test_watchdog_fires_inline_when_target_already_dead() -> None:
    """If the parent died between Electron spawning us and the watchdog
    starting, the watchdog should still trigger cleanup synchronously."""
    child = subprocess.Popen([sys.executable, "-c", "pass"])
    child.wait()
    time.sleep(0.05)

    fired = threading.Event()
    wd = ParentWatchdog(
        child.pid,
        interval=10.0,  # long enough that we know the .start() path fired it
        on_parent_gone=lambda: fired.set(),
    )
    wd.start()
    try:
        # Inline call from .start(), not the background loop.
        assert fired.is_set()
    finally:
        wd.stop()


def test_watchdog_disabled_for_pid_le_1() -> None:
    """ppid=1 (and 0) means we have no real parent (e.g. running under
    init or a test harness). The watchdog should no-op silently."""
    fired = threading.Event()
    for pid in (0, 1, -3):
        wd = ParentWatchdog(pid, interval=0.05, on_parent_gone=lambda: fired.set())
        wd.start()
        wd.stop()
    assert not fired.is_set()


# ── hard_exit ────────────────────────────────────────────────────────────


def test_hard_exit_uses_terminate_process_on_windows(monkeypatch):
    """`os._exit` is not enough here.

    It routes through ExitProcess, which runs DLL_PROCESS_DETACH. With the
    OpenVINO GPU plugin loaded that deadlocks: a sidecar that had served one
    generation released its port and then sat at 45 threads holding ~2 GB
    forever. TerminateProcess skips detach, and an external one killed that
    exact ghost instantly.
    """
    calls = []
    monkeypatch.setattr(lifecycle.platform, "system", lambda: "Windows")

    class _FakeKernel32:
        @staticmethod
        def GetCurrentProcess():
            return 0xDEAD

        @staticmethod
        def TerminateProcess(handle, code):
            calls.append((handle, code))
            raise SystemExit(code)   # stand in for the process going away

    import ctypes
    monkeypatch.setattr(ctypes, "WinDLL", lambda *a, **k: _FakeKernel32, raising=False)
    monkeypatch.setattr(lifecycle.os, "_exit", lambda code: calls.append(("os._exit", code)))

    with pytest.raises(SystemExit):
        hard_exit(3)

    assert calls == [(0xDEAD, 3)]


def test_hard_exit_falls_back_to_os_exit_off_windows(monkeypatch):
    calls = []
    monkeypatch.setattr(lifecycle.platform, "system", lambda: "Linux")
    monkeypatch.setattr(lifecycle.os, "_exit", lambda code: calls.append(code))
    hard_exit(7)
    assert calls == [7]


# ── force-exit grace ─────────────────────────────────────────────────────


def test_grace_defaults_when_unset(monkeypatch):
    monkeypatch.delenv("MINICPM_FORCE_EXIT_GRACE_S", raising=False)
    assert _grace_seconds() == lifecycle._DEFAULT_FORCE_EXIT_GRACE_S


def test_grace_is_overridable(monkeypatch):
    """The force path only runs when something already went wrong, so it
    needs to be reachable on demand — otherwise it ships untested."""
    monkeypatch.setenv("MINICPM_FORCE_EXIT_GRACE_S", "0.25")
    assert _grace_seconds() == 0.25


@pytest.mark.parametrize("raw", ["", "   ", "abc", "None"])
def test_grace_falls_back_on_junk(monkeypatch, raw):
    monkeypatch.setenv("MINICPM_FORCE_EXIT_GRACE_S", raw)
    assert _grace_seconds() == lifecycle._DEFAULT_FORCE_EXIT_GRACE_S


def test_grace_never_negative(monkeypatch):
    monkeypatch.setenv("MINICPM_FORCE_EXIT_GRACE_S", "-3")
    assert _grace_seconds() == 0.0


def test_default_action_arms_the_fallback_before_signalling(monkeypatch):
    """Order matters: on Windows the signal call may not return, and a
    fallback armed after it would never start."""
    events = []
    monkeypatch.setattr(lifecycle.threading, "Thread",
                        lambda *a, **k: type("T", (), {
                            "start": lambda self: events.append("armed")
                        })())
    monkeypatch.setattr(lifecycle.os, "kill",
                        lambda _pid, _sig: events.append("signalled"))
    ParentWatchdog._default_action()
    assert events == ["armed", "signalled"]
