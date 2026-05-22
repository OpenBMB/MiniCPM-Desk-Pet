# Contributing to MiniCPM Desk Pet

Thanks for your interest in this project. This file is the operational
entry point for developers; deeper background lives in
[docs/development.md](docs/development.md) and
[clawd-on-desk/AGENTS.md](clawd-on-desk/AGENTS.md).

> Looking to just use the app? Grab a prebuilt installer from
> [Releases](https://github.com/OpenBMB/MiniCPM-Desk-Pet/releases). This
> document is only relevant if you plan to modify the code.

## Quickstart (dev mode)

```bash
git clone git@github.com:OpenBMB/MiniCPM-Desk-Pet.git
cd MiniCPM-Desk-Pet

./go.sh doctor    # check that node 18+, uv, cmake are present
./go.sh setup     # install deps + first-time build of llama-server (~5–10 min)
./go.sh           # run sidecar + Electron pet in foreground

# Or out a packaged installer (mac arm64 dmg):
./go.sh build
```

The first launch will offer to download a GGUF model from Hugging Face
via the onboarding wizard. Alternatively drop a `.gguf` into `models/`
before starting `./go.sh`.

## Repository layout

```
MiniCPM-Desk-Pet/
├── clawd-on-desk/      Electron desktop pet (vendored fork)
├── minicpm-sidecar/    llama.cpp + FastAPI gateway (inference service)
├── adapters/           LoRA persona adapters (.gguf + safetensors source)
├── docs/               Developer docs + archived v0.7 design notes
├── skills/             Cursor Agent Skills (dev deployment helper)
├── models/             GGUF model files (gitignored)
└── go.sh               One-shot dev launcher + build entry point
```

## Tests

Before opening a PR, please make sure both test suites pass:

```bash
# Electron host (Node built-in test runner)
cd clawd-on-desk && npm test

# Python gateway
cd minicpm-sidecar && uv run pytest -q
```

If you change CI workflows under `.github/workflows/`, run them via
`workflow_dispatch` on your fork to verify before merging.

## Commit style

We follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat: ...` — new user-visible feature
- `fix: ...` — bug fix
- `refactor: ...` — non-functional code change
- `chore: ...` — tooling, dependencies, build, docs
- `docs: ...` — documentation only

Scope optional, e.g. `feat(sidecar): add /api/load-adapter endpoint`.

## Pull request checklist

- [ ] Branch is rebased on the latest `minicpm-pet` (or target branch)
- [ ] `npm test` and `uv run pytest -q` pass locally
- [ ] User-facing changes have a one-line entry in
      [CHANGELOG.md](CHANGELOG.md) under an upcoming version section
- [ ] If you touch onboarding, sidecar lifecycle, or packaging, please
      include a short test plan (commands run, platform verified) in
      the PR description
- [ ] No model weights, `.venv`, `node_modules`, or `dist/` artifacts
      committed

## Issue templates

See `.github/ISSUE_TEMPLATE/` (TBD) for bug-report / feature-request
forms. For now, please include:

- OS + architecture (e.g. macOS 14.5 / arm64)
- App version (from About menu) or git commit if running from source
- Steps to reproduce + observed vs expected behaviour
- Relevant log excerpts from
  `~/Library/Application Support/Clawd on Desk/logs/main.log` (macOS)
  or the equivalent on Linux/Windows

## License

By contributing, you agree that your contributions will be licensed
under the [AGPL-3.0-only](LICENSE) license that covers the project.
