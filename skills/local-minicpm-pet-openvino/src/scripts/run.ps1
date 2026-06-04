$ErrorActionPreference = 'Stop'

# ── local-minicpm-pet-openvino 部署脚本 ──────────────────────────────────────
# 一键部署 MiniCPM 桌宠 + OpenVINO 推理后端。
# 执行流程：硬件检测 → 镜像源配置 → Python 环境 → 桌宠源码 → npm install →
#           onboarding sentinel → 启动 OpenVINO 推理服务 → 启动桌宠前端
#
# 参数:
#   --china    锁定中国大陆镜像源（GitCode/清华/淘宝/npmmirror）
#
# !! 所有大文件操作必须在沙箱外（宿主文件系统）执行 !!

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
$China = $false
$Stop = $false
$Status = $false

for ($i = 0; $i -lt $args.Count; $i++) {
    switch ($args[$i]) {
        "--china"  { $China = $true }
        "--stop"   { $Stop = $true }
        "--status" { $Status = $true }
        default {
            Write-Host "未知参数: $($args[$i])"
            Write-Host ""
            Write-Host "用法: scripts\run.ps1 [--china]        部署并启动"
            Write-Host "      scripts\run.ps1 --status         查看运行状态"
            Write-Host "      scripts\run.ps1 --stop           停止所有服务"
            Write-Host ""
            Write-Host "  --china    使用中国大陆镜像源"
            exit 1
        }
    }
}

# ── --status: 查看运行状态 ───────────────────────────────────────────────────
if ($Status) {
    Write-Host "=============================================="
    Write-Host " MiniCPM 桌宠环境状态"
    Write-Host "=============================================="
    Write-Host ""

    # 检查推理服务
    $serverUp = $false
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:18765/api/health" -TimeoutSec 3 -ErrorAction SilentlyContinue
        if ($resp.StatusCode -eq 200) {
            $health = $resp.Content | ConvertFrom-Json
            $serverUp = $true
            Write-Host "  推理服务: 运行中 (状态=$($health.status), 运行时间=$($health.uptime_s)s)"
        }
    } catch {}
    if (-not $serverUp) {
        Write-Host "  推理服务: 未运行"
    }

    # 检查桌宠前端
    $petUp = $false
    try {
        $procs = Get-Process -Name "electron", "MiniCPM*", "Clawd*" -ErrorAction SilentlyContinue
        if ($procs) { $petUp = $true }
    } catch {}
    if ($petUp) {
        Write-Host "  桌宠前端: 运行中"
    } else {
        Write-Host "  桌宠前端: 未运行"
    }

    Write-Host ""
    exit 0
}

# ── --stop: 停止所有服务 ─────────────────────────────────────────────────────
if ($Stop) {
    Write-Host "正在停止 MiniCPM 桌宠环境..."
    Write-Host ""

    # 停止推理服务
    $serverStopped = $false
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:18765/api/shutdown" -Method POST -TimeoutSec 5 -ErrorAction SilentlyContinue
        if ($resp.StatusCode -eq 200) {
            $serverStopped = $true
            Write-Host "  推理服务: 已发送停止信号"
        }
    } catch {}
    if (-not $serverStopped) {
        Write-Host "  推理服务: 未在运行（或已停止）"
    }

    # 停止桌宠前端
    try {
        $procs = Get-Process -Name "electron", "MiniCPM*", "Clawd*" -ErrorAction SilentlyContinue
        if ($procs) {
            $procs | Stop-Process -Force
            Write-Host "  桌宠前端: 已停止"
        } else {
            Write-Host "  桌宠前端: 未在运行"
        }
    } catch {
        Write-Host "  桌宠前端: 停止失败 ($_)"
    }

    Write-Host ""
    Write-Host "全部已停止。"
    exit 0
}

# ── Step 1: 硬件检测 ─────────────────────────────────────────────────────────
Write-Host "=============================================="
Write-Host " MiniCPM 桌宠 + OpenVINO 后端 部署工具"
Write-Host "=============================================="
Write-Host ""

$PlatformExe = Join-Path $SkillRoot "bin\platform.exe"
if (Test-Path $PlatformExe) {
    Write-Host "[Step 1] 检测 Intel AIPC 硬件..."
    $isAipc = & $PlatformExe --is-aipc
    if ($isAipc -ne "1") {
        Write-Host "错误: 需要 Intel AIPC 平台（LNL/ARL/PTL/WCL）。"
        exit 1
    }
    Write-Host "硬件检测通过。"
} else {
    Write-Host "[Step 1] 跳过硬件检测（未找到 platform.exe）"
}

