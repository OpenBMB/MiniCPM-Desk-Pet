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
sources are included as a git submodule at `llama.cpp/`, pinned to
[zhangtao2-1/llama.cpp@c5ede29](https://github.com/zhangtao2-1/llama.cpp).
See [.gitmodules](.gitmodules) for the URL and
[minicpm-sidecar/README.md](minicpm-sidecar/README.md#submodule--vendor-分支)
for the upgrade path.

### MiniCPM model weights

This project loads weights distributed by
[OpenBMB/MiniCPM](https://github.com/OpenBMB/MiniCPM). Model weights are
NOT bundled with this repository; users download GGUF files at first
launch via the in-app onboarding wizard. Use of the weights is governed
by OpenBMB's published model license.

### NekoQA-30K fine-tuning dataset

The bundled neko-style LoRA adapter in
[`adapters/lora_nekoqa_v2_fixedbase_adapter_20260524_0959/`](adapters/lora_nekoqa_v2_fixedbase_adapter_20260524_0959/)
was fine-tuned using the **neko30k** dataset
([liumindmind/NekoQA-30K](https://huggingface.co/datasets/liumindmind/NekoQA-30K)),
a Hugging Face text dataset with 30,834 cat-girl QA samples. The Hugging
Face dataset card lists the dataset license as Apache-2.0.

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
