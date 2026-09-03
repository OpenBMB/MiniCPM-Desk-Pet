# Notices

## MiniCPM Desk Pet

Copyright © 2026 OpenBMB.

This repository combines a local MiniCPM inference sidecar (via
[OpenVINO GenAI](https://github.com/openvinotoolkit/openvino.genai),
targeting Intel AIPC GPUs and NPUs) with an Electron desktop pet UI.
The Electron application (`clawd-on-desk/`) is a fork
of [rullerzhou-afk/clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk)
at commit `5b1f003`, modified to add local MiniCPM inference, a
3-stage onboarding wizard, and desktop-pet narration for coding agents.

This project and its upstream are licensed under the GNU Affero General
Public License v3.0 (AGPL-3.0-only); see [LICENSE](./LICENSE) for the
full text. Source code is available at
https://github.com/OpenBMB/MiniCPM-Desk-Pet.

---

## Third-party components

### OpenVINO

Inference runs on [OpenVINO](https://github.com/openvinotoolkit/openvino)
and [OpenVINO GenAI](https://github.com/openvinotoolkit/openvino.genai)
(Apache License 2.0, © Intel Corporation), pulled in as the
`openvino-genai` Python dependency and bundled into the packaged sidecar.
Model conversion additionally uses
[optimum-intel](https://github.com/huggingface/optimum-intel) and
[NNCF](https://github.com/openvinotoolkit/nncf) (both Apache-2.0), which
are installed into a throwaway environment by
`minicpm-sidecar/scripts/convert-openvino.py` and are not shipped.

### MiniCPM model weights

This project loads weights distributed by
[OpenBMB/MiniCPM](https://github.com/OpenBMB/MiniCPM). Model weights are
NOT bundled with this repository; users convert a checkpoint to an
OpenVINO IR themselves with `minicpm-sidecar/scripts/convert-openvino.py`
and point the onboarding wizard at the result. Use of the weights is
governed by OpenBMB's published model license.

### clawd-on-desk subproject

`clawd-on-desk/` is a vendored fork that ships its own
[LICENSE](clawd-on-desk/LICENSE) (AGPL-3.0-only) and
[NOTICE.md](clawd-on-desk/NOTICE.md). The latter enumerates additional
third-party attributions (OpenClaw pixel-lobster icon under MIT,
artwork credits, etc.) — refer to that file for the authoritative list.

### Python gateway dependencies

The FastAPI gateway depends on, among others, `fastapi`, `uvicorn`,
`httpx`, and `openvino-genai`. See
[minicpm-sidecar/pyproject.toml](minicpm-sidecar/pyproject.toml) and
the generated `uv.lock` for the full transitive set and licenses.
