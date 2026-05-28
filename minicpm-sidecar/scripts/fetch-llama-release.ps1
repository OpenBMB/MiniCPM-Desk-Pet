# Download the official llama.cpp llama-server binary for Windows.
#
# Output:
#   bin\win-x64\llama-server.exe
#   bin\win-x64\*.dll
#   bin\win-x64\backends\vulkan\llama-server.exe  (with -Backend vulkan)
#   bin\win-x64\backends\vulkan\*.dll
#
# Honors:
#   $env:LLAMA_CPP_RELEASE = b9371 by default

param(
  [ValidateSet("cpu", "vulkan")]
  [string] $Backend = "cpu",
  [string] $Target = "win-x64",
  [string] $Tag = $(if ($env:LLAMA_CPP_RELEASE) { $env:LLAMA_CPP_RELEASE } else { "b9371" }),
  [string] $OutDir = ""
)

$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Resolve-Path (Join-Path $here "..")

switch ("$Target/$Backend") {
  "win-x64/cpu"    { $asset = "llama-$Tag-bin-win-cpu-x64.zip" }
  "win-x64/vulkan" { $asset = "llama-$Tag-bin-win-vulkan-x64.zip" }
  "win-arm64/cpu"  { $asset = "llama-$Tag-bin-win-cpu-arm64.zip" }
  default { throw "Unsupported Target/Backend: $Target/$Backend" }
}

if (-not $OutDir) {
  $OutDir = Join-Path $root "bin\$Target"
  if ($Backend -eq "vulkan") {
    $OutDir = Join-Path $OutDir "backends\vulkan"
  }
}

$url = "https://github.com/ggml-org/llama.cpp/releases/download/$Tag/$asset"
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("minicpm-llama-" + [System.Guid]::NewGuid().ToString("N"))
$archive = Join-Path $tmp $asset
$extract = Join-Path $tmp "extract"

Write-Host "==> Fetch official llama.cpp ${Tag}: $asset" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $tmp, $extract, $OutDir | Out-Null

try {
  Invoke-WebRequest -Uri $url -OutFile $archive
  Expand-Archive -Path $archive -DestinationPath $extract -Force

  $server = Get-ChildItem -Path $extract -Recurse -Filter "llama-server.exe" |
    Select-Object -First 1
  if (-not $server) {
    throw "llama-server.exe not found in $asset"
  }

  $releaseRoot = $server.Directory.FullName
  while ((Split-Path -Parent $releaseRoot) -ne $extract -and $releaseRoot -ne $extract) {
    $releaseRoot = Split-Path -Parent $releaseRoot
  }

  Copy-Item -Path (Join-Path $releaseRoot "*") -Destination $OutDir -Recurse -Force
  $outServer = Join-Path $OutDir "llama-server.exe"
  if (-not (Test-Path $outServer)) {
    Copy-Item -Path (Join-Path $server.Directory.FullName "*") -Destination $OutDir -Recurse -Force
  }
  if (-not (Test-Path $outServer)) {
    throw "copy failed: $outServer missing"
  }

  Write-Host "==> OK -> $outServer" -ForegroundColor Green
  & $outServer --version
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
