# DEPRECATED

This directory contains the **legacy PyTorch sidecar** (`server.py` based on
`transformers` + `peft`). It was retired in favour of [`minicpm-sidecar/`](../minicpm-sidecar/)
at the root of this repo, which is built on llama.cpp's `llama-server` and
ships a fraction of the size with no Python heavy-deps in the installer.

**Do not depend on this directory for new work.** The contents are kept only
for historical reference and the LoRA-related code paths that the upcoming
v2 (GGUF LoRA support) will port across.

| Replacement | New location |
|-------------|--------------|
| `server.py` (FastAPI app) | [`minicpm-sidecar/gateway/server.py`](../minicpm-sidecar/gateway/server.py) |
| `clawd_state.py` | [`minicpm-sidecar/gateway/clawd_state.py`](../minicpm-sidecar/gateway/clawd_state.py) |
| `updater.py` (HF snapshot) | [`minicpm-sidecar/gateway/updater.py`](../minicpm-sidecar/gateway/updater.py) (GGUF) |
| `ThinkBlockFilter` | [`minicpm-sidecar/gateway/think_filter.py`](../minicpm-sidecar/gateway/think_filter.py) |
| `chat.py` REPL | use `curl` against `/api/chat` directly (or build a thin shim) |
| LoRA via PEFT | not implemented yet — tracked for v2 |
| `start.sh` (conda activate) | [`go.sh`](../go.sh) in repo root |

This directory will be removed entirely once the upstream
[ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp) merges MiniCPM5
tokenizer support (see PR #23384) and the v2 LoRA port lands.
