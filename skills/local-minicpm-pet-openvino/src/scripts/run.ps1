$ErrorActionPreference = 'Stop'

# ── local-minicpm-pet-openvino 入口脚本 ──────────────────────────────────────
# 面向 Intel 合作方开发者的开发环境 Skill。
# 执行流程：硬件检测 → 国内源配置 → Python 环境 → 桌宠源码 → npm install →
#           onboarding sentinel → 启动桌宠前端 → 启动推理 client
#
# !! 所有大文件操作必须在沙箱外（宿主文件系统）执行 !!
# !! 所有网络操作必须使用国内镜像源 !!

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SkillRoot = Split-Path -Parent $ScriptDir

# ── 持久化根目录 ─────────────────────────────────────────────────────────────
$OpenVinoRoot = Join-Path $env:USERPROFILE ".openvino"
$VenvRoot = Join-Path $OpenVinoRoot "venv"
$ModelsRoot = Join-Path $OpenVinoRoot "models"
$LogRoot = Join-Path $OpenVinoRoot "log"

foreach ($dir in @($OpenVinoRoot, $VenvRoot, $ModelsRoot, $LogRoot)) {
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
}

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

# ── Step 1: 硬件检测 ─────────────────────────────────────────────────────────
$PlatformExe = Join-Path $SkillRoot "bin\platform.exe"
if (Test-Path $PlatformExe) {
    $isAipc = & $PlatformExe --is-aipc
    if ($isAipc -ne "1") {
        Write-Host "错误: This skill requires an Intel AIPC platform (LNL/ARL/PTL/WCL)."
        Write-Host "当前硬件不满足 AIPC 要求，无法运行本地推理。"
        exit 1
    }
}

# ── Step 2: 配置国内源（全局环境变量，影响后续所有操作）─────────────────────
$env:PIP_INDEX_URL = "https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple"
$env:PIP_TRUSTED_HOST = "mirrors.tuna.tsinghua.edu.cn"
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
$env:HF_ENDPOINT = "https://hf-mirror.com"

# ── Step 3: Python 环境 + 推理依赖 ──────────────────────────────────────────
$InfoJson = Get-Content (Join-Path $SkillRoot "info.json") | ConvertFrom-Json
$VenvName = $InfoJson.venv_name
$VenvDir = Join-Path $VenvRoot $VenvName
$Python = Join-Path $VenvDir "Scripts\python.exe"
$Pip = Join-Path $VenvDir "Scripts\pip.exe"

if (-not (Test-Path $Python)) {
    Write-Host "[Step 3] 正在创建 Python 虚拟环境: $VenvDir ..."
    & python -m venv $VenvDir
    if ($LASTEXITCODE -ne 0) {
        Write-Host "错误: 创建虚拟环境失败。请确保已安装 Python 3.11+。"
        Write-Host "验证: python --version"
        exit 1
    }
}

$RequirementsFile = Join-Path $SkillRoot "requirements.txt"
if (Test-Path $RequirementsFile) {
    Write-Host "[Step 3] 正在安装 Python 依赖（清华镜像源）..."
    & $Pip install -i $env:PIP_INDEX_URL --trusted-host $env:PIP_TRUSTED_HOST -r $RequirementsFile -q
    if ($LASTEXITCODE -ne 0) {
        Write-Host "警告: 部分依赖安装失败，尝试继续..."
    }
}

# ── Step 4: 获取桌宠源码 ─────────────────────────────────────────────────────
$PetDir = Join-Path $SkillRoot "..\..\clawd-on-desk"
$PetDir = [System.IO.Path]::GetFullPath($PetDir)
$PetRepoUrl_GitCode = "https://gitcode.com/OpenBMB/MiniCPM-Desk-Pet.git"
$PetRepoUrl_GitHub = "https://github.com/OpenBMB/MiniCPM-Desk-Pet.git"

