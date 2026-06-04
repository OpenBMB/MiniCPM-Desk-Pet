# 预构建桌宠安装包

将以下文件放到此目录，run.ps1 会优先使用本地安装包（避免运行时下载）：

- `MiniCPM-Desk-Pet-Setup-0.7.4-x64.exe` (~186MB, x64 Intel)
- `MiniCPM-Desk-Pet-Setup-0.7.4-arm64.exe` (~132MB, ARM64)

下载地址: https://github.com/OpenBMB/MiniCPM-Desk-Pet/releases/tag/v0.7.4

如果不放安装包在此目录，run.ps1 会尝试从 GitHub 下载（大陆网络可能较慢）。
