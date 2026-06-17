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
  <a href="README.ja-JP.md">日本語</a>
</p>
<p align="center">
  <a href="https://github.com/OpenBMB/MiniCPM-Desk-Pet/releases"><img src="https://img.shields.io/github/v/release/OpenBMB/MiniCPM-Desk-Pet" alt="Version"></a>
  <img src="https://img.shields.io/badge/model-MiniCPM5--1B--GGUF-blue" alt="Model">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" alt="Platform">
  <img src="https://img.shields.io/badge/license-AGPL--3.0--only-green" alt="License">
</p>

MiniCPM Desk Pet은 MiniCPM으로 동작하는 로컬 우선 AI 데스크톱 펫입니다. 데스크톱 펫, 로컬 MiniCPM 채팅 버블, 첫 실행 모델 온보딩, AI 코딩 Agent 상태 반응을 하나의 앱으로 제공합니다.

이 브랜치는 MiniCPM 제품 정체성, 기본 테마, 모델 온보딩, 패키징 리소스, sidecar 경로, adapter 경로를 유지합니다. 0.8에서 0.10까지의 마이그레이션은 Electron 프런트엔드, 설정, Agent hook, 상태 관리, 패키징 설정, 테스트에 한정하며 inframodel 추론 코드는 변경하지 않습니다.

## 주요 기능

- **로컬 MiniCPM 채팅**: 첫 실행 환경 점검, MiniCPM5-1B-GGUF 모델 다운로드, 워밍업, 채팅 버블, 로컬 모델 상태.
- **모델 관리**: Hugging Face / ModelScope 다운로드 흐름, 로컬 모델 경로 선택, 백엔드 재시작, 로그 보기.
- **Persona LoRA**: `Settings...` -> `MiniCPM`에서 LoRA adapter를 관리합니다. 펫 내레이션은 base 모델을 사용합니다.
- **데스크톱 펫 반응**: 지원 Agent의 세션, 도구 실행, 권한 요청, 완료, 유휴, 수면, mini-mode 상태에 따라 반응합니다.
- **온디맨드 Agent 연동**: 새 설치에서는 Claude Code와 Codex만 기본 관리합니다. 다른 마이그레이션 Agent는 Settings에서 명시적으로 설치합니다.
- **원격/휴먼 컨트롤 기능 기본 꺼짐**: Telegram approval/native bot, completion notification, Direct Send, mobile PWA, Hardware Buddy, auto-pilot은 코드만 마이그레이션되며 기본으로 켜지지 않습니다.

## 지원 Agent

Claude Code와 Codex는 기본으로 활성화되는 관리 연동입니다. 마이그레이션된 연동 계층에는 Copilot CLI, Gemini CLI, Cursor Agent, CodeBuddy, Kiro CLI, Kimi Code CLI, opencode, Pi, OpenClaw, Hermes Agent, Qwen Code, Antigravity, Qoder, Reasonix, CodeWhale도 포함되지만 기본 Agent가 아닌 경우 `Settings...` -> `Agents`에서 직접 설치해야 합니다.

state-only 연동은 상태만 보고하며 권한을 대신 처리하지 않습니다. 네트워크 및 휴먼 컨트롤 기능은 첫 실행 시 포트 수신, 메시지 전송, 모바일 입력 수락을 자동으로 시작하지 않습니다.

## 안전 게이트

다음 기능은 코드가 마이그레이션되었지만 기본값은 비활성화입니다.

- Telegram remote approval 및 Telegram native bot
- Completion notification 및 Telegram Direct Send
- Mobile 읽기 전용 PWA
- Hardware Buddy
- Auto-pilot

활성화 전에는 로컬 기능 테스트, 권한 안전성 테스트, 네트워크 단절 테스트, token/키 처리 테스트, 크로스 플랫폼 smoke test가 필요합니다. 이번 마이그레이션에서 Direct Send는 자동으로 Enter를 눌러서는 안 됩니다.

## 빠른 시작

[OpenBMB MiniCPM Desk Pet Releases](https://github.com/OpenBMB/MiniCPM-Desk-Pet/releases)에서 사전 빌드 패키지를 다운로드합니다.

- **macOS**: `MiniCPM-Desk-Pet-<version>-<arch>.dmg`
- **Windows**: `MiniCPM-Desk-Pet-Setup-<version>-<arch>.exe`
- **Linux**: `.AppImage` 또는 `.deb`

개발 또는 테스트 시 소스에서 실행합니다.

```bash
git clone https://github.com/OpenBMB/MiniCPM-Desk-Pet.git
cd MiniCPM-Desk-Pet/clawd-on-desk
npm install
npm start
```

앱 폴더 이름은 upstream Electron 구조와 기존 hook 경로 호환성을 위해 `clawd-on-desk`로 유지합니다.

## 개발 메모

- MiniCPM sidecar, adapter, 모델 리소스, 기본 제품 metadata를 유지합니다.
- 원격 승인, 모바일 미리보기, Direct Send, Hardware Buddy, auto-pilot은 별도 테스트와 릴리스 작업 없이 활성화하지 않습니다.
- `task_plan.md`, `findings.md`, `progress.md`, `.planning/` 등의 planning 산출물은 Git에서 무시됩니다.

유용한 명령:

```bash
npm test
npm start
```

## 감사의 말

MiniCPM Desk Pet은 OpenBMB MiniCPM 모델 리소스를 사용하며, upstream 데스크톱 펫 UI 기반에 대한 표기를 [NOTICE.md](NOTICE.md)에 유지합니다. 모델 가중치와 타사 자산은 각각의 라이선스를 따릅니다.
