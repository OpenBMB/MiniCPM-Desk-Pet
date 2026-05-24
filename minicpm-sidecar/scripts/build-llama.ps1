# Build llama-server on Windows.
#
# Output:
#   bin\win-x64\llama-server.exe
#   bin\win-x64\*.dll
#
# Honors:
#   $env:LLAMA_ACCEL = "vulkan" | "cuda" | "cpu"  (default: vulkan)

$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Resolve-Path (Join-Path $here "..")
$repoRoot = Resolve-Path (Join-Path $root "..")
$src  = Join-Path $repoRoot "llama.cpp"
$build = Join-Path $src "build"

if (-not (Test-Path $src)) {
  Write-Error "$src not found. Run: git submodule update --init llama.cpp"
}

$accel = if ($env:LLAMA_ACCEL) { $env:LLAMA_ACCEL } else { "vulkan" }
$target = "win-x64"

$flags = @(
  "-DBUILD_SHARED_LIBS=OFF",
  "-DLLAMA_BUILD_TESTS=OFF",
  "-DLLAMA_BUILD_EXAMPLES=OFF",
  "-DLLAMA_BUILD_TOOLS=ON",
  "-DLLAMA_CURL=OFF"
)
switch ($accel) {
  "vulkan" { $flags += "-DGGML_VULKAN=ON" }
  "cuda"   { $flags += "-DGGML_CUDA=ON" }
  "cpu"    { $flags += "-DGGML_VULKAN=OFF"; $flags += "-DGGML_CUDA=OFF" }
  default  { Write-Error "Unknown LLAMA_ACCEL=$accel (expected vulkan|cuda|cpu)" }
}

Write-Host "==> Target: $target   Accel: $accel" -ForegroundColor Cyan
Write-Host "==> Source: $src"      -ForegroundColor Cyan

if (-not (Get-Command cmake -ErrorAction SilentlyContinue)) {
  Write-Error "cmake not found in PATH. Install via winget/choco or Visual Studio Build Tools."
}

$jobs = if ($env:LLAMA_JOBS) { $env:LLAMA_JOBS } else {
  $ncpu = (Get-CimInstance Win32_Processor).NumberOfLogicalProcessors
  if ($env:CI -and $ncpu -gt 4) { 4 } else { $ncpu }
}
Write-Host "==> cmake build (-j$jobs)" -ForegroundColor Cyan

New-Item -ItemType Directory -Force -Path $build | Out-Null
& cmake -S $src -B $build @flags
& cmake --build $build --target llama-server --config Release -j $jobs

$server = $null
foreach ($cand in @(
  (Join-Path $build "bin\Release\llama-server.exe"),
  (Join-Path $build "Release\llama-server.exe"),
  (Join-Path $build "tools\server\Release\llama-server.exe"),
  (Join-Path $build "llama-server.exe")
)) {
  if (Test-Path $cand) { $server = $cand; break }
}
if (-not $server) { Write-Error "llama-server.exe not found in $build" }

$out = Join-Path $root "bin\$target"
New-Item -ItemType Directory -Force -Path $out | Out-Null
Copy-Item -Force $server $out
Get-ChildItem -Path $build -Recurse -Filter *.dll | ForEach-Object {
  Copy-Item -Force $_.FullName $out
}

Write-Host "==> OK -> $out\llama-server.exe" -ForegroundColor Green
