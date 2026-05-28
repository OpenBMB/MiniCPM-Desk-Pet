# Build llama-server on Windows.
#
# Output:
#   bin\win-x64\llama-server.exe
#   bin\win-x64\*.dll
#   bin\win-x64\backends\vulkan\llama-server.exe  (when LLAMA_ACCEL=vulkan)
#   bin\win-x64\backends\vulkan\*.dll
#
# Honors:
#   $env:LLAMA_ACCEL = "vulkan" | "cuda" | "cpu"  (default: cpu)

$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Resolve-Path (Join-Path $here "..")
$repoRoot = Resolve-Path (Join-Path $root "..")
$src  = Join-Path $repoRoot "llama.cpp"
if (-not (Test-Path $src)) {
  Write-Error "$src not found. Run: git submodule update --init llama.cpp"
}

$accel = if ($env:LLAMA_ACCEL) { $env:LLAMA_ACCEL.ToLowerInvariant() } else { "cpu" }
$target = "win-x64"
$build = Join-Path $src "build-$target-$accel"

$flags = @(
  "-DBUILD_SHARED_LIBS=OFF",
  "-DLLAMA_BUILD_TESTS=OFF",
  "-DLLAMA_BUILD_EXAMPLES=OFF",
  "-DLLAMA_BUILD_TOOLS=ON",
  "-DLLAMA_CURL=OFF",
  # cpp-httplib auto-links OpenSSL when find_package(OpenSSL) succeeds
  # (which it does once vcpkg's spirv-headers drags it onto CMAKE_PREFIX_PATH),
  # producing a binary that depends on libcrypto-3-x64.dll / libssl-3-x64.dll.
  # We don't need HTTPS for the local-only 127.0.0.1 sidecar, and bundling
  # the vcpkg DLLs into bin/win-x64/ is fragile, so we hard-disable the
  # discovery instead. Mirrors the unix flag in build-llama.sh.
  "-DCMAKE_DISABLE_FIND_PACKAGE_OpenSSL=ON"
)
switch ($accel) {
  "vulkan" { $flags += "-DGGML_VULKAN=ON" }
  "cuda"   { $flags += "-DGGML_CUDA=ON" }
  "cpu"    { $flags += "-DGGML_VULKAN=OFF"; $flags += "-DGGML_CUDA=OFF" }
  default  { Write-Error "Unknown LLAMA_ACCEL=$accel (expected vulkan|cuda|cpu)" }
}

# Vulkan 后端需要 SPIRV-Headers 的 CMake config。LunarG 精简 SDK 不带，
# CI 通过 vcpkg 装并在 VCPKG_INSTALLED_DIR 下提供 cmake config。
if ($accel -eq "vulkan" -and $env:VCPKG_INSTALLED_DIR) {
  Write-Host "==> Using vcpkg prefix: $env:VCPKG_INSTALLED_DIR" -ForegroundColor Cyan
  $flags += "-DCMAKE_PREFIX_PATH=$env:VCPKG_INSTALLED_DIR"
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
& cmake -S $src -B $build -DCMAKE_BUILD_TYPE=Release @flags
if ($LASTEXITCODE -ne 0) { Write-Error "cmake configure failed (exit $LASTEXITCODE)" }
& cmake --build $build --target llama-server --config Release -j $jobs
if ($LASTEXITCODE -ne 0) { Write-Error "cmake build failed (exit $LASTEXITCODE)" }

$server = $null
foreach ($cand in @(
  (Join-Path $build "bin\llama-server.exe"),
  (Join-Path $build "bin\Release\llama-server.exe"),
  (Join-Path $build "Release\llama-server.exe"),
  (Join-Path $build "tools\server\Release\llama-server.exe"),
  (Join-Path $build "llama-server.exe")
)) {
  if (Test-Path $cand) { $server = $cand; break }
}
if (-not $server) { Write-Error "llama-server.exe not found in $build" }

$out = Join-Path $root "bin\$target"
if ($accel -eq "vulkan") {
  $out = Join-Path $out "backends\vulkan"
} elseif ($accel -eq "cuda") {
  $out = Join-Path $out "backends\cuda"
}
New-Item -ItemType Directory -Force -Path $out | Out-Null
Copy-Item -Force $server $out
Get-ChildItem -Path $build -Recurse -Filter *.dll | ForEach-Object {
  Copy-Item -Force $_.FullName $out
}

$cxx = Get-Command g++ -ErrorAction SilentlyContinue
if ($cxx) {
  $toolchainBin = Split-Path -Parent $cxx.Source
  foreach ($dll in @(
    "libgcc_s_seh-1.dll",
    "libstdc++-6.dll",
    "libwinpthread-1.dll",
    "libgomp-1.dll",
    "libdl.dll"
  )) {
    $runtime = Join-Path $toolchainBin $dll
    if (Test-Path $runtime) {
      Copy-Item -Force $runtime $out
    }
  }
}

Write-Host "==> OK -> $out\llama-server.exe" -ForegroundColor Green
