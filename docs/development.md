# 开发者指南

> 普通用户请直接下载 dmg 安装包（参见 [README.md](../README.md)），跟着应用首次启动的 Onboarding 引导走即可。本文档只面向需要改代码 / 调试 / 出包的开发者。

---

## 目录

- [快速上手 (dev 模式)](#快速上手-dev-模式)
- [仓库结构](#仓库结构)
- [打包：从源码到 dmg](#打包从源码到-dmg)
- [Onboarding 流程的开发要点](#onboarding-流程的开发要点)
- [常用调试技巧](#常用调试技巧)

---

## 快速上手 (dev 模式)

```bash
git clone git@github.com:OpenBMB/MiniCPM-Desk-Pet.git
cd MiniCPM-Desk-Pet

# 把模型放进来 (~2 GB，跟生产用户不一样的是：dev 模式仍然走 <repo>/models/)
mkdir -p models
ln -s /absolute/path/to/your/minicpm5-0.9b models/minicpm5-0.9b
# 或者 cp -r

./go.sh                  # 自动安装依赖 + 启动
```

`./go.sh doctor` 单独检查环境是否 OK；`./go.sh setup` 只装依赖不启动。

### 跳过 Onboarding（开发者特权）

第一次启动会弹 Onboarding 向导。如果你已经放好了模型，可以一路点过去（环境检查会自动通过；模型下载步骤会识别本地路径，直接显示 "已存在"）。

如果想让某次启动绕开向导（比如调试 settings tab）：

```bash
# Onboarding sentinel 写在 userData 下
rm "$HOME/Library/Application Support/Clawd on Desk/minicpm-onboarding.json"

# 或反向：强制再次显示
MINICPM_FORCE_ONBOARDING=1 ./go.sh start
```

---

## 仓库结构

```
MiniCPM-Desk-Pet/
├── clawd-on-desk/              ← Electron 桌宠 (vendored fork of clawd-on-desk@5b1f003)
│                                  + MiniCPM 集成层：聊天气泡 / Onboarding / Settings
├── minicpm-sidecar/            ← llama.cpp 推理服务 + 瘦 FastAPI gateway
├── adapters/                   ← LoRA 适配器（.gguf + safetensors source）
├── skills/deploy-minicpm-pet/  ← Cursor Agent Skill（dev 部署引导）
├── docs/                       ← 开发者文档，归档调研在 docs/archive/
├── models/                     ← GGUF 模型文件（gitignored）
├── go.sh                       ← 开发者快捷脚本
└── README.md                   ← 用户向（dmg 安装 + 引导）
```

> v0.7 时代的双份 PyTorch sidecar（`minicpm-pet-bridge/` 与 `minicpm-pet-bridge-uv/`）以及 PyInstaller `build/sidecar.spec` 已在 v0.9 删除。如需历史信息，参考 [docs/archive/](archive/) 与 [docs/llama-cpp-migration.md](llama-cpp-migration.md)。

---

## 打包：从源码到 dmg

最终用户拿到的 dmg 内含：
- Electron 主程序（clawd-on-desk）
- PyInstaller 打的 sidecar 二进制（无需用户装 Python）
- LoRA 适配器（adapters/）
- sidecar 源码（备用 / debug 用）

模型权重 **不** 在 dmg 里——首次启动由 Onboarding 引导用户下载到 `<userData>/models/`。

### 单步出包

```bash
./go.sh build
```

等价于：

```bash
# 1. 编 llama-server + uv sync gateway + PyInstaller 打 gateway（首次 ~10 分钟）
cd minicpm-sidecar && ./scripts/build-all.sh && cd ..

# 2. electron-builder 出 dmg
cd clawd-on-desk
npx electron-builder --mac --arm64 -c.mac.target=dmg
```

产物位置：`clawd-on-desk/dist/*.dmg`。

### 仅重打 dmg（不重跑 PyInstaller）

修改 Electron 端代码 / package.json 后，sidecar binary 不需要重打：

```bash
cd clawd-on-desk && npm run build:mac:repack
```

### 当前打包限制 (MVP)

- 仅 **mac arm64**；Intel / Windows / Linux 暂未支持
- 如果开发机钥匙串里有 Apple Developer ID 证书，electron-builder 会自动签名 .app（产物级别 `codesign --display` 能看到 Developer ID Authority）；否则保持未签名
- 即便 .app 签了名，**dmg 本身没签名 + 未公证**：首次启动 Gatekeeper 仍会弹"无法验证开发者"
  - 用户绕开方式：右键 → 打开 → 确认；或终端执行 `xattr -cr /Applications/Clawd\ on\ Desk.app`
- 没接 `electron-updater` 自动更新
- 模型下载源仅 Hugging Face（ModelScope 备用源待开发）

### 国内网络打包注意事项

GitHub Release 资源（electron 二进制、dmg-builder bundle）国内拉取容易超时。两个加速套路：

**1. npm 镜像** — 装依赖时走淘宝源：

```bash
cd clawd-on-desk
npm install --no-audit --no-fund \
  --registry=https://registry.npmmirror.com \
  --electron_mirror=https://registry.npmmirror.com/-/binary/electron/
```

**2. 代理** — electron-builder 在 `dmg-builder@1.2.0/dmgbuild-bundle-arm64-*.tar.gz` 这个 GitHub Release 资源上没有官方镜像配置，必须给整个 build 过程开代理：

```bash
# .zshrc 里有 proxy 函数（http://127.0.0.1:10808）
proxy
cd clawd-on-desk && npx electron-builder --mac --arm64 -c.mac.target=dmg
```

或者直接 inline：

```bash
cd clawd-on-desk && \
  https_proxy=http://127.0.0.1:10808 http_proxy=http://127.0.0.1:10808 \
  npx electron-builder --mac --arm64 -c.mac.target=dmg
```

如果代理也不稳，可以先手动把 dmg-builder bundle 下到 cache：

```bash
CACHE="$HOME/Library/Caches/electron-builder/dmg-builder@1.2.0"
mkdir -p "$CACHE"
https_proxy=http://127.0.0.1:10808 curl -L --retry 5 -o "$CACHE/dmgbuild-bundle-arm64-75c8a6c.tar.gz" \
  "https://github.com/electron-userland/electron-builder-binaries/releases/download/dmg-builder@1.2.0/dmgbuild-bundle-arm64-75c8a6c.tar.gz"
```

下完后再跑 build。electron-builder 看到目标 archive 已在 cache 就跳过下载。

---

## Onboarding 流程的开发要点

Onboarding 是 5 步状态机，主进程 + 渲染端代码分布如下：

| 文件 | 责任 |
|------|------|
| [`clawd-on-desk/src/minicpm-onboarding.js`](../clawd-on-desk/src/minicpm-onboarding.js) | 主进程：BrowserWindow 管理 + IPC handlers + sentinel 文件读写 |
| [`clawd-on-desk/src/minicpm-onboarding.html`](../clawd-on-desk/src/minicpm-onboarding.html) | 5 个 panel 的静态结构 |
| [`clawd-on-desk/src/minicpm-onboarding.css`](../clawd-on-desk/src/minicpm-onboarding.css) | 暗 / 亮主题样式 |
| [`clawd-on-desk/src/minicpm-onboarding-renderer.js`](../clawd-on-desk/src/minicpm-onboarding-renderer.js) | 渲染端：步骤切换、进度条、SSE 消费 |
| [`clawd-on-desk/src/preload-minicpm-onboarding.js`](../clawd-on-desk/src/preload-minicpm-onboarding.js) | contextBridge → `window.onboarding` |

主进程接入位置：[`src/main.js` `app.whenReady()` 中部](../clawd-on-desk/src/main.js) — 通过 `_minicpmOnboarding.shouldShow()` 决定是先弹向导还是直接弹桌宠。

### 完成标志（sentinel）

`<userData>/minicpm-onboarding.json` 写入 `{complete: true, version: 1, completedAt: <iso>, device: <picked>}` 即视为已完成。删除该文件可强制重弹（也可通过 Settings → 🐾 MiniCPM → 高级 / 开发 触发）。

### 调试单步

```js
// devtools 在 onboarding 窗口里直接调用，无需走全流程
await window.onboarding.listDevices()
await window.onboarding.checkDisk()
await window.onboarding.warmup()
```

---

## 常用调试技巧

### 看 sidecar 实时日志

```bash
# dev 模式：Electron 的 stdout 已转发 [sidecar] 前缀的行
./go.sh start

# packaged 模式：sidecar stderr 写入 Electron 主进程日志
tail -f "$HOME/Library/Application Support/Clawd on Desk/logs/"main.log
```

### 直接 curl sidecar

```bash
curl -s http://127.0.0.1:18765/api/health | python3 -m json.tool
curl -s http://127.0.0.1:18765/api/devices | python3 -m json.tool
curl -s http://127.0.0.1:18765/api/onboarding | python3 -m json.tool
curl -X POST http://127.0.0.1:18765/api/set-device -H 'content-type: application/json' -d '{"device":"cpu"}'
```

### 端口冲突

```bash
lsof -ti:18765 | xargs -r kill -9   # sidecar
lsof -ti:23333 | xargs -r kill -9  # clawd HTTP server
```

### 完全重置用户数据（小心，会丢失模型和对话历史）

```bash
rm -rf "$HOME/Library/Application Support/Clawd on Desk/"
```
