# Build the gateway into a single-file PyInstaller binary on Windows.
#
# Output:
#   bin\win-x64\minicpm-sidecar.exe

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

  $src = Join-Path $root "build\dist\minicpm-sidecar.exe"
  if (-not (Test-Path $src)) {
    throw "PyInstaller output not found: $src"
  }

  Copy-Item -Force $src (Join-Path $out "minicpm-sidecar.exe")
  Write-Host "==> OK -> $out\minicpm-sidecar.exe" -ForegroundColor Green
} finally {
  Pop-Location
}
