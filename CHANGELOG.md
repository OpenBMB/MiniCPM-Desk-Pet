# v0.9 — 2026-05-22

## 主线：仓库目录大扫除 + 开源就绪

### 移除

- 整体删除 v0.8 标记为 DEPRECATED 的 `minicpm-pet-bridge/`、`minicpm-pet-bridge-uv/`、`build/` 三个目录（v2 LoRA 已通过 GGUF 路径在 v0.8 末期落地，旧 PyTorch 源码不再需要保留作为参考）。
- 删除根目录残留的 `state.js`（与 [`clawd-on-desk/src/state.js`](clawd-on-desk/src/state.js) 重复且过期）。
- 清理 `models/` 下的失效绝对路径符号链接，保留空目录占位。

### 新增

- 根级 [`LICENSE`](LICENSE)（AGPL-3.0-only，与 `clawd-on-desk/LICENSE` 同源）。
- 根级 [`NOTICE.md`](NOTICE.md)：fork 声明 + llama.cpp / MiniCPM / OpenClaw 等第三方 attribution。
- 根级 [`CONTRIBUTING.md`](CONTRIBUTING.md)：quickstart、测试要求、commit / PR 约定。
- [`docs/archive/`](docs/archive/) 子目录，迁入 v0.7 时代的设计文档（[PRD-sidecar-cross-platform-refactor.md](docs/archive/PRD-sidecar-cross-platform-refactor.md)、[architecture-and-cross-platform-report.md](docs/archive/architecture-and-cross-platform-report.md)），并附 [`README.md`](docs/archive/README.md) 解释归档背景。

### 变更

- [`README.md`](README.md) 删除 deprecated 目录段落，文档索引指向归档后的新路径，新增 CONTRIBUTING 链接。
- [`docs/development.md`](docs/development.md) 删除 conda 路径、双份 sidecar 同步注意事项、旧 `build/build-sidecar.sh` 引用；"仓库结构"框图按新平铺布局重写。
- [`docs/llama-cpp-migration.md`](docs/llama-cpp-migration.md) 旧 PyTorch sidecar / PyInstaller 路径改为历史叙述。
- [`skills/deploy-minicpm-pet/SKILL.md`](skills/deploy-minicpm-pet/SKILL.md) 完整改写：所有 `minicpm-pet-bridge*` 引用替换为 `minicpm-sidecar`，安装步骤更新到 cmake + uv + 几十 MB gateway。
- [`.gitignore`](.gitignore) 删除 `build/*` 历史例外规则。

# v0.8 — 2026-05-20

## 重构主线：推理后端 PyTorch → llama.cpp，删除两套 bridge 合一

### 新增

