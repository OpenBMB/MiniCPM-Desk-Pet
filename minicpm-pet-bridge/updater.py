"""Model auto-updater with two interchangeable backends.

Backends:
- mock://<absolute-path>     a local directory pretending to be HF (dev)
- hf://<repo_id>             real HuggingFace Hub via huggingface_hub

The protocol is intentionally tiny:
- Both sides have a `revision.json` describing the current revision and the
  list of files that make up the model.
- Local current revision is read from the local model dir.
- "Update available" = remote revision != local revision.
- Apply = atomic-ish copy of remote files into a *staging* dir, then swap.

Mock mode just file-copies (with progress) so the developer can simulate the
flow end-to-end without ever hitting the network.
"""

from __future__ import annotations

import json
import os
import shutil
import threading
import time
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Callable, Iterable, List, Optional

DEFAULT_SOURCE = os.environ.get(
    "MINICPM_UPDATE_SOURCE",
    f"mock://{Path.home() / 'Downloads' / 'Minicpm' / '.mock-hf-remote' / 'minicpm-pet-org' / 'minicpm5-0.9b'}",
)


@dataclass
class Revision:
    revision: str
    released_at: Optional[str] = None
    name: Optional[str] = None
    notes: Optional[str] = None
    files: Optional[List[str]] = None

    @classmethod
    def from_dict(cls, d: dict) -> "Revision":
        return cls(
            revision=str(d.get("revision") or ""),
            released_at=d.get("released_at"),
            name=d.get("name"),
            notes=d.get("notes"),
            files=list(d.get("files") or []),
        )

    def to_dict(self) -> dict:
        return asdict(self)


# ── Backend interface ───────────────────────────────────────────────────────


class _Backend:
    name: str = "abstract"

    def fetch_revision(self) -> Revision:
        raise NotImplementedError

    def stream_files(self, target_dir: Path, on_progress: Callable[[dict], None]) -> None:
        """Materialise the remote revision into `target_dir` and call
        `on_progress` periodically with {file, bytes_done, bytes_total, ...}."""
        raise NotImplementedError


class MockBackend(_Backend):
    name = "mock"

    def __init__(self, root: Path) -> None:
        self.root = Path(root).expanduser().resolve()
        # Don't fail eagerly here: the default mock path is dev-machine
        # specific, and the server should still boot for chat even if the
        # update source is missing. fetch_revision / stream_files below
        # already raise descriptive errors when the user actually invokes
        # update-check / update-apply.

    def fetch_revision(self) -> Revision:
        if not self.root.is_dir():
            raise FileNotFoundError(f"mock remote root does not exist: {self.root}")
        rf = self.root / "revision.json"
        if not rf.exists():
            raise FileNotFoundError(f"mock remote missing revision.json: {rf}")
        return Revision.from_dict(json.loads(rf.read_text("utf-8")))

    def stream_files(self, target_dir: Path, on_progress) -> None:
        rev = self.fetch_revision()
        files = rev.files or [p.name for p in self.root.iterdir() if p.is_file()]
        # Always include revision.json so the local dir advances atomically.
        if "revision.json" not in files:
            files = [*files, "revision.json"]

        total_bytes = 0
        sizes: dict[str, int] = {}
        for f in files:
            p = self.root / f
            if not p.exists():
                raise FileNotFoundError(f"mock remote missing file: {p}")
            sizes[f] = p.stat().st_size
            total_bytes += sizes[f]

        on_progress({
            "phase": "start",
            "files_total": len(files),
            "bytes_total": total_bytes,
        })

        bytes_done = 0
        target_dir.mkdir(parents=True, exist_ok=True)
        for idx, f in enumerate(files):
            src = self.root / f
            dst = target_dir / f
            tmp = target_dir / f"{f}.part"
            with src.open("rb") as r, tmp.open("wb") as w:
                while True:
                    chunk = r.read(4 * 1024 * 1024)
                    if not chunk:
                        break
                    w.write(chunk)
                    bytes_done += len(chunk)
                    on_progress({
                        "phase": "transfer",
                        "file": f,
                        "file_index": idx,
                        "files_total": len(files),
                        "bytes_done": bytes_done,
                        "bytes_total": total_bytes,
                    })
            os.replace(tmp, dst)

        on_progress({
            "phase": "done",
            "files_total": len(files),
            "bytes_done": total_bytes,
            "bytes_total": total_bytes,
        })


