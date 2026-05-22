# Notices

## MiniCPM Desk Pet

Copyright © 2026 OpenBMB.

This repository combines a local MiniCPM5-0.9B inference sidecar (via
[llama.cpp](https://github.com/ggml-org/llama.cpp)) with an Electron
desktop pet UI. The Electron application (`clawd-on-desk/`) is a fork
of [rullerzhou-afk/clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk)
at commit `5b1f003`, modified to add local MiniCPM5-0.9B inference, a
5-step onboarding wizard, LoRA persona switching, and desktop-pet
narration for coding agents.

This project and its upstream are licensed under the GNU Affero General
Public License v3.0 (AGPL-3.0-only); see [LICENSE](./LICENSE) for the
full text. Source code is available at
https://github.com/OpenBMB/MiniCPM-Desk-Pet.

---

## Third-party components

### llama.cpp

The sidecar embeds [`llama-server`](https://github.com/ggml-org/llama.cpp)
(MIT License, © 2023 Georgi Gerganov and llama.cpp contributors).
While MiniCPM5 tokenizer support is still in flight upstream
([PR #23384](https://github.com/ggml-org/llama.cpp/pull/23384)), the
vendored sources are pinned to
[zhangtao2-1/llama.cpp@c5ede29](https://github.com/zhangtao2-1/llama.cpp).
See [minicpm-sidecar/scripts/clone-llama.sh](minicpm-sidecar/scripts/clone-llama.sh)
for the exact commit and [minicpm-sidecar/README.md](minicpm-sidecar/README.md#vendor-分支)
for the upgrade path.

### MiniCPM model weights

This project loads weights distributed by
[OpenBMB/MiniCPM](https://github.com/OpenBMB/MiniCPM). Model weights are
NOT bundled with this repository; users download GGUF files at first
launch via the in-app onboarding wizard. Use of the weights is governed
by OpenBMB's published model license.

### clawd-on-desk subproject

`clawd-on-desk/` is a vendored fork that ships its own
[LICENSE](clawd-on-desk/LICENSE) (AGPL-3.0-only) and
[NOTICE.md](clawd-on-desk/NOTICE.md). The latter enumerates additional
third-party attributions (OpenClaw pixel-lobster icon under MIT,
artwork credits, etc.) — refer to that file for the authoritative list.

### Python gateway dependencies

The FastAPI gateway depends on, among others, `fastapi`, `uvicorn`,
`httpx`, and `huggingface_hub`. See
[minicpm-sidecar/pyproject.toml](minicpm-sidecar/pyproject.toml) and
the generated `uv.lock` for the full transitive set and licenses.
