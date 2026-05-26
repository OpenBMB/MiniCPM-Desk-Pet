"""Tests for gateway/lifecycle.py — parent-watchdog and stale-orphan cleanup.

These tests exercise the cross-platform helpers without ever touching
llama-server itself; we use short-lived `sleep` / `python -c` children
as stand-ins.
"""

from __future__ import annotations

import os
import platform
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from gateway.lifecycle import (
    ParentWatchdog,
    _pid_alive,
    _process_name_matches,
    cleanup_stale_llama_server,
    clear_pid_file,
    pdeathsig_preexec,
    write_pid_file,
)


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


# ── PID file + stale cleanup ────────────────────────────────────────────


def test_write_and_clear_pid_file(tmp_path: Path) -> None:
    pid_file = tmp_path / "llama-server.pid"
    write_pid_file(pid_file, 12345)
    assert pid_file.read_text(encoding="ascii").strip() == "12345"
    clear_pid_file(pid_file)
    assert not pid_file.exists()


def test_clear_pid_file_idempotent(tmp_path: Path) -> None:
    pid_file = tmp_path / "missing.pid"
    # Removing a non-existent file must not raise.
    clear_pid_file(pid_file)
    clear_pid_file(pid_file)


def test_cleanup_skips_when_no_pid_file(tmp_path: Path) -> None:
    cleanup_stale_llama_server(tmp_path / "ghost.pid")
    # Nothing to assert beyond "didn't crash"; the absence path is the
    # most common one (first ever boot).


def test_cleanup_clears_pid_file_for_dead_pid(tmp_path: Path) -> None:
    pid_file = tmp_path / "llama-server.pid"
    proc = subprocess.Popen([sys.executable, "-c", "pass"])
    proc.wait()
    time.sleep(0.05)
    write_pid_file(pid_file, proc.pid)

    cleanup_stale_llama_server(pid_file)
    assert not pid_file.exists()


def test_cleanup_skips_when_process_name_does_not_match(tmp_path: Path) -> None:
    """A live PID that *isn't* llama-server (e.g. PID got recycled to a
    user's shell) must NOT be killed."""
    pid_file = tmp_path / "llama-server.pid"
    # Long-lived stand-in process; its `comm` is `python` (or
    # `python3`), so the "llama-server" needle doesn't match and we
    # should leave it alone.
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(5)"])
    write_pid_file(pid_file, child.pid)
    try:
        cleanup_stale_llama_server(pid_file)
        # PID file should be cleared (no longer trusted), but the
        # process must still be alive — that's the whole point.
        assert _pid_alive(child.pid)
        assert not pid_file.exists()
    finally:
        child.terminate()
        child.wait(timeout=2)


@pytest.mark.skipif(
    platform.system() == "Windows",
    reason="signal-based reaping not exercised on Windows in CI",
)
def test_cleanup_kills_matching_stale_process(tmp_path: Path) -> None:
    """Spawn a sleep'er, lie that its name is the needle, verify cleanup
    sends SIGTERM. We pass the real process name as `expected_name` so
    the matcher actually fires."""
    pid_file = tmp_path / "llama-server.pid"
    # Use `sleep 60` (POSIX) — its `comm` is just `sleep`, a stable needle.
    child = subprocess.Popen(["sleep", "60"])
    write_pid_file(pid_file, child.pid)
    try:
        cleanup_stale_llama_server(pid_file, expected_name="sleep")
        # SIGTERM should have arrived; wait up to 3s for exit.
        for _ in range(30):
            if child.poll() is not None:
                break
            time.sleep(0.1)
        assert child.poll() is not None, "stale process survived cleanup"
        assert not pid_file.exists()
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=2)


# ── _process_name_matches ───────────────────────────────────────────────


def test_process_name_matches_self() -> None:
    # Our own interpreter's `comm` always contains "python" on POSIX
    # and "python.exe" / "python3.exe" on Windows.
    assert _process_name_matches(os.getpid(), "python")


def test_process_name_matches_dead_pid() -> None:
    # Dead pids return False rather than crashing.
    assert _process_name_matches(0, "anything") is False


# ── pdeathsig_preexec ────────────────────────────────────────────────────


def test_pdeathsig_preexec_returns_none_off_linux() -> None:
    if platform.system() == "Linux":
        pytest.skip("Linux returns a callable; covered by other test")
    assert pdeathsig_preexec() is None


@pytest.mark.skipif(platform.system() != "Linux", reason="prctl is Linux-only")
def test_pdeathsig_preexec_returns_callable_on_linux() -> None:
    fn = pdeathsig_preexec()
    assert callable(fn)
    # Calling it from the test process is safe — prctl(PR_SET_PDEATHSIG)
    # just configures a per-task attribute; it doesn't fire on success.
    fn()  # type: ignore[misc]
