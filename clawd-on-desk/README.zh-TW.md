<p align="center">
  <img src="assets/tray-icon.png" width="128" alt="MiniCPM Desk Pet">
</p>
<h1 align="center">MiniCPM Desk Pet</h1>
<p align="center">
  <a href="README.md">English</a>
  ·
  <a href="README.zh-CN.md">简体中文</a>
  ·
  <a href="README.ko-KR.md">한국어</a>
  ·
  <a href="README.ja-JP.md">日本語</a>
</p>
<p align="center">
  <a href="https://github.com/OpenBMB/MiniCPM-Desk-Pet/releases"><img src="https://img.shields.io/github/v/release/OpenBMB/MiniCPM-Desk-Pet" alt="Version"></a>
  <img src="https://img.shields.io/badge/model-MiniCPM5--1B--GGUF-blue" alt="Model">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" alt="Platform">
  <img src="https://img.shields.io/badge/license-AGPL--3.0--only-green" alt="License">
</p>

MiniCPM Desk Pet 是由 MiniCPM 驅動的本地優先 AI 桌寵。它整合桌面寵物、本地 MiniCPM 聊天氣泡、首次啟動模型引導，以及 AI 程式設計 Agent 狀態回饋。

本分支保留 MiniCPM 的產品身分、預設主題、模型引導、打包資源、sidecar 路徑與 adapter 路徑。0.8 到 0.10 的遷移集中在 Electron 前端、設定、Agent hook、狀態管理、打包配置與測試；inframodel 推理側程式碼保持不變。

## 功能亮點

- **本地 MiniCPM 對話**：首次啟動環境檢查、MiniCPM5-1B-GGUF 模型下載、預熱、聊天氣泡與本地模型狀態。
- **模型管理**：支援 Hugging Face / ModelScope 下載流程、本地模型路徑選擇、後端重啟與日誌查看。
- **人格 LoRA**：在 `設定...` -> `MiniCPM` 中管理 LoRA adapter；桌寵旁白仍固定使用 base 模型。
- **桌寵狀態回饋**：根據受支援 Agent 的會話、工具呼叫、權限請求、完成、閒置、睡眠與 mini-mode 狀態切換動畫。
- **按需 Agent 整合**：全新安裝預設只管理 Claude Code 和 Codex；其他遷移而來的 Agent 需在 Settings 中明確安裝。
- **遠端/人控功能預設關閉**：Telegram approval/native bot、completion notification、Direct Send、mobile PWA、Hardware Buddy 與 auto-pilot 均只遷移程式碼，不預設啟用。

## 支援的 Agent

Claude Code 和 Codex 是預設啟用的托管整合。遷移後的整合層也包含 Copilot CLI、Gemini CLI、Cursor Agent、CodeBuddy、Kiro CLI、Kimi Code CLI、opencode、Pi、OpenClaw、Hermes Agent、Qwen Code、Antigravity、Qoder、Reasonix 與 CodeWhale，但非預設 Agent 必須在 `Settings...` -> `Agents` 中手動安裝。

state-only 整合只回報狀態，不接管權限。網路與人控能力首次啟動時不會自動監聽連接埠、傳送訊息或接受手機端輸入。

## 安全開關

以下能力已遷移程式碼，但預設保持關閉：

- Telegram remote approval 和 Telegram native bot
- Completion notification 和 Telegram Direct Send
- Mobile 只讀 PWA
- Hardware Buddy
- Auto-pilot

這些能力啟用前必須單獨完成本地功能測試、權限安全測試、網路斷線測試、token/金鑰處理測試與跨平台 smoke test。Direct Send 在本次遷移中不得自動按 Enter。

## 快速開始

從 [OpenBMB MiniCPM Desk Pet Releases](https://github.com/OpenBMB/MiniCPM-Desk-Pet/releases) 下載預先建置安裝包。

- **macOS**：`MiniCPM-Desk-Pet-<version>-<arch>.dmg`
- **Windows**：`MiniCPM-Desk-Pet-Setup-<version>-<arch>.exe`
- **Linux**：`.AppImage` 或 `.deb`

開發或測試時從原始碼執行：

```bash
git clone https://github.com/OpenBMB/MiniCPM-Desk-Pet.git
cd MiniCPM-Desk-Pet/clawd-on-desk
npm install
npm start
```

應用目錄仍保留為 `clawd-on-desk`，用於相容上游 Electron 結構與既有 hook 路徑。

## 開發說明

- 保留 MiniCPM sidecar、adapter、模型資源與預設產品 metadata。
- 未經獨立測試與發布任務，不啟用遠端審批、行動端預覽、Direct Send、Hardware Buddy 或 auto-pilot。
- `task_plan.md`、`findings.md`、`progress.md` 和 `.planning/` 等 planning 產物已加入 Git 忽略。

常用命令：

```bash
npm test
npm start
```

## 致謝

MiniCPM Desk Pet 使用 OpenBMB MiniCPM 模型資源，並在 [NOTICE.md](NOTICE.md) 中保留上游桌寵 UI 基礎的歸屬說明。模型權重與第三方資源遵循各自授權。
