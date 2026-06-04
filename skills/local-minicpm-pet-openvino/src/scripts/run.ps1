$ErrorActionPreference = 'Stop'

# ── local-minicpm-pet-openvino 入口脚本 ──────────────────────────────────────
# 执行流程：解析参数 → 硬件检测 → 环境安装 → 桌宠前端启动 → 启动 client.py
#
# !! 重要 !!
# - 所有 pip 安装必须使用清华源
# - 桌宠前端使用预构建 .exe，不依赖 Node.js/npm
# - 大文件操作（模型下载、安装包）必须在持久化目录中完成

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SkillRoot = Split-Path -Parent $ScriptDir

# ── 国内源配置 ────────────────────────────────────────────────────────────────
$PipMirror = "https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple"
$PipTrustedHost = "mirrors.tuna.tsinghua.edu.cn"
$env:HF_ENDPOINT = "https://hf-mirror.com"

# ── 持久化目录 ────────────────────────────────────────────────────────────────
$OpenVinoRoot = Join-Path $env:USERPROFILE ".openvino"
$VenvRoot = Join-Path $OpenVinoRoot "venv"
$ModelsRoot = Join-Path $OpenVinoRoot "models"
$LogRoot = Join-Path $OpenVinoRoot "log"

# 确保持久化目录存在
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
        Write-Host "错误: This skill requires an Intel AIPC platform."
        Write-Host "当前硬件不满足 AIPC 要求（需要 LNL/ARL/PTL/WCL 系列 CPU），无法运行本地推理。"
        exit 1
    }
}

# ── Step 2: Python 环境安装 ──────────────────────────────────────────────────
$InfoJson = Get-Content (Join-Path $SkillRoot "info.json") | ConvertFrom-Json
$VenvName = $InfoJson.venv_name
$VenvDir = Join-Path $VenvRoot $VenvName
$Python = Join-Path $VenvDir "Scripts\python.exe"
$Pip = Join-Path $VenvDir "Scripts\pip.exe"

if (-not (Test-Path $Python)) {
    Write-Host "正在创建 Python 虚拟环境: $VenvDir ..."
    & python -m venv $VenvDir
    if ($LASTEXITCODE -ne 0) {
        Write-Host "错误: 创建虚拟环境失败。请确保已安装 Python 3.11+。"
        exit 1
    }
}

# 安装依赖（强制清华源）
$RequirementsFile = Join-Path $SkillRoot "requirements.txt"
if (Test-Path $RequirementsFile) {
    Write-Host "正在安装 Python 依赖（清华镜像源）..."
    & $Pip install -i $PipMirror --trusted-host $PipTrustedHost -r $RequirementsFile -q
    if ($LASTEXITCODE -ne 0) {
        Write-Host "警告: 部分依赖安装失败，尝试继续..."
    }
}

# ── Step 3: 桌宠前端（预构建安装包，无需 Node.js）────────────────────────────
$PetExeName = "MiniCPM Desk Pet.exe"
$PetInstallDir = Join-Path $env:LOCALAPPDATA "Programs\MiniCPM Desk Pet"
$PetExePath = Join-Path $PetInstallDir $PetExeName

# 检测桌宠是否已安装
if (-not (Test-Path $PetExePath)) {
    Write-Host "桌宠前端未安装，正在安装..."

    # 优先使用 skill 自带的安装包
    $InstallerLocal = Join-Path $SkillRoot "assets\MiniCPM-Desk-Pet-Setup-0.7.4-x64.exe"
    $InstallerFallback = Join-Path $env:USERPROFILE ".openvino\MiniCPM-Desk-Pet-Setup-0.7.4-x64.exe"

    if (Test-Path $InstallerLocal) {
        $Installer = $InstallerLocal
    } elseif (Test-Path $InstallerFallback) {
        $Installer = $InstallerFallback
    } else {
        # 从 GitHub Release 下载到持久化目录
        $DownloadUrl = "https://github.com/OpenBMB/MiniCPM-Desk-Pet/releases/download/v0.7.4/MiniCPM-Desk-Pet-Setup-0.7.4-x64.exe"
        $Installer = $InstallerFallback
        Write-Host "正在下载桌宠安装包 (~186MB)..."
        Write-Host "下载地址: $DownloadUrl"
        Write-Host "保存到: $Installer"
        Write-Host "提示: 如果下载慢，可手动下载后放到 $InstallerFallback"
        try {
            Invoke-WebRequest -Uri $DownloadUrl -OutFile $Installer -UseBasicParsing
        } catch {
            Write-Host "错误: 下载安装包失败。请手动下载并放到: $InstallerFallback"
            Write-Host "下载地址: $DownloadUrl"
            exit 1
        }
    }

    Write-Host "正在静默安装桌宠前端..."
    Start-Process -FilePath $Installer -ArgumentList "/S" -Wait
    if (-not (Test-Path $PetExePath)) {
        Write-Host "错误: 安装包执行完成，但未找到桌宠程序: $PetExePath"
        Write-Host "请检查安装是否成功，或手动安装。"
        exit 1
    }
    Write-Host "桌宠前端安装完成。"
}

# 检测并启动桌宠
$PetRunning = $false
try {
    $procs = Get-Process -Name "MiniCPM*", "Clawd*", "electron" -ErrorAction SilentlyContinue
    if ($procs) { $PetRunning = $true }
} catch {}

if (-not $PetRunning) {
    Write-Host "正在启动 MiniCPM 桌宠前端..."
    Start-Process -FilePath $PetExePath
    Start-Sleep -Seconds 5
    Write-Host "桌宠前端已启动。"
}

# ── Step 4: 启动推理 client ──────────────────────────────────────────────────
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