if (-not (Test-Path (Join-Path $PetDir "package.json"))) {
    Write-Host "[Step 4] 桌宠源码不在本地，正在获取..."
    $gitCmd = Get-Command git -ErrorAction SilentlyContinue
    if (-not $gitCmd) {
        Write-Host "错误: 未找到 git。请先安装 git。"
        Write-Host "验证: git --version"
        exit 1
    }

    $ParentDir = Split-Path -Parent $PetDir
    if (-not (Test-Path $ParentDir)) {
        New-Item -ItemType Directory -Path $ParentDir -Force | Out-Null
    }

    Push-Location $ParentDir

    # 优先使用 GitCode 国内镜像，失败后回退 GitHub
    Write-Host "git clone --depth 1 $PetRepoUrl_GitCode（国内镜像）..."
    & git clone --depth 1 $PetRepoUrl_GitCode "clawd-on-desk-repo" 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "GitCode 镜像不可用，尝试 GitHub..."
        & git clone --depth 1 $PetRepoUrl_GitHub "clawd-on-desk-repo"
    }
    if ($LASTEXITCODE -ne 0) {
        Pop-Location
        Write-Host "错误: git clone 失败（GitCode 和 GitHub 均不可用）。请检查网络连接。"
        exit 1
    }

    if (Test-Path "clawd-on-desk-repo\clawd-on-desk") {
        Move-Item "clawd-on-desk-repo\clawd-on-desk" "clawd-on-desk" -Force
        Remove-Item "clawd-on-desk-repo" -Recurse -Force
    } else {
        Rename-Item "clawd-on-desk-repo" "clawd-on-desk"
    }
    Pop-Location
    Write-Host "桌宠源码获取完成。"
}

# ── Step 5: 安装桌宠 npm 依赖（淘宝源 + Electron 镜像）─────────────────────
if (-not (Test-Path (Join-Path $PetDir "node_modules"))) {
    Write-Host "[Step 5] 正在安装桌宠 npm 依赖（淘宝镜像源）..."
    $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
    if (-not $npmCmd) {
        Write-Host "错误: 未找到 npm。请先安装 Node.js 18+。"
        Write-Host "验证: node --version"
        exit 1
    }

    Push-Location $PetDir
    & npm config set registry https://registry.npmmirror.com
    & npm install
    Pop-Location
    if ($LASTEXITCODE -ne 0) {
        Write-Host "警告: npm install 可能未完全成功，尝试继续..."
    } else {
        Write-Host "桌宠 npm 依赖安装完成。"
    }
}

# ── Step 6: 预写 Onboarding Sentinel（跳过引导界面）──────────────────────────
# 桌宠首次启动会进入 onboarding 引导下载模型，但我们的模型由 server.py 管理，
# 所以需要预写 sentinel 文件让桌宠跳过 onboarding。
$UserDataDir = Join-Path $env:APPDATA "Clawd on Desk"
if (-not (Test-Path $UserDataDir)) {
    New-Item -ItemType Directory -Path $UserDataDir -Force | Out-Null
}

$SentinelFile = Join-Path $UserDataDir "minicpm-onboarding.json"
if (-not (Test-Path $SentinelFile)) {
    Write-Host "[Step 6] 写入 onboarding sentinel（跳过引导界面）..."
    $sentinel = @{
        complete = $true
        version = 1
        ts = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
        source = "local-minicpm-pet-openvino skill"
    } | ConvertTo-Json
    Set-Content -Path $SentinelFile -Value $sentinel -Encoding UTF8
}

# 确保模型目录存在（防止 isModelPresent() 触发 onboarding）
$ModelDir = Join-Path $ModelsRoot $InfoJson.models[0].dir_name
if (-not (Test-Path $ModelDir)) {
    New-Item -ItemType Directory -Path $ModelDir -Force | Out-Null
}

# ── Step 7: 启动桌宠前端（如果未在运行）─────────────────────────────────────
$PetRunning = $false
try {
    $procs = Get-Process -Name "electron", "MiniCPM*", "Clawd*" -ErrorAction SilentlyContinue
    if ($procs) { $PetRunning = $true }
} catch {}

if (-not $PetRunning) {
    Write-Host "[Step 7] 正在启动桌宠前端 (npm start)..."
    $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
    if ($npmCmd) {
        Push-Location $PetDir
        Start-Process -FilePath "npm" -ArgumentList "start" -WindowStyle Minimized
        Pop-Location
        Start-Sleep -Seconds 5
        Write-Host "桌宠前端已启动（已跳过 onboarding）。"
    } else {
        Write-Host "警告: 未找到 npm，无法启动桌宠前端。"
    }
}

# ── Step 8: 启动推理 client ──────────────────────────────────────────────────
Write-Host "[Step 8] 启动 OpenVINO 推理..."
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
