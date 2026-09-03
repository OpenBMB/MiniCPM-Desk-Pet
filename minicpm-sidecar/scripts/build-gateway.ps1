# Build the gateway into a single-file PyInstaller binary on Windows.
#
# Usage:
#   .\build-gateway.ps1                    # default: win-x64
#   .\build-gateway.ps1 -Target win-arm64  # ARM64
#
# Output:
#   bin\<Target>\minicpm-sidecar.exe

param(
  [string] $Target = "win-x64"
)

$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Resolve-Path (Join-Path $here "..")

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
  throw "uv not found. Install it with: irm https://astral.sh/uv/install.ps1 | iex"
}

Write-Host "==> Gateway target: $Target" -ForegroundColor Cyan

Push-Location $root
try {
  uv sync
  uv pip install "pyinstaller>=6.0"

  Remove-Item -Recurse -Force "build\build", "build\dist" -ErrorAction SilentlyContinue

  Push-Location "build"
  try {
    & "..\.venv\Scripts\pyinstaller.exe" gateway.spec `
      --distpath "..\build\dist" `
      --workpath "..\build\build" `
      --clean `
      --noconfirm
  } finally {
    Pop-Location
  }

  $out = Join-Path $root "bin\$Target"
  New-Item -ItemType Directory -Force -Path $out | Out-Null

  # onedir: the plugin DLLs sit next to the exe, so stage the whole thing.
  $src = Join-Path $root "build\dist\minicpm-sidecar"
  if (-not (Test-Path (Join-Path $src "minicpm-sidecar.exe"))) {
    throw "PyInstaller output not found: $src\minicpm-sidecar.exe"
  }

  # Copy the *contents*: `Copy-Item -Recurse $src $dst` nests when $dst
  # already exists, which silently yields minicpm-sidecar\minicpm-sidecar\.
  $dst = Join-Path $out "minicpm-sidecar"
  if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }
  New-Item -ItemType Directory -Force -Path $dst | Out-Null
  Copy-Item -Recurse -Force (Join-Path $src "*") $dst

  if (-not (Test-Path (Join-Path $dst "minicpm-sidecar.exe"))) {
    throw "staging produced the wrong layout: $dst\minicpm-sidecar.exe missing"
  }
  Write-Host "==> OK -> $dst\minicpm-sidecar.exe" -ForegroundColor Green
} finally {
  Pop-Location
}
