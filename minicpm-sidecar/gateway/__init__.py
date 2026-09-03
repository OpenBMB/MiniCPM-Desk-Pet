"""MiniCPM sidecar gateway.

Thin FastAPI shim that runs OpenVINO in-process on an Intel GPU or NPU
and exposes the HTTP/SSE contract the Electron app speaks.
"""

__version__ = "0.1.0"
