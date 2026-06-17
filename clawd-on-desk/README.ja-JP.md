<p align="center">
  <img src="assets/tray-icon.png" width="128" alt="MiniCPM Desk Pet">
</p>
<h1 align="center">MiniCPM Desk Pet</h1>
<p align="center">
  <a href="README.md">English</a>
  ·
  <a href="README.zh-CN.md">简体中文</a>
  ·
  <a href="README.zh-TW.md">繁體中文</a>
  ·
  <a href="README.ko-KR.md">한국어</a>
</p>
<p align="center">
  <a href="https://github.com/OpenBMB/MiniCPM-Desk-Pet/releases"><img src="https://img.shields.io/github/v/release/OpenBMB/MiniCPM-Desk-Pet" alt="Version"></a>
  <img src="https://img.shields.io/badge/model-MiniCPM5--1B--GGUF-blue" alt="Model">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" alt="Platform">
  <img src="https://img.shields.io/badge/license-AGPL--3.0--only-green" alt="License">
</p>

MiniCPM Desk Pet は MiniCPM で動くローカルファーストの AI デスクトップペットです。デスクトップ上のペット、ローカル MiniCPM チャットバブル、初回起動時のモデルセットアップ、AI コーディング Agent の状態反応を 1 つのアプリにまとめています。

このブランチでは MiniCPM の製品名、既定テーマ、モデルオンボーディング、同梱 sidecar リソース、adapter パスを維持します。0.8 から 0.10 への移行は Electron フロントエンド、設定、Agent hook、状態管理、パッケージ設定、テストに限定し、inframodel 推論側のコードは変更しません。

## 主な機能

- **ローカル MiniCPM チャット**: 初回環境チェック、MiniCPM5-1B-GGUF モデルダウンロード、ウォームアップ、チャットバブル、ローカルモデル状態。
- **モデル管理**: Hugging Face / ModelScope ダウンロード、ローカルモデルパス選択、バックエンド再起動、ログ表示。
- **Persona LoRA**: `Settings...` -> `MiniCPM` で LoRA adapter を管理します。ペットのナレーションは base モデルを使います。
- **デスクトップペットの反応**: 対応 Agent のセッション、ツール実行、権限要求、完了、アイドル、睡眠、mini-mode に応じて状態を切り替えます。
- **オンデマンド Agent 連携**: 新規インストールでは Claude Code と Codex のみを既定管理します。他の移行済み Agent は Settings から明示的にインストールします。
- **リモート/人間操作機能は既定オフ**: Telegram approval/native bot、completion notification、Direct Send、mobile PWA、Hardware Buddy、auto-pilot はコードのみ移行し、既定では有効化しません。

## 対応 Agent

Claude Code と Codex は既定で有効な管理連携です。移行済みの連携層には Copilot CLI、Gemini CLI、Cursor Agent、CodeBuddy、Kiro CLI、Kimi Code CLI、opencode、Pi、OpenClaw、Hermes Agent、Qwen Code、Antigravity、Qoder、Reasonix、CodeWhale も含まれますが、既定外の Agent は `Settings...` -> `Agents` から手動でインストールする必要があります。

state-only 連携は状態だけを報告し、権限を引き継ぎません。ネットワーク機能や人間操作機能は初回起動時にポート待受、メッセージ送信、スマートフォン入力の受け付けを自動開始しません。

## 安全ゲート

以下の機能はコード移行済みですが、既定では無効です。

- Telegram remote approval と Telegram native bot
- Completion notification と Telegram Direct Send
- Mobile 読み取り専用 PWA
- Hardware Buddy
- Auto-pilot

有効化する前に、ローカル機能テスト、権限安全性テスト、ネットワーク切断テスト、token/キー処理テスト、クロスプラットフォーム smoke test が必要です。今回の移行では Direct Send が自動で Enter を押してはいけません。

## クイックスタート

[OpenBMB MiniCPM Desk Pet Releases](https://github.com/OpenBMB/MiniCPM-Desk-Pet/releases) からビルド済みパッケージをダウンロードします。

- **macOS**: `MiniCPM-Desk-Pet-<version>-<arch>.dmg`
- **Windows**: `MiniCPM-Desk-Pet-Setup-<version>-<arch>.exe`
- **Linux**: `.AppImage` または `.deb`

開発やテストではソースから実行します。

```bash
git clone https://github.com/OpenBMB/MiniCPM-Desk-Pet.git
cd MiniCPM-Desk-Pet/clawd-on-desk
npm install
npm start
```

アプリフォルダ名は、上流 Electron 構造と既存 hook パスとの互換性のため `clawd-on-desk` のままです。

## 開発メモ

- MiniCPM sidecar、adapter、モデルリソース、既定の製品 metadata を維持します。
- リモート承認、モバイルプレビュー、Direct Send、Hardware Buddy、auto-pilot は、独立したテストとリリース作業なしに有効化しません。
- `task_plan.md`、`findings.md`、`progress.md`、`.planning/` などの planning 生成物は Git で無視します。

便利なコマンド:

```bash
npm test
npm start
```

## 謝辞

MiniCPM Desk Pet は OpenBMB MiniCPM モデルリソースを使用し、上流デスクトップペット UI 基盤への帰属を [NOTICE.md](NOTICE.md) に保持しています。モデル重みと第三者アセットはそれぞれのライセンスに従います。
