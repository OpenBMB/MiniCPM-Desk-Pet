$ErrorActionPreference = 'Stop'

# ── local-minicpm-pet-openvino 入口脚本 ──────────────────────────────────────
# 执行流程：解析参数 → 硬件检测 → 环境安装 → 启动桌宠前端 → 启动 client.py

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SkillRoot = Split-Path -Parent $ScriptDir
$RepoRoot = (Get-Item $SkillRoot).Parent.Parent.FullName

# ── 解析参数 ─────────────────────────────────────────────────────────────────
$Prompt = ""
$Thinking = $null
$Continue = $false

for ($i = 0; $i -lt $args.Count; $i++) {
    switch ($args[$i]) {
        "--thinking"    { $Thinking = $true }
        "--no-thinking" { $Thinking = $false }
        "--continue"    { $Continue = $true }
        default {
            if (-not $Prompt) {
                $Prompt = $args[$i]
            }
        }
    }
}

if (-not $Prompt -and -not $Continue) {
    Write-Host "用法: scripts\run.ps1 `"<你的问题>`" [--thinking|--no-thinking]"
    Write-Host "      scripts\run.ps1 --continue"
    exit 1
}

# ── 硬件检测 ─────────────────────────────────────────────────────────────────
$PlatformExe = Join-Path $SkillRoot "bin\platform.exe"
if (Test-Path $PlatformExe) {
    $isAipc = & $PlatformExe --is-aipc
    if ($isAipc -ne "1") {
        Write-Host "错误: This skill requires an Intel AIPC platform."
        Write-Host "当前硬件不满足 AIPC 要求，无法运行本地推理。"
        exit 1
    }
}

# ── 环境安装 ─────────────────────────────────────────────────────────────────
$InstallEnv = Join-Path $ScriptDir "install-env.ps1"
if (Test-Path $InstallEnv) {
    & $InstallEnv
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

# ── 确定 Python 路径 ─────────────────────────────────────────────────────────
$InfoJson = Get-Content (Join-Path $SkillRoot "info.json") | ConvertFrom-Json
$VenvName = $InfoJson.venv_name
$VenvDir = Join-Path $env:USERPROFILE ".openvino\venv\$VenvName"
$Python = Join-Path $VenvDir "Scripts\python.exe"

if (-not (Test-Path $Python)) {
    Write-Host "错误: Python 虚拟环境未就绪: $VenvDir"
    Write-Host "请确保 install-env.ps1 已正确执行。"
    exit 1
}

# ── 获取桌宠代码（如果本地没有）─────────────────────────────────────────────
$PetDir = Join-Path $RepoRoot "clawd-on-desk"
$PetRepoUrl = "https://github.com/OpenBMB/MiniCPM-Desk-Pet.git"

if (-not (Test-Path (Join-Path $PetDir "package.json"))) {
    Write-Host "桌宠前端代码不在本地，正在从 GitHub 获取..."
    $gitCmd = Get-Command git -ErrorAction SilentlyContinue
    if (-not $gitCmd) {
        Write-Host "错误: 未找到 git，无法自动获取桌宠代码。"
        Write-Host "请手动执行: git clone $PetRepoUrl `"$PetDir`""
        exit 1
    }

    # clone 到 RepoRoot 下（只拉 clawd-on-desk 相关内容，shallow clone 加速）
    if (Test-Path $RepoRoot) {
        Push-Location $RepoRoot
    } else {
        New-Item -ItemType Directory -Path $RepoRoot -Force | Out-Null
        Push-Location $RepoRoot
    }

    Write-Host "git clone --depth 1 $PetRepoUrl ..."
    & git clone --depth 1 $PetRepoUrl "clawd-on-desk-repo"
    if ($LASTEXITCODE -ne 0) {
        Pop-Location
        Write-Host "错误: git clone 失败。请检查网络连接。"
        exit 1
    }

    # 把 clawd-on-desk 目录移出来
    if (Test-Path "clawd-on-desk-repo\clawd-on-desk") {
        Move-Item "clawd-on-desk-repo\clawd-on-desk" "clawd-on-desk" -Force
        Remove-Item "clawd-on-desk-repo" -Recurse -Force
    } else {
        # 如果仓库根目录就是桌宠代码
        Rename-Item "clawd-on-desk-repo" "clawd-on-desk"
    }

    Pop-Location
    Write-Host "桌宠代码获取完成。"
}

# ── 安装桌宠 npm 依赖 ─────────────────────────────────────────────────────────
if (-not (Test-Path (Join-Path $PetDir "node_modules"))) {
    Write-Host "正在安装桌宠前端依赖 (npm install)..."
    $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
    if ($npmCmd) {
        Push-Location $PetDir
        & npm install
        Pop-Location
        if ($LASTEXITCODE -ne 0) {
            Write-Host "警告: npm install 失败，桌宠前端可能无法启动。"
        } else {
            Write-Host "桌宠依赖安装完成。"
        }
    } else {
        Write-Host "警告: 未找到 npm，无法安装桌宠依赖。请手动安装 Node.js 18+。"
    }
}

# ── 启动桌宠前端（如果未在运行）─────────────────────────────────────────────
$PetRunning = $false
try {
    $electronProcs = Get-Process -Name "electron", "MiniCPM*", "Clawd*" -ErrorAction SilentlyContinue
    if ($electronProcs) { $PetRunning = $true }
} catch {}

if (-not $PetRunning -and (Test-Path (Join-Path $PetDir "package.json"))) {
    Write-Host "正在启动 MiniCPM 桌宠前端..."
    $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
    if ($npmCmd) {
        Push-Location $PetDir
        Start-Process -FilePath "npm" -ArgumentList "start" -WindowStyle Minimized
        Pop-Location
        Start-Sleep -Seconds 3
        Write-Host "桌宠前端已启动。"
    } else {
        Write-Host "提示: 未找到 npm，跳过桌宠前端启动。请手动运行: cd clawd-on-desk && npm start"
    }
}

# ── 启动 client.py ───────────────────────────────────────────────────────────
$ClientArgs = @()

if ($Continue) {
    $ClientArgs += "--continue"
} else {
    $ClientArgs += "--prompt"
    $ClientArgs += $Prompt
}

if ($null -ne $Thinking) {
    if ($Thinking) {
        $ClientArgs += "--thinking"
    } else {
        $ClientArgs += "--no-thinking"
    }
}

$ClientPy = Join-Path $ScriptDir "client.py"
& $Python $ClientPy @ClientArgs
exit $LASTEXITCODE