- 单一推理目录 [`minicpm-sidecar/`](minicpm-sidecar/)，结构为「llama-server（vendor llama.cpp）+ 瘦 FastAPI gateway」。
- vendor 子模块脚本 [`scripts/clone-llama.sh`](minicpm-sidecar/scripts/clone-llama.sh)（pin 在 [zhangtao2-1/llama.cpp@c5ede29](https://github.com/zhangtao2-1/llama.cpp)，即 [PR #23384](https://github.com/ggml-org/llama.cpp/pull/23384) 的 MiniCPM5 tokenizer 提交）。
- 各平台编译脚本：`scripts/build-llama.sh`（macOS / Linux）+ `scripts/build-llama.ps1`（Windows），按 `LLAMA_ACCEL=metal|cuda|cpu` 走 cmake。
- Gateway PyInstaller 单文件打包：`scripts/build-gateway.sh` + [`build/gateway.spec`](minicpm-sidecar/build/gateway.spec)，无 torch 依赖，最终二进制几十 MB 量级。
- `scripts/build-all.sh` / `scripts/run-dev.sh` 一站式入口。
- GitHub Actions：
  - [`.github/workflows/build-sidecar.yml`](.github/workflows/build-sidecar.yml) — 四平台矩阵编 sidecar artifact
  - [`.github/workflows/release.yml`](.github/workflows/release.yml) — tag push 触发，每平台 inline 编 sidecar + electron-builder 出安装包
- Gateway / Electron 双侧单元测试：think 块拆分、GGUF 模型扫描、Electron 三个 locator 函数。

### 变更

- [`clawd-on-desk/src/minicpm-chat.js`](clawd-on-desk/src/minicpm-chat.js) spawn 大幅简化：删除 conda / uv-venv 三路径查找 + `/bin/bash` viaShell 分支，只保留「packaged binary」与「dev 下 `MINICPM_SIDECAR_DIR + .venv/bin/python -m gateway`」两种模式；移除 `PYTORCH_ENABLE_MPS_FALLBACK` 与 `MINICPM_ADAPTER` 自动发现。
- [`clawd-on-desk/package.json`](clawd-on-desk/package.json) `extraResources`：从打包 `minicpm-pet-bridge-uv/` 源码 + `adapters/` 改为 `minicpm-sidecar/bin/<triple>/` + 瘦 gateway 源；`build:mac:mvp` 指向 `minicpm-sidecar/scripts/build-all.sh`。
- 模型路径语义：从「HF 目录含 `config.json`」改为「`.gguf` 文件（或含 `.gguf` 的目录）」。Onboarding 选本地模型支持新旧两种输入。
- Onboarding 文案：模型大小 / 加速器命名（MPS → Metal）等更新到 llama.cpp 语义。
- 跟 sidecar 同源的开发脚本 [`go.sh`](go.sh) 完全重写：自动装 cmake、首次自动编 llama-server、`uv sync` 给 gateway 装几十 MB 依赖（不再下 torch）。

### 移除

- 旧 PyInstaller spec / 构建脚本（`build/sidecar.spec`、`build/build-sidecar.sh`）—已加 [DEPRECATED.md](build/DEPRECATED.md)。
- conda + `start.sh` 路径在 spawn 层全删（旧目录仍保留 README 引用以便历史追溯）。
- 自动加载 LoRA 适配器（`MINICPM_ADAPTER` env + `auto-detected LoRA adapter`）。

### 暂未实现（v2 路线）

- LoRA / `disable_adapter` 旁白绕过 / 猫娘人格切换（待 GGUF LoRA 工具链稳定）
- `POST /api/classify`（短期返回 501，UI 未调用此端点）

### 文档

- 新增 [`docs/llama-cpp-migration.md`](docs/llama-cpp-migration.md) 记录本次变动 + vendor 升级路径。
- [`README.md`](README.md) 顶部状态行 / 安装步骤 / 文档索引同步更新到 v0.8。
- 旧的两套 bridge 目录写入 [`DEPRECATED.md`](minicpm-pet-bridge/DEPRECATED.md)。

---

# v0.3 — 2026-05-20

## 重构主线：从 "clone + ./go.sh" 转为 "下载 dmg + 双击安装"

本轮的目标是让普通用户不再需要懂终端 / Python / conda / uv，仅通过双击安装包和 UI 引导就能跑起来。当前仅 mac arm64 单端 MVP。

### 新增

#### Onboarding 首次启动引导
- 全新 5 步引导窗口（独立 BrowserWindow）：
  1. 环境检查（磁盘 / 网络 / 平台）
  2. 加速器探测（自动选 MPS / CUDA / CPU + 手动覆盖）
  3. 模型下载（从 Hugging Face 拉取 ~2 GB，SSE 实时进度条；可改选本地路径）
  4. sidecar 启动 + warmup
  5. 就绪——桌宠登场
- 完成态通过 `<userData>/minicpm-onboarding.json` sentinel 持久化；删除该文件可强制重弹。
- 渲染端走 contextBridge：`window.onboarding.{getState, listDevices, selectDevice, startModelDownload, pickLocalModel, warmup, complete, onProgress}`。

#### Sidecar 新端点
- `GET /api/devices` — 列出可用加速器与推荐项
- `POST /api/set-device` — 持久化用户的加速器手动选择（写入 `MINICPM_DEVICE`，sidecar 重启后生效）
- `GET /api/onboarding` — 当前模型 / 设备 / 阶段状态快照

#### Settings tab 扩展
`Settings → 🐾 MiniCPM` 新增 3 个区：
- **加速器**：下拉切换 MPS / CUDA / CPU，"立即重启 sidecar" 按钮立刻生效
- **模型路径**：可手选本地目录（必须含 `config.json`），或重置回 `<userData>/models/`
- **高级 / 开发**：标记重新引导 + 立即重启应用

#### PyInstaller 打包
- `build/sidecar.spec`：Mac arm64 单文件 sidecar binary，包含 torch / transformers / peft / fastapi 全套
- `build/build-sidecar.sh`：一站式构建脚本，输出到 `clawd-on-desk/dist/sidecar/mac-arm64/`
- `npm run build:mac:mvp`：sidecar build → electron-builder → dmg
- `npm run build:mac:repack`：跳过 sidecar build，仅重打 dmg
- `./go.sh build`：开发者快捷一键

#### 跨平台 spawn 改造
- [`clawd-on-desk/src/minicpm-chat.js`](clawd-on-desk/src/minicpm-chat.js)：`locateSidecarBinary` / `locateBridgeDir` / `locatePython` 重构为三段优先级：
  1. env override (`MINICPM_SIDECAR_BIN` / `MINICPM_BRIDGE_DIR` / `MINICPM_PYTHON`)
  2. packaged binary (`<resourcesPath>/sidecar-bin/`)
  3. dev venv (`minicpm-pet-bridge-uv/.venv/bin/python`)
- Sidecar 类新增 `sidecarBin` 路径分支：packaged 模式直接 spawn binary，跳过 Python 解释器查找。
- 模型路径决策迁到 `<userData>/models/minicpm5-0.9b/`（packaged）/ `<repo>/models/`（dev）。

#### electron-builder
- `package.json` `build.extraResources` 接入 sidecar binary、LoRA adapters、sidecar 源码（备用）。
- `build:mac:mvp` 脚本：先构建 PyInstaller binary，再出 dmg。

### 改动

- `updater.py` 默认源从 mock 切到 `hf://openbmb/MiniCPM5-0.9B`，原 mock 路径仍可通过 `MINICPM_UPDATE_SOURCE=mock://...` 覆盖。
- `updater.py` 加 `_atomic_move`：`os.replace` 跨卷失败时回退 `shutil.move`（Win 跨盘符场景）。
- `server.py` `_pick_dtype`：CUDA 老 GPU（SM<8.0）自动 fp16；CPU 默认 fp32。
- `server.py` `--model` 现在读 `MINICPM_MODEL_DIR` env 优先（被 Electron 注入）。
- `server.py` `--device` 读 `MINICPM_DEVICE` env，`auto` 归一化为自动探测。
- `go.sh` 顶部加 banner："开发者快捷脚本"；新增 `build` 子命令。
- `README.md` 重写：用户向放最前，开发者部分简短引到 `docs/development.md`。
- `skills/deploy-minicpm-pet/SKILL.md` 顶部标注 "仅开发者用"。

### 修复

- 同步缺失的 `minicpm-pet-bridge-uv/clawd_state.py`（之前 uv 版 server.py 引用了但文件不在）。

### 新增文件

- `clawd-on-desk/src/minicpm-onboarding.js` / `.html` / `.css` / `-renderer.js` / `preload-minicpm-onboarding.js`
- `build/sidecar.spec` / `build/build-sidecar.sh`
- `docs/development.md`
- `docs/PRD-sidecar-cross-platform-refactor.md` (本轮重构前撰写)
- `docs/architecture-and-cross-platform-report.md` (本轮重构前撰写)

### 实际产物 (在本机 Mac arm64 上验证)

- `clawd-on-desk/dist/sidecar/mac-arm64/`：PyInstaller 产物，~120 MB（其中可执行 57 MB + `_internal/` 60 MB）
- `clawd-on-desk/dist/mac-arm64/Clawd on Desk.app/`：Resources 内含 sidecar-bin/ + adapters/ + minicpm-pet-bridge/
  - 若开发机钥匙串里有 Apple Developer ID 证书，.app 会被自动签名；否则保持未签名
- `clawd-on-desk/dist/Clawd on Desk-0.7.1-arm64.dmg`：**310 MB**（远低于 PRD 设的 1.5 GB 上限）
- dmg 本身未签名 / 未公证（用户首次启动需手动绕 Gatekeeper：右键打开 或 `xattr -cr`）

### 已知限制 (MVP)

- 仅 macOS arm64；Intel / Windows / Linux 留待后续
- dmg 容器未签名 / .app 公证未做（即便 .app 签名了，首次启动仍弹 Gatekeeper 警告）
- 未接 electron-updater 自动更新
- 模型下载仅 Hugging Face 单源（ModelScope 备用源待开发）
- 无断点续传 UI（底层 huggingface_hub 已支持）
- 国内网络环境下，初次打包需要给整个 build 过程开代理（dmg-builder bundle 走 GitHub Release，无官方镜像）

---

# v0.2 — 2026-05-18

## 新增

### 设置面板
- `Settings → 🐾 MiniCPM` 标签页:
  - 当前模型 / 适配器 / 人格 / 设备实时状态
  - 模型更新检查 + 一键应用
  - LoRA 下拉切换(切换会清空对话历史)
  - 聊天生成参数:Temperature / Top-p / Top-k / Repetition penalty / Max tokens / 默认思考模式
  - 桌宠主动旁白开关
  - 气泡位置可视化:左/右/自动 + 拖动微调

### LoRA 适配器
- 新增 `adapters/lora_nekoqa_adapter_*` (猫娘版)
- 聊天里说 "用猫娘" / "切回原版" / "用 base" 直接切换
- 切换 / 切回都用 LLM 意图分类做模糊匹配,不只支持精确字符串
- 切到当前已加载的 adapter 会提示 "已经是 X 了" 而不是空切

### 桌宠主动旁白(narration)
- 监听 Cursor / Claude Code / Codex 的完成事件
- 用 base 模型(`disable_adapter=true`)生成一句简短点评
- 节流 + 去重逻辑,避免刷屏
- 旁白文本带上当前会话标题 + 上一轮 assistant 摘要做语境

### 桌宠 narration 增强(本轮新增)
- **多窗口 FIFO 队列**:多个 IDE/CLI 同时完成时,排队依次播报(最多 5 条,session 去重)
- **事件 merge 评分**:Cursor + Claude Code 同时为一个 session 触发 hook 时,
  自动选 transcript 上下文最丰富的那条(避免被空 stop 抢先吃掉 dedup 槽)
- **Claude Code transcript 解析**:之前只有 Cursor 抓 title+summary,
  现在 Claude Code 也抓:首条 user 当 title,末条 assistant text 当 summary
- **race-condition 修复**:Claude Code stop hook 在 transcript 写盘前触发的
  bug,现在会等文件大小稳定 (max 1.2s) 才解析
- **Prompt 重写**:对所有 agent 统一"主人刚结束跟 AI 关于 X 的对话"框架,
  few-shot 改成"旁观者"视角(不冒充 AI 说话),减少 0.9B 模型的语病和角色混淆

### UI/UX
- 聊天气泡:
  - 拖动调整位置后会记住(`<userData>/minicpm-bubble-pos.json`)
  - 默认在桌宠左侧,屏幕边缘自动翻到右侧
  - 输入框气泡尺寸自适应,长文本自然换行不截断
  - 命令回复 / 错误提示用独立的 `showCommandReply` 路径,带 fade
- 全局快捷键:
  - `⌘⇧M`: 开关聊天气泡
  - `⌘⇧T`: 切换思考模式显示
  - `Esc`: 关闭气泡(仅气泡内有焦点时)

### Sidecar
- 新增端点:
  - `GET /api/adapters` — 列出可用 LoRA
  - `POST /api/load-adapter` — 切换 / 卸载 LoRA
  - `GET /api/update-check` — 检查模型新版
  - `POST /api/update-apply` (SSE) — 流式应用模型更新
  - `POST /api/classify` — first-token logit 意图分类
  - `POST /api/warmup` — 把模型权重 fault 回 RAM,降低空闲后冷启动延迟
- `ChatRequest` 新增字段:
  - `top_k`(原来只支持 top_p)
  - `silent` — 不推送桌宠状态(narration / 后台调用用)
  - `disable_adapter` — 这次请求不走 LoRA(分类 / 旁白用)
- 启动时双路 warmup:同时预热采样 + 贪心 kernel,首条消息不再卡顿
- 打开聊天气泡时后台 warmup ping,你打字的同时模型在 fault back
- `_safe_print` 包裹所有日志,sidecar 在 BrokenPipe 时不崩

### 一键安装(uv 版本独有)
- `./go.sh` 自动检查 macOS / Node 18+ / uv,缺失自动装
- Node 优先 brew,无 brew 用 fnm 装一份(无 sudo)
- uv 一行 curl 装
- 子命令: `./go.sh doctor` / `setup` / `start` / `run`

## 改动

- 默认 `thinking=false`(LoRA 没在 `<think>` 上训练,开了会卡住)
- chat 默认 `max_new_tokens=768`
- 聊天 UI 用主进程 IPC 拉取参数,Settings 改完下条消息立刻生效
- `pickSide` 支持用户偏好(原来固定右侧优先)
- 默认气泡偏移调成 `dx=-45, dy=45`(贴合默认猫的实际像素)

## 修复

- 切 adapter 之后历史不清空导致人格污染 — 现在 reset
- 命令分类(切 / 切回 / 切回 base)在否定句和模糊表达上漏检 — 加了更多 few-shot,现在能识别 "我不要用猫娘了" 之类
- 编辑气泡位置时旁白会插话 — 编辑期间禁用旁白
- 聊天气泡 macOS 焦点丢失 — 加了显式 `bubble.focus()` IPC
- Claude Code stop hook 抓到上一轮 assistant 内容 — race condition fix

## 内部 / 不影响用户

- 新增 `clawd-on-desk/src/settings-tab-minicpm.js`
- 新增 `clawd-on-desk/src/minicpm-chat.js`(原来在 main.js 里)
- 派生状态机:`overload` / `failure-streak` 自动 push
- agent 事件里的会话标题 / 上一轮摘要传给旁白做语境

## 已知问题

- LoRA 切换需要 ~2-4s,过程中桌宠的 thinking 动画会持续转
- Q4 量化 + 0.9B 还没做(还在 transformers 路径)
- 朋友的 conda 环境如果 setup.sh 没跑过,upgrade.sh 不会自动建
- 0.9B 模型 narration 偶尔翻车(改关键词、出语病),0.9B 容量上限
- Codex agent 还没接 last_summary 解析(只有 thread_name)
