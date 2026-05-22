"""Splits a model stream into reasoning (<think>...</think>) and content events.

Ported from the legacy PyTorch bridge. The MiniCPM chat template wraps
reasoning in <think>...</think>; we hold any text that *might* be the start
of a tag until we know for sure, then emit either a `think` event (when
expose=True) or drop it (when expose=False). Plain text outside the tag is
always emitted as a `delta` event.

The Electron renderer (see clawd-on-desk/src/minicpm-chat.html) consumes
this exact event vocabulary.
"""

from __future__ import annotations

from typing import Iterable


class ThinkBlockFilter:
    OPEN_TAG = "<think>"
    CLOSE_TAG = "</think>"

    def __init__(self, *, expose: bool, start_inside: bool = False) -> None:
        self.expose = expose
        self._buf = ""
        self._mode = "inside" if start_inside else "outside"

    def feed(self, piece: str) -> list[dict]:
        self._buf += piece
        return list(self._drain())

    def flush(self) -> list[dict]:
        out = list(self._drain(final=True))
        if self._buf:
            ev = "think" if (self._mode == "inside" and self.expose) else "delta"
            if self._mode == "inside" and not self.expose:
                pass  # drop residual reasoning when caller doesn't want it
            else:
                out.append({"event": ev, "content": self._buf})
            self._buf = ""
        return out

    def _drain(self, *, final: bool = False) -> Iterable[dict]:
        while self._buf:
            if self._mode == "outside":
                idx = self._buf.find(self.OPEN_TAG)
                if idx < 0:
                    safe_len = self._safe_emit_len(self._buf, self.OPEN_TAG)
                    if safe_len <= 0:
                        if final and self._buf:
                            yield {"event": "delta", "content": self._buf}
                            self._buf = ""
                        return
                    out, self._buf = self._buf[:safe_len], self._buf[safe_len:]
                    if out:
                        yield {"event": "delta", "content": out}
                    return
                if idx > 0:
                    out, self._buf = self._buf[:idx], self._buf[idx:]
                    yield {"event": "delta", "content": out}
                self._buf = self._buf[len(self.OPEN_TAG):]
                self._mode = "inside"
            else:  # inside <think>
                idx = self._buf.find(self.CLOSE_TAG)
                if idx < 0:
                    safe_len = self._safe_emit_len(self._buf, self.CLOSE_TAG)
                    if safe_len <= 0:
                        return
                    out, self._buf = self._buf[:safe_len], self._buf[safe_len:]
                    if out and self.expose:
                        yield {"event": "think", "content": out}
                    return
                head, self._buf = self._buf[:idx], self._buf[idx + len(self.CLOSE_TAG):]
                if head and self.expose:
                    yield {"event": "think", "content": head}
                self._mode = "outside"
                # Eat exactly one trailing "\n\n" the template inserts after </think>
                if self._buf.startswith("\n\n"):
                    self._buf = self._buf[2:]
                elif self._buf.startswith("\n"):
                    self._buf = self._buf[1:]

    @staticmethod
    def _safe_emit_len(buf: str, tag: str) -> int:
        """How many chars of `buf` can be emitted without crossing a partial tag tail."""
        max_keep = len(tag) - 1
        for keep in range(min(max_keep, len(buf)), 0, -1):
            if tag.startswith(buf[-keep:]):
                return len(buf) - keep
        return len(buf)
