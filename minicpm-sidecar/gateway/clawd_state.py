"""Best-effort bridge that pushes pet states to a running clawd-on-desk server.

The desktop pet listens on 127.0.0.1:23333-23337 and writes the active port to
~/.clawd/runtime.json. We just POST to /state and silently drop the event if
the pet is not running.

Ported verbatim from the legacy minicpm-pet-bridge so the pet state mapping
(thinking / working / attention / etc.) keeps the same semantics under the
new llama.cpp backend.
"""

from __future__ import annotations

import json
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Optional

import httpx

CLAWD_PORTS = [23333, 23334, 23335, 23336, 23337]
RUNTIME_FILE = Path.home() / ".clawd" / "runtime.json"

# We borrow the claude-code agent_id so the existing animation map kicks in
# without modifying the desktop pet's agent registry.
AGENT_ID = "claude-code"


def _candidate_ports() -> list[int]:
    """Try the runtime port first (whatever is alive right now), then the rest."""
    ports: list[int] = []
    try:
        data = json.loads(RUNTIME_FILE.read_text("utf-8"))
        port = int(data.get("port") or 0)
        if port in CLAWD_PORTS:
            ports.append(port)
    except Exception:
        pass
    for p in CLAWD_PORTS:
        if p not in ports:
            ports.append(p)
    return ports


class ClawdBridge:
    """Thread-friendly state pusher with one persistent session_id per chat turn."""

    def __init__(self, *, enabled: bool = True, debug: bool = False) -> None:
        self.enabled = enabled
        self.debug = debug
        self._lock = threading.Lock()
        self._session_id = f"minicpm-{uuid.uuid4().hex[:8]}"
        self._port: Optional[int] = None
        self._cwd = os.getcwd()
        self._client = httpx.Client(timeout=0.4)

    def new_session(self) -> None:
        with self._lock:
            self._session_id = f"minicpm-{uuid.uuid4().hex[:8]}"

    def post(self, state: str, *, event: Optional[str] = None, title: Optional[str] = None) -> None:
        if not self.enabled:
            return
        body = {
            "state": state,
            "session_id": self._session_id,
            "agent_id": AGENT_ID,
            "event": event or _default_event_for(state),
            "cwd": self._cwd,
        }
        if title:
            body["session_title"] = title

        order: list[int] = []
        if self._port:
            order.append(self._port)
        for p in _candidate_ports():
            if p not in order:
                order.append(p)

        payload = json.dumps(body).encode("utf-8")
        for port in order:
            try:
                resp = self._client.post(
                    f"http://127.0.0.1:{port}/state",
                    content=payload,
                    headers={"Content-Type": "application/json"},
                )
                if resp.headers.get("x-clawd-server") == "clawd-on-desk" or resp.status_code < 500:
                    self._port = port
                    if self.debug:
                        print(f"[clawd] {state} -> :{port} ({resp.status_code})")
                    return
            except Exception as exc:
                if self.debug:
                    print(f"[clawd] :{port} failed: {exc}")
                continue
        if self.debug:
            print(f"[clawd] no server reachable; dropped state={state}")

    def close(self) -> None:
        try:
            self._client.close()
        except Exception:
            pass


def _default_event_for(state: str) -> str:
    return {
        "idle": "SessionStart",
        "thinking": "UserPromptSubmit",
        "working": "PreToolUse",
        "attention": "Stop",
        "notification": "Notification",
        "error": "StopFailure",
        "sleeping": "SessionEnd",
    }.get(state, "Notification")
