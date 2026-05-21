"""Model auto-updater for GGUF files.

Same revision.json protocol as the old PyTorch sidecar — keeps the Electron
side (which expects {available, local_revision, remote_revision, ...} from
/api/update-check and SSE phases start/transfer/swap/complete from
/api/update-apply) compatible.

Backends:
- mock://<absolute-path>       local dir pretending to be HF (dev only)
- hf://<repo_id>[:<filename>]  HuggingFace repo; downloads either
                                  the named *.gguf (recommended) or the
                                  first .gguf sibling in the repo.
- file://<absolute-path>       a single local .gguf — used when the user
                                  has pre-staged the weight file via
                                  Settings ("本地模型路径"). Treated as
                                  always up-to-date.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import threading
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable, Iterable, List, Optional


DEFAULT_SOURCE = os.environ.get(
    "MINICPM_UPDATE_SOURCE",
    # Conservative default until the user supplies an official GGUF repo.
    "hf://openbmb/MiniCPM5-0.9B-GGUF",
)

# Suffix for in-flight download files — atomic-renamed on completion so
# partially downloaded files never get picked up by /api/models.
_PART_SUFFIX = ".part"


def _atomic_move(src: Path, dst: Path) -> None:
    """Rename src to dst across volumes safely."""
    try:
        os.replace(src, dst)
    except OSError:
        shutil.move(str(src), str(dst))


@dataclass
class Revision:
    revision: str
    released_at: Optional[str] = None
    name: Optional[str] = None
    notes: Optional[str] = None
    # For GGUF the file list is just one entry, but we keep the schema
    # symmetric with the old multi-file HF layout so the Electron side
    # doesn't have to branch.
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


class _Backend:
    name: str = "abstract"

    def fetch_revision(self) -> Revision:
        raise NotImplementedError

    def stream_files(self, target_dir: Path, on_progress: Callable[[dict], None]) -> None:
        raise NotImplementedError


class MockBackend(_Backend):
    name = "mock"

    def __init__(self, root: str) -> None:
        self.root = Path(root).expanduser().resolve()
        if not self.root.is_dir():
            raise FileNotFoundError(f"mock remote root does not exist: {self.root}")

    def fetch_revision(self) -> Revision:
        rf = self.root / "revision.json"
        if not rf.exists():
            raise FileNotFoundError(f"mock remote missing revision.json: {rf}")
        return Revision.from_dict(json.loads(rf.read_text("utf-8")))

    def stream_files(self, target_dir: Path, on_progress) -> None:
        rev = self.fetch_revision()
        files = rev.files or [p.name for p in self.root.iterdir() if p.is_file()]
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

        on_progress({"phase": "start", "files_total": len(files), "bytes_total": total_bytes})

        bytes_done = 0
        target_dir.mkdir(parents=True, exist_ok=True)
        for idx, f in enumerate(files):
            src = self.root / f
            dst = target_dir / f
            tmp = target_dir / f"{f}{_PART_SUFFIX}"
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
            _atomic_move(tmp, dst)

        on_progress({
            "phase": "done",
            "files_total": len(files),
            "bytes_done": total_bytes,
            "bytes_total": total_bytes,
        })


class HFGGUFBackend(_Backend):
    """Pulls a single .gguf file from a HuggingFace repo.

    Source syntax accepted:
        hf://owner/repo                — pick the first *.gguf sibling
        hf://owner/repo:filename.gguf  — pick a specific file
    """

    name = "huggingface_gguf"

    def __init__(self, spec: str, token: Optional[str] = None) -> None:
        if ":" in spec:
            self.repo_id, self.filename = spec.split(":", 1)
        else:
            self.repo_id, self.filename = spec, None
        self.token = token or os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
        self._cached_filename: Optional[str] = None

    def _resolve_filename(self) -> str:
        if self.filename:
            self._cached_filename = self.filename
            return self.filename
        if self._cached_filename:
            return self._cached_filename
        from huggingface_hub import HfApi
        info = HfApi(token=self.token).model_info(self.repo_id)
        siblings = [s.rfilename for s in (info.siblings or [])]
        ggufs = [f for f in siblings if f.lower().endswith(".gguf")]
        if not ggufs:
            raise RuntimeError(f"HF repo {self.repo_id} has no .gguf file")
        # Prefer quantised variants in this rough order (best size/quality
        # trade-off for small models on consumer hardware).
        preferred = ["Q4_K_M", "Q5_K_M", "Q4_0", "Q8_0", "f16"]
        ggufs.sort(key=lambda n: next(
            (i for i, k in enumerate(preferred) if k.lower() in n.lower()),
            len(preferred),
        ))
        self._cached_filename = ggufs[0]
        return ggufs[0]

    def fetch_revision(self) -> Revision:
        from huggingface_hub import HfApi
        info = HfApi(token=self.token).model_info(self.repo_id)
        sha = (info.sha or "")[:12] or "unknown"
        fname = self._resolve_filename()
        return Revision(
            revision=f"hf-{sha}-{fname}",
            files=[fname],
            name=fname,
            notes=f"{self.repo_id} @ {sha}",
        )

    def stream_files(self, target_dir: Path, on_progress) -> None:
        from huggingface_hub import hf_hub_download

        target_dir.mkdir(parents=True, exist_ok=True)
        fname = self._resolve_filename()

        on_progress({"phase": "start", "files_total": 1, "bytes_total": 0})

        # We let huggingface_hub do the heavy lifting (resume + retries),
        # then move the result into our staging dir under the same name.
        # The hub stores files into HF_HOME cache; passing local_dir
        # mirrors them into our target.
        local = hf_hub_download(
            repo_id=self.repo_id,
            filename=fname,
            token=self.token,
            local_dir=str(target_dir),
            local_dir_use_symlinks=False,
        )
        local_path = Path(local)
        size = local_path.stat().st_size if local_path.exists() else 0

        on_progress({
            "phase": "transfer",
            "file": fname,
            "file_index": 0,
            "files_total": 1,
            "bytes_done": size,
            "bytes_total": size,
        })

        # Drop a revision.json so subsequent /api/update-check can compare
        # without round-tripping to HF every time.
        rev = self.fetch_revision()
        (target_dir / "revision.json").write_text(
            json.dumps(rev.to_dict(), ensure_ascii=False, indent=2), "utf-8"
        )

        on_progress({
            "phase": "done",
            "files_total": 1,
            "bytes_done": size,
            "bytes_total": size,
        })


class FileBackend(_Backend):
    """A bare local .gguf the user pre-staged; never reports updates."""

    name = "file"

    def __init__(self, path: str) -> None:
        self.path = Path(path).expanduser().resolve()
        if not self.path.is_file():
            raise FileNotFoundError(f"file:// source not found: {self.path}")

    def fetch_revision(self) -> Revision:
        # Use a hash of size+mtime so swapping in a new file on disk does
        # invalidate the cached revision.
        st = self.path.stat()
        digest = hashlib.sha256(f"{self.path.name}|{st.st_size}|{int(st.st_mtime)}".encode()).hexdigest()[:12]
        return Revision(revision=f"file-{digest}", files=[self.path.name], name=self.path.name)

    def stream_files(self, target_dir: Path, on_progress) -> None:  # pragma: no cover
        # Nothing to fetch — refuse the apply so callers know.
        raise RuntimeError("file:// source has nothing to download; manage the .gguf manually")


def parse_source(source: str) -> _Backend:
    if source.startswith("mock://"):
        return MockBackend(source[len("mock://"):])
    if source.startswith("hf://"):
        return HFGGUFBackend(source[len("hf://"):])
    if source.startswith("file://"):
        return FileBackend(source[len("file://"):])
    raise ValueError(f"unknown updater source: {source!r}")


class ModelUpdater:
    """High-level operations the gateway exposes over HTTP.

    `local_model_path` is the path to the currently active .gguf file —
    used to compare against the remote revision. We treat the parent dir
    as the model root for download staging.
    """

    def __init__(self, local_model_path: Path, source: str = DEFAULT_SOURCE) -> None:
        self.local_model_path = Path(local_model_path).expanduser()
        self.source = source
        self.backend = parse_source(source)
        self._lock = threading.Lock()
        self._busy = False

    @property
    def local_model_dir(self) -> Path:
        return self.local_model_path.parent

    def local_revision(self) -> Optional[Revision]:
        rf = self.local_model_dir / "revision.json"
        if not rf.exists():
            # Even without a revision.json the file may exist; report a
            # synthetic revision from the file's stat so /api/update-check
            # at least returns a stable identifier.
            if self.local_model_path.exists():
                st = self.local_model_path.stat()
                digest = hashlib.sha256(
                    f"{self.local_model_path.name}|{st.st_size}|{int(st.st_mtime)}".encode()
                ).hexdigest()[:12]
                return Revision(revision=f"local-{digest}", files=[self.local_model_path.name])
            return None
        try:
            return Revision.from_dict(json.loads(rf.read_text("utf-8")))
        except Exception:
            return None

    _cache: "tuple[float, Revision] | None" = None
    _cache_ttl_sec = 90

    def remote_revision(self, *, use_cache: bool = True) -> Revision:
        if use_cache and self._cache:
            ts, rev = self._cache
            if time.time() - ts < self._cache_ttl_sec:
                return rev
        rev = self.backend.fetch_revision()
        self._cache = (time.time(), rev)
        return rev

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

    def apply(self) -> Iterable[dict]:
        with self._lock:
            if self._busy:
                yield {"phase": "error", "message": "another update is in progress"}
                return
            self._busy = True
        try:
            target_dir = self.local_model_dir
            target_dir.mkdir(parents=True, exist_ok=True)
            staging = target_dir.parent / f"{target_dir.name}.update-staging"
            if staging.exists():
                shutil.rmtree(staging, ignore_errors=True)
            staging.mkdir(parents=True, exist_ok=True)

            queue: list[dict] = []
            cv = threading.Condition()

            def push(ev: dict) -> None:
                with cv:
                    queue.append(ev)
                    cv.notify_all()

            def worker() -> None:
                try:
                    self.backend.stream_files(staging, push)
                    push({"phase": "swap"})
                    # Atomic-ish swap: move existing files aside, move staging
                    # contents in, delete the backup.
                    backup = target_dir.parent / f"{target_dir.name}.bak"
                    if backup.exists():
                        shutil.rmtree(backup, ignore_errors=True)
                    if target_dir.exists():
                        backup.mkdir(parents=True, exist_ok=True)
                        for child in target_dir.iterdir():
                            _atomic_move(child, backup / child.name)
                    for child in staging.iterdir():
                        _atomic_move(child, target_dir / child.name)
                    shutil.rmtree(staging, ignore_errors=True)
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
            self._cache = None
