# DEPRECATED

This directory hosted the PyInstaller spec + build script for the
legacy PyTorch sidecar. It has been replaced by
[`../minicpm-sidecar/build/gateway.spec`](../minicpm-sidecar/build/gateway.spec)
and [`../minicpm-sidecar/scripts/build-gateway.sh`](../minicpm-sidecar/scripts/build-gateway.sh).

The remaining files here (`sidecar.spec`, `build-sidecar.sh`) only work
against the deprecated `minicpm-pet-bridge*/` source trees and produce
~700 MB binaries with torch baked in. Use `minicpm-sidecar/scripts/build-all.sh`
instead — it produces ~tens-of-MB binaries that load GGUF via llama.cpp.

These files will be deleted once we cut a release that no longer needs
the legacy PyTorch path as a reference.