class HFBackend(_Backend):
    name = "huggingface_hub"

    def __init__(self, repo_id: str, token: Optional[str] = None) -> None:
        self.repo_id = repo_id
        self.token = token or os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")

    def fetch_revision(self) -> Revision:
        # We try the repo's revision.json first (canonical, our convention).
        # Falls back to model_info().sha as a last resort.
        try:
            from huggingface_hub import hf_hub_download
            local_rev_file = hf_hub_download(
                repo_id=self.repo_id,
                filename="revision.json",
                token=self.token,
                repo_type="model",
            )
            return Revision.from_dict(json.loads(Path(local_rev_file).read_text("utf-8")))
        except Exception:
            pass
        try:
            from huggingface_hub import HfApi
            info = HfApi(token=self.token).model_info(self.repo_id)
            sha = (info.sha or "")[:12] or "unknown"
            siblings = [s.rfilename for s in (info.siblings or [])]
            return Revision(revision=f"hf-{sha}", files=siblings)
        except Exception as exc:
            raise RuntimeError(f"failed to fetch HF revision for {self.repo_id}: {exc}")

    def stream_files(self, target_dir: Path, on_progress) -> None:
        from huggingface_hub import snapshot_download

        on_progress({"phase": "start", "files_total": 0, "bytes_total": 0})
        snapshot_download(
            repo_id=self.repo_id,
            local_dir=str(target_dir),
            local_dir_use_symlinks=False,
            token=self.token,
            tqdm_class=None,  # silence default tqdm; we'd ideally hook into hf_transfer's progress
        )
        # huggingface_hub doesn't expose granular progress by default; we
        # report a single "done" tick after snapshot completes. (For richer
        # progress we'd need to pre-list siblings + download one-by-one with
        # hf_hub_download.)
        on_progress({"phase": "done"})


# ── Updater facade ──────────────────────────────────────────────────────────


def parse_source(source: str) -> _Backend:
    if source.startswith("mock://"):
        return MockBackend(source[len("mock://"):])
    if source.startswith("hf://"):
        return HFBackend(source[len("hf://"):])
    raise ValueError(f"unknown updater source: {source!r}")


class ModelUpdater:
    """High-level operations the server exposes over HTTP."""

    def __init__(self, local_model_dir: Path, source: str = DEFAULT_SOURCE) -> None:
        self.local_model_dir = Path(local_model_dir).expanduser().resolve()
        self.source = source
        self.backend = parse_source(source)
        self._lock = threading.Lock()
        self._busy = False

    # — local revision —
    def local_revision(self) -> Optional[Revision]:
        rf = self.local_model_dir / "revision.json"
        if not rf.exists():
            return None
        try:
            return Revision.from_dict(json.loads(rf.read_text("utf-8")))
        except Exception:
            return None

    # — remote revision (with caching to keep on-launch checks cheap) —
    _cache: tuple[float, Revision] | None = None
    _cache_ttl_sec = 90

    def remote_revision(self, *, use_cache: bool = True) -> Revision:
        if use_cache and self._cache:
            ts, rev = self._cache
            if time.time() - ts < self._cache_ttl_sec:
                return rev
        rev = self.backend.fetch_revision()
        self._cache = (time.time(), rev)
        return rev

    # — query —
    def check(self) -> dict:
        local = self.local_revision()
        try:
            remote = self.remote_revision()
            err = None
        except Exception as exc:
            remote = None
            err = str(exc)
        local_rev = local.revision if local else None
        remote_rev = remote.revision if remote else None
        return {
            "available": bool(remote_rev) and remote_rev != local_rev,
            "local_revision": local_rev,
            "remote_revision": remote_rev,
            "remote_name": remote.name if remote else None,
            "remote_notes": remote.notes if remote else None,
            "remote_released_at": remote.released_at if remote else None,
            "source": self.source,
            "backend": self.backend.name,
            "error": err,
            "busy": self._busy,
        }

    # — apply (generator yielding progress events) —
    def apply(self) -> Iterable[dict]:
        with self._lock:
            if self._busy:
                yield {"phase": "error", "message": "another update is in progress"}
                return
            self._busy = True
        try:
            staging = self.local_model_dir.parent / f"{self.local_model_dir.name}.update-staging"
            if staging.exists():
                shutil.rmtree(staging, ignore_errors=True)
            staging.mkdir(parents=True, exist_ok=True)

            queue: list[dict] = []
            cv = threading.Condition()

            def push(ev: dict):
                with cv:
                    queue.append(ev)
                    cv.notify_all()

            def worker():
                try:
                    self.backend.stream_files(staging, push)
                    push({"phase": "swap"})
                    # Atomic-ish swap: move current dir aside, move staging in,
                    # delete the old one.
                    backup = self.local_model_dir.parent / f"{self.local_model_dir.name}.bak"
                    if backup.exists():
                        shutil.rmtree(backup, ignore_errors=True)
                    if self.local_model_dir.exists():
                        os.replace(self.local_model_dir, backup)
                    os.replace(staging, self.local_model_dir)
                    if backup.exists():
                        shutil.rmtree(backup, ignore_errors=True)
                    push({"phase": "complete"})
                except Exception as exc:
                    push({"phase": "error", "message": str(exc)})

            threading.Thread(target=worker, daemon=True).start()

            while True:
                with cv:
                    while not queue:
                        cv.wait(timeout=30)
                    ev = queue.pop(0)
                yield ev
                if ev.get("phase") in ("complete", "error"):
                    break
        finally:
            self._busy = False
            self._cache = None  # invalidate so next check re-reads


if __name__ == "__main__":
    # Tiny CLI to sanity-check the mock flow:
    #   python updater.py check
    #   python updater.py apply
    import sys

    here = Path(__file__).resolve().parent
    local = here.parent / "models" / "minicpm5-0.9b"
    u = ModelUpdater(local)
    if len(sys.argv) > 1 and sys.argv[1] == "apply":
        for ev in u.apply():
            print(ev, flush=True)
    else:
        print(json.dumps(u.check(), ensure_ascii=False, indent=2))