# ── Step 2: 配置镜像源 ───────────────────────────────────────────────────────
if ($China) {
    Write-Host ""
    Write-Host "[Step 2] 已启用中国大陆镜像源模式 (--china)"
    $env:PIP_INDEX_URL = "https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple"
    $env:PIP_TRUSTED_HOST = "mirrors.tuna.tsinghua.edu.cn"
    $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
    $env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
    $env:HF_ENDPOINT = "https://hf-mirror.com"
} else {
    Write-Host ""
    Write-Host "[Step 2] 使用默认源（海外/可直连环境）"
}

# ── Step 3: Python 环境 + 推理依赖 ──────────────────────────────────────────
Write-Host ""
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
} else {
    Write-Host "[Step 3] Python 虚拟环境已存在，跳过创建。"
}

$RequirementsFile = Join-Path $SkillRoot "requirements.txt"
if (Test-Path $RequirementsFile) {
    Write-Host "[Step 3] 正在安装 Python 依赖..."
    if ($China) {
        & $Pip install -i $env:PIP_INDEX_URL --trusted-host $env:PIP_TRUSTED_HOST -r $RequirementsFile -q
    } else {
        & $Pip install -r $RequirementsFile -q
    }
    if ($LASTEXITCODE -ne 0) {
        Write-Host "警告: 部分依赖安装失败，尝试继续..."
    } else {
        Write-Host "Python 依赖安装完成。"
    }
}

# ── Step 4: 获取桌宠源码 ─────────────────────────────────────────────────────
Write-Host ""
$PetDir = Join-Path $SkillRoot "..\..\clawd-on-desk"
$PetDir = [System.IO.Path]::GetFullPath($PetDir)
$PetRepoUrl_GitCode = "https://gitcode.com/OpenBMB/MiniCPM-Desk-Pet.git"
$PetRepoUrl_GitHub = "https://github.com/OpenBMB/MiniCPM-Desk-Pet.git"

if (-not (Test-Path (Join-Path $PetDir "package.json"))) {
    Write-Host "[Step 4] 桌宠源码不在本地，正在获取..."
    $gitCmd = Get-Command git -ErrorAction SilentlyContinue
    if (-not $gitCmd) {
        Write-Host "错误: 未找到 git。请先安装 git。"
        exit 1
    }

    $ParentDir = Split-Path -Parent $PetDir
    if (-not (Test-Path $ParentDir)) {
        New-Item -ItemType Directory -Path $ParentDir -Force | Out-Null
    }

    Push-Location $ParentDir

    if ($China) {
        Write-Host "git clone --depth 1 $PetRepoUrl_GitCode（国内镜像）..."
        & git clone --depth 1 $PetRepoUrl_GitCode "clawd-on-desk-repo"
        if ($LASTEXITCODE -ne 0) {
            Pop-Location
            Write-Host "错误: GitCode clone 失败。请检查网络连接。"
            exit 1
        }
    } else {
        Write-Host "git clone --depth 1 $PetRepoUrl_GitHub ..."
        & git clone --depth 1 $PetRepoUrl_GitHub "clawd-on-desk-repo" 2>$null
        if ($LASTEXITCODE -ne 0) {
            Write-Host "GitHub 不可用，尝试 GitCode 国内镜像..."
            & git clone --depth 1 $PetRepoUrl_GitCode "clawd-on-desk-repo"
        }
        if ($LASTEXITCODE -ne 0) {
            Pop-Location
            Write-Host "错误: git clone 失败（GitHub 和 GitCode 均不可用）。"
            exit 1
        }
    }

    if (Test-Path "clawd-on-desk-repo\clawd-on-desk") {
        Move-Item "clawd-on-desk-repo\clawd-on-desk" "clawd-on-desk" -Force
        Remove-Item "clawd-on-desk-repo" -Recurse -Force
    } else {
        Rename-Item "clawd-on-desk-repo" "clawd-on-desk"
    }
    Pop-Location
    Write-Host "桌宠源码获取完成。"
} else {
    Write-Host "[Step 4] 桌宠源码已存在，跳过获取。"
}

