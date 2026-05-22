# Archived design documents

The files in this directory are **historical** design notes from the
v0.7 era of MiniCPM-test, when the inference sidecar was still built on
`torch + transformers + peft` and packaged via PyInstaller embedding
~700 MB of torch into the installer.

In v0.8 the inference backend was rewritten on top of
[llama.cpp](https://github.com/ggml-org/llama.cpp); the live design
docs now live one directory up:

- [../llama-cpp-migration.md](../llama-cpp-migration.md) — supersedes
  the PyTorch sidecar chapters (PyInstaller spec, torch wheel matrix,
  MPS fallback workarounds, build-sidecar.sh, etc.)
- [../development.md](../development.md) — current developer guide

The documents here are kept for traceability:

| File | What it covers | Status |
|------|----------------|--------|
| [PRD-sidecar-cross-platform-refactor.md](PRD-sidecar-cross-platform-refactor.md) | v0.7 product requirements for cross-platform packaging | partially superseded by v0.8 — see in-doc 勘误 banner |
| [architecture-and-cross-platform-report.md](architecture-and-cross-platform-report.md) | v0.7 architecture survey + three-OS packaging plan | partially superseded by v0.8 — see in-doc 勘误 banner |

Each file carries an inline `v0.8 勘误` marker pointing at the sections
that have been replaced. Cross-platform / signing / auto-update
analysis in those documents is still applicable.
