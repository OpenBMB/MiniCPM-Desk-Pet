"""MiniCPM sidecar gateway.

Thin FastAPI shim that talks to a vendored llama.cpp `llama-server` and
exposes the same HTTP/SSE contract the Electron app was already using
with the old PyTorch sidecar.
"""

__version__ = "0.1.0"