# ── Step 5: 安装桌宠 npm 依赖 ─────────────────────────────────────────────────
Write-Host ""
if (-not (Test-Path (Join-Path $PetDir "node_modules"))) {
    $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
    if (-not $npmCmd) {
        Write-Host "错误: 未找到 npm。请先安装 Node.js 18+。"
        exit 1
    }

    Push-Location $PetDir
    if ($China) {
        Write-Host "[Step 5] 正在安装桌宠 npm 依赖（淘宝镜像源）..."
        & npm config set registry https://registry.npmmirror.com
    } else {
        Write-Host "[Step 5] 正在安装桌宠 npm 依赖..."
    }
    & npm install
    Pop-Location
    if ($LASTEXITCODE -ne 0) {
        Write-Host "警告: npm install 可能未完全成功，尝试继续..."
    } else {
        Write-Host "桌宠 npm 依赖安装完成。"
    }
} else {
    Write-Host "[Step 5] node_modules 已存在，跳过 npm install。"
}

# ── Step 6: 预写 Onboarding Sentinel（跳过引导界面）──────────────────────────
Write-Host ""
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
} else {
    Write-Host "[Step 6] Onboarding sentinel 已存在，跳过。"
}

$ModelDir = Join-Path $ModelsRoot $InfoJson.models[0].dir_name
if (-not (Test-Path $ModelDir)) {
    New-Item -ItemType Directory -Path $ModelDir -Force | Out-Null
}

# ── Step 7: 启动 OpenVINO 推理服务 ──────────────────────────────────────────
Write-Host ""
Write-Host "[Step 7] 启动 OpenVINO 推理服务（端口 18765）..."

$ServerPort = 18765
$ServerAlreadyRunning = $false
try {
    $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$ServerPort/api/health" -TimeoutSec 3 -ErrorAction SilentlyContinue
    if ($resp.StatusCode -eq 200) {
        $ServerAlreadyRunning = $true
    }
} catch {}

if (-not $ServerAlreadyRunning) {
    $ServerPy = Join-Path $ScriptDir "server.py"
    Start-Process -FilePath $Python -ArgumentList $ServerPy -WindowStyle Minimized
    Write-Host "推理服务已启动，正在后台加载模型..."

    # 等待服务就绪（最多 60 秒检测健康状态）
    $deadline = (Get-Date).AddSeconds(60)
    $ready = $false
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 2
        try {
            $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$ServerPort/api/health" -TimeoutSec 3 -ErrorAction SilentlyContinue
            if ($resp.StatusCode -eq 200) {
                $health = $resp.Content | ConvertFrom-Json
                if ($health.status -eq "ok" -or $health.status -eq "downloading") {
                    $ready = $true
                    break
                }
            }
        } catch {}
    }
    if ($ready) {
        Write-Host "推理服务已启动。模型状态: $($health.status)"
    } else {
        Write-Host "警告: 推理服务启动超时，桌宠可能暂时无法推理。"
    }
} else {
    Write-Host "推理服务已在运行中，跳过启动。"
}

# ── Step 8: 启动桌宠前端 ─────────────────────────────────────────────────────
Write-Host ""
$PetRunning = $false
try {
    $procs = Get-Process -Name "electron", "MiniCPM*", "Clawd*" -ErrorAction SilentlyContinue
    if ($procs) { $PetRunning = $true }
} catch {}

if (-not $PetRunning) {
    Write-Host "[Step 8] 正在启动桌宠前端 (npm start)..."
    $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
    if ($npmCmd) {
        # 设置后端标识：前端读到此变量时隐藏 CPU/Vulkan 设备选择
        $env:MINICPM_BACKEND = "openvino"

        Push-Location $PetDir
        Start-Process -FilePath "npm" -ArgumentList "start" -WindowStyle Minimized
        Pop-Location
        Start-Sleep -Seconds 3
        Write-Host "桌宠前端已启动（后端模式: OpenVINO）。"
    } else {
        Write-Host "警告: 未找到 npm，无法启动桌宠前端。"
    }
} else {
    Write-Host "[Step 8] 桌宠前端已在运行中，跳过启动。"
}

# ── 部署完成 ─────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "=============================================="
Write-Host " 部署完成！"
Write-Host "=============================================="
Write-Host ""
Write-Host "  推理服务: http://127.0.0.1:$ServerPort"
Write-Host "  桌宠前端: 已在前台运行"
Write-Host ""
Write-Host "  现在可以直接与桌宠对话了。"
Write-Host "  如需停止推理服务: curl http://127.0.0.1:$ServerPort/api/shutdown"
Write-Host ""
