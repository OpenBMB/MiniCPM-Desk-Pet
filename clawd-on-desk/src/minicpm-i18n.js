"use strict";

// ── MiniCPM i18n ──
//
// Translations + structured config (regex command patterns, classifier
// few-shots, narration prompts) for the MiniCPM-specific surfaces:
// the first-launch onboarding wizard and the chat bubble.
//
// Loaded as both a CommonJS module (main process: minicpm-onboarding.js,
// minicpm-chat.js) and a UMD-style `<script>` (renderers: minicpm-chat.html,
// minicpm-onboarding.html), via `globalThis.ClawdMinicpmI18n`.
//
// `STRINGS` carries flat, placeholder-bearing strings; pattern/classifier
// data lives in `COMMAND_PATTERNS` / `CLASSIFIER_PROMPTS` / `NARRATION`.
// Test parity is enforced in `test/minicpm-i18n.test.js`.

(function initMinicpmI18n(root) {
  const SUPPORTED_LANGS = ["en", "zh", "zh-TW", "ko", "ja"];

  const STRINGS = {};
  const COMMAND_PATTERNS = {};
  const CLASSIFIER_PROMPTS = {};
  const NARRATION = {};

  function pickDict(map, lang) {
    return (map && (map[lang] || map.en)) || {};
  }

  function makeTranslator(getLang, dictMap) {
    return function t(key, params) {
      const lang = (typeof getLang === "function" ? getLang() : getLang) || "en";
      const dict = pickDict(dictMap || STRINGS, lang);
      const raw = dict[key];
      const value = typeof raw === "string" ? raw : key;
      if (!params) return value;
      return value.replace(/\{(\w+)\}/g, (_m, name) =>
        params[name] !== undefined && params[name] !== null ? String(params[name]) : ""
      );
    };
  }

  function getStrings(lang) {
    return pickDict(STRINGS, lang);
  }

  function getCommandPatterns(lang) {
    return pickDict(COMMAND_PATTERNS, lang);
  }

  function getClassifierPrompt(lang) {
    return pickDict(CLASSIFIER_PROMPTS, lang).prompt || CLASSIFIER_PROMPTS.en.prompt;
  }

  function getNarration(lang) {
    return pickDict(NARRATION, lang);
  }

  function getMinicpmI18nPayload(lang) {
    return {
      lang,
      strings: getStrings(lang),
      commandPatterns: serializePatterns(getCommandPatterns(lang)),
      classifierPrompt: getClassifierPrompt(lang),
      narration: getNarration(lang),
    };
  }

  // RegExp doesn't survive structuredClone over IPC. Send sources/flags so
  // the renderer can reconstruct.
  function serializePatterns(patterns) {
    const out = {};
    for (const key of Object.keys(patterns || {})) {
      const p = patterns[key];
      if (p instanceof RegExp) {
        out[key] = { source: p.source, flags: p.flags };
      } else if (Array.isArray(p)) {
        out[key] = p;
      } else if (p && typeof p === "object" && typeof p.source === "string") {
        out[key] = { source: p.source, flags: p.flags || "" };
      } else {
        out[key] = p;
      }
    }
    return out;
  }

  function deserializePatterns(serialized) {
    const out = {};
    for (const key of Object.keys(serialized || {})) {
      const v = serialized[key];
      if (v && typeof v === "object" && typeof v.source === "string") {
        try { out[key] = new RegExp(v.source, v.flags || ""); }
        catch { out[key] = null; }
      } else {
        out[key] = v;
      }
    }
    return out;
  }

  // Population happens below — kept in attach* helpers so each language's
  // section is one contiguous block in the source file.
  function attach(map, lang, value) { map[lang] = value; }

  // ── EN ──
  // (filled below)
  // ── ZH ──
  // ── ZH-TW ──
  // ── KO ──
  // ── JA ──

  const api = {
    SUPPORTED_LANGS,
    STRINGS,
    COMMAND_PATTERNS,
    CLASSIFIER_PROMPTS,
    NARRATION,
    makeTranslator,
    getStrings,
    getCommandPatterns,
    getClassifierPrompt,
    getNarration,
    getMinicpmI18nPayload,
    serializePatterns,
    deserializePatterns,
  };

  // Internal init hook used below
  api._attach = attach;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) root.ClawdMinicpmI18n = api;

  // ── EN strings ──
  const EN_STRINGS = {
    // Menu / shared
    menuMinicpmChat: "MiniCPM Chat",
    // Onboarding window + steps
    onboardingWindowTitle: "MiniCPM Desk Pet — First Launch",
    onboardingStepEnvCheck: "Environment",
    onboardingStepModel: "Model",
    onboardingStepReady: "Ready",
    // Step 1: env-check
    onboardingEnvWelcome: "Welcome to MiniCPM Desk Pet",
    onboardingEnvCheckDisk: "Disk space",
    onboardingEnvCheckChip: "Chip",
    onboardingDetecting: "Detecting…",
    onboardingDiskAvailable: "{free} available (need {need})",
    onboardingDiskInsufficient: "Only {free} free, need {need}",
    onboardingDiskCheckFail: "Detection failed: {err}",
    onboardingChipUnknown: "Unknown",
    onboardingChipFormat: "{chip} ({arch})",
    onboardingNext: "Next",
    onboardingBack: "Back",
    // Step 2: model
    onboardingModelTitle: "Set up the model",
    onboardingModelLede: "Install MiniCPM5 0.9B",
    onboardingDownloadCardTitle: "Download online",
    onboardingDownloadCardDesc: "Default GGUF Q8_0; the source is auto-selected based on your network.",
    onboardingDownloadProgressInit: "Preparing…",
    onboardingDownloadStart: "Start download",
    onboardingDownloadRetry: "Retry download",
    onboardingDownloading: "Downloading…",
    onboardingDownloadDone: "Done",
    onboardingDownloadSwitchToLocal: "Switch to local…",
    onboardingDownloadSwitchToDownload: "Switch to download",
    onboardingDownloadErrorHint: "Download failed: {msg}. Retry, or choose a local GGUF file.",
    onboardingLocalCardTitle: "Load a local model",
    onboardingLocalCardDesc: "Already have a GGUF? Import the model file directly.",
    onboardingLocalPickFile: "Choose file…",
    onboardingLocalPicked: "Selected",
    onboardingModelPathHint: "{name}",
    onboardingModelPathHintWithSize: "{name}  ·  {size}",
    onboardingDownloaded: "Downloaded",
    onboardingLoaded: "Loaded",
    onboardingWarmupRunning: "Loading model…",
    onboardingWarmupReady: "Model loaded",
    onboardingWarmupRetry: "Retry",
    onboardingWarmupErrorTitle: "Failed to load model: {msg}",
    // Step 3: ready
    onboardingReadyTitle: "All set",
    onboardingReadyLede: "Your pet is about to appear. Day-to-day shortcuts:",
    onboardingHotkeyToggleChat: "toggle chat bubble",
    onboardingHotkeyToggleThinking: "toggle thinking mode",
    onboardingHotkeyEscClose: "close the bubble when input is focused",
    onboardingMoreHint: "Want to swap models, see resource usage, or restart the sidecar? Open the right-click menu's Settings → MiniCPM.",
    onboardingFinish: "Let the pet appear",
    // File picker dialog
    onboardingPickerDialogTitle: "Choose a local MiniCPM model (a .gguf file or a directory containing one)",
    onboardingPickerDialogMessage: "Pick a single .gguf file, or a directory containing .gguf files",
    onboardingPickerInvalidDir: "The selected directory has no .gguf files:\n{path}",
    onboardingPickerInvalidFile: "Please pick a .gguf file:\n{path}",
    // Reasons
    onboardingReasonMps: "Apple Silicon GPU (Metal)",
    onboardingReasonCpu: "CPU inference",
    // Errors
    onboardingSidecarStartFailed: "sidecar failed to start",
    onboardingSidecarNotReady: "sidecar not ready",
    // Chat: open / boot
    chatStarting: "Starting…",
    chatStartingError: "Couldn't start the chat",
    chatBootError: "Connection error",
    chatThinkingDefault: "Thinking…",
    chatThinkingShort: "…",
    chatAskPlaceholder: "Ask anything…",
    chatHotkeyHint: "⌘⇧M to toggle, ⌘⇧T for thinking",
    chatErrorPrefixGeneric: "Something went wrong",
    chatUpdatePillText: "New version",
    chatUpdatePillTitle: "Click to update the model",
    chatUpdatePillUpdating: "Updating…",
    chatUpdatePillTitleUpdating: "Updating the model… don't close the pet.",
    // Chat command replies
    chatStatusWithAdapter: "Currently {model}, with the {adapter} LoRA loaded (persona: {persona})",
    chatStatusNoAdapter: "Currently {model}, no LoRA loaded (persona: {persona})",
    chatUpdateNoConn: "Can't reach the update source — try again in a bit",
    chatUpdateAvailable: "v{remote} is out! You're on {local}. Reply \"update\" and I'll pull it.",
    chatUpdateUpToDate: "You're already on the latest ({local}); nothing to do",
    chatUpdateApplyStart: "Pulling the new model — keep the pet open until it finishes",
    chatUpdateApplyDone: "Update done; switching to the new model now",
    chatUpdateApplyFail: "Update failed: {err}",
    chatAdapterListEmpty: "No personas configured.",
    chatAdapterListIntro: "Available personas:",
    chatAdapterListItem: "• {name}",
    chatAdapterOff: "Switched off; back to the base model",
    chatAdapterAlreadyOff: "No persona was loaded already",
    chatAdapterSwitched: "Switched to {name}",
    chatAdapterNotFound: "Couldn't find a persona matching \"{keyword}\"",
    chatAdapterSwitching: "Switching to {name}…",
    chatAdapterUnloading: "Unloading the persona…",
    // Chat sidecar errors
    chatSidecarMissingBin: "sidecar binary not found. Packaged builds should ship sidecar-bin/; for dev mode, run cd minicpm-sidecar && uv sync.",
    chatSidecarMissingPython: "Python interpreter not found. Install the packaged build (recommended), or cd minicpm-sidecar && uv sync.",
    chatSidecarPyExited: "Python exited early. stderr tail:\n{tail}",
    chatSidecarTimeout: "Timed out waiting for the Python service (90s).",
    chatSidecarUnknownError: "Unknown sidecar error",
    chatLogOpenFailed: "Couldn't open the log file: {err}",
    chatThinkingNotSupportedForPersona: "Thinking mode isn't supported with the current {persona} persona; switch to base first.",
    chatThinkingOn: "Thinking mode: on",
    chatThinkingOff: "Thinking mode: off",
    chatEditModeHint: "Drag me where you want me, then hit Save in Settings.",
    chatEditModeHintShort: "Drag me where you want me",
  };
  const EN_PATTERNS = {
    status: /\b(what|which|current|now)\b.{0,30}\b(model|persona|adapter|lora)\b/i,
    list: /\b(list|show|what).{0,12}\b(personas?|adapters?|loras?|skins?)\b/i,
    off: /\b(disable|remove|unload|turn off|take off|drop)\b.{0,12}\b(adapter|lora|persona|skin)\b/i,
    off2: /\b(back to|reset to|use)\b.{0,12}\b(base|default|original|plain|vanilla)\b/i,
    swap: /\b(switch to|change to|put on|use|load)\b\s+([\w\u4e00-\u9fff-]{1,16})/i,
    ucheck: /\b(check|any|is there).{0,12}\bupdates?\b|\b(update|new\s*version)\b\s*(?:available|out|yet)?\??/i,
    uapply: /^(update|upgrade|pull).{0,15}(now|please|it)?\b/i,
    hints: /\b(adapter|lora|persona|skin|model|update|upgrade|version|switch|load|disable|unload|hf|huggingface|default|vanilla|base)\b/i,
  };
  const EN_CLASSIFIER =
    "You are a command classifier. Map the user's message to one of the labels below and output ONLY the label:\n" +
    "LIST_ADAPTER / SWITCH_TO=name / DISABLE_ADAPTER / UPDATE_CHECK / UPDATE_APPLY / STATUS / NONE\n\n" +
    "User: list personas → LIST_ADAPTER\n" +
    "User: show me the available LoRAs → LIST_ADAPTER\n" +
    "User: switch to neko → SWITCH_TO=neko\n" +
    "User: load the cat persona → SWITCH_TO=cat\n" +
    "User: put on neko → SWITCH_TO=neko\n" +
    "User: back to default → DISABLE_ADAPTER\n" +
    "User: take off the persona → DISABLE_ADAPTER\n" +
    "User: I don't want neko anymore → DISABLE_ADAPTER\n" +
    "User: which model are you using → STATUS\n" +
    "User: check for updates → UPDATE_CHECK\n" +
    "User: update now → UPDATE_APPLY\n" +
    "User: hi → NONE\n" +
    "User: what's the weather → NONE\n" +
    "User: what is 1+1 → NONE\n" +
    "User: explain LoRA → NONE\n" +
    "Now classify the next line:";
  const EN_NARRATION = {
    eventStopFailureWithSubject: "The owner ran into an error while working with AI on {subject}",
    eventStopFailureNoSubject: "The owner's AI assistant just errored out",
    eventNotificationWithSubject: "The owner is stuck on a confirmation prompt while working on {subject}",
    eventNotificationNoSubject: "The owner is stuck on a confirmation prompt",
    eventStopWithSubject: "The owner just finished an AI conversation about {subject}",
    eventStopNoSubject: "The owner's AI conversation just wrapped up",
    eventLastSaid: ". The AI's last line: {summary}",
    subjectQuoted: "\"{title}\"",
    subjectFromCwd: "the {cwd} project",
    systemPrompt:
      "You are the little desk pet on the owner's computer. The owner is chatting / coding with an AI assistant. " +
      "You can't see the whole transcript — only an event description and the AI's last message.\n" +
      "Your job: compress that last message into one short line that tells the owner what the AI just said or did. " +
      "You're a bystander reporting on the AI, NOT the AI continuing its reply.\n\n" +
      "Hard rules:\n" +
      "- ONE sentence, 8-22 words\n" +
      "- Reflect the actual content of the AI's reply (the dish names, the bug, the missing env var, …)\n" +
      "- Speak ABOUT the AI to the owner — never first-person as the AI (no \"I'll help…\" / \"let me…\")\n" +
      "- Don't give advice, don't ask questions, don't editorialize\n" +
      "- Don't name the AI product\n" +
      "- Output the sentence only — no prefix, no quotes, no markdown\n\n" +
      "Examples:\n\n" +
      "Event: The owner just wrapped up an AI conversation about \"what to eat for dinner\". The AI's last line: I'd suggest hot pot, ramen, BBQ, or Sichuan stir-fry — pick whichever you're craving.\n" +
      "Reply: The AI suggested hot pot, ramen, BBQ, and Sichuan stir-fry.\n\n" +
      "Event: The owner just wrapped up an AI conversation about \"what to eat for dinner\". The AI's last line: Hot pot is a great pick!\n" +
      "Reply: The AI also thinks hot pot is a great pick.\n\n",
  };
  // ── ZH strings ──
  const ZH_STRINGS = {
    menuMinicpmChat: "MiniCPM Chat",
    onboardingWindowTitle: "MiniCPM 桌宠 — 首次启动",
    onboardingStepEnvCheck: "环境检查",
    onboardingStepModel: "准备模型",
    onboardingStepReady: "就绪",
    onboardingEnvWelcome: "欢迎使用 MiniCPM 桌宠",
    onboardingEnvCheckDisk: "磁盘空间",
    onboardingEnvCheckChip: "芯片",
    onboardingDetecting: "检测中…",
    onboardingDiskAvailable: "可用 {free}（需要 {need}）",
    onboardingDiskInsufficient: "仅剩 {free}，需要 {need}",
    onboardingDiskCheckFail: "检测失败：{err}",
    onboardingChipUnknown: "未知",
    onboardingChipFormat: "{chip}（{arch}）",
    onboardingNext: "下一步",
    onboardingBack: "上一步",
    onboardingModelTitle: "准备模型",
    onboardingModelLede: "安装 MiniCPM5 0.9B",
    onboardingDownloadCardTitle: "在线下载",
    onboardingDownloadCardDesc: "默认 GGUF Q8_0，会根据你的网络情况自动选择下载源。",
    onboardingDownloadProgressInit: "准备中...",
    onboardingDownloadStart: "开始下载",
    onboardingDownloadRetry: "重试下载",
    onboardingDownloading: "下载中...",
    onboardingDownloadDone: "已完成",
    onboardingDownloadSwitchToLocal: "改为本地…",
    onboardingDownloadSwitchToDownload: "改为下载",
    onboardingDownloadErrorHint: "下载失败：{msg}。可以重试，或选择本地 GGUF 文件。",
    onboardingLocalCardTitle: "加载本地模型",
    onboardingLocalCardDesc: "已经下好 GGUF 权重？直接导入模型文件。",
    onboardingLocalPickFile: "选择文件…",
    onboardingLocalPicked: "已选择",
    onboardingModelPathHint: "{name}",
    onboardingModelPathHintWithSize: "{name}  ·  {size}",
    onboardingDownloaded: "已下载",
    onboardingLoaded: "已加载",
    onboardingWarmupRunning: "正在加载模型...",
    onboardingWarmupReady: "模型已加载",
    onboardingWarmupRetry: "重试",
    onboardingWarmupErrorTitle: "模型加载失败：{msg}",
    onboardingReadyTitle: "一切就绪",
    onboardingReadyLede: "桌宠马上登场。日常使用：",
    onboardingHotkeyToggleChat: "开关聊天气泡",
    onboardingHotkeyToggleThinking: "切换思考模式",
    onboardingHotkeyEscClose: "在气泡内焦点时关闭气泡",
    onboardingMoreHint: "想换模型、查看资源占用、重启 sidecar？打开右键菜单的 Settings → MiniCPM。",
    onboardingFinish: "让桌宠登场",
    onboardingPickerDialogTitle: "选择本地 MiniCPM 模型 (.gguf 文件或包含 .gguf 的目录)",
    onboardingPickerDialogMessage: "可以是单个 .gguf 文件，或包含 .gguf 的目录",
    onboardingPickerInvalidDir: "所选目录不包含 .gguf：\n{path}",
    onboardingPickerInvalidFile: "请选择 .gguf 文件：\n{path}",
    onboardingReasonMps: "Apple Silicon GPU (Metal)",
    onboardingReasonCpu: "纯 CPU 推理",
    onboardingSidecarStartFailed: "sidecar 启动失败",
    onboardingSidecarNotReady: "sidecar 未就绪",
    chatStarting: "启动中…",
    chatStartingError: "启动失败",
    chatBootError: "连接错误",
    chatThinkingDefault: "正在思考…",
    chatThinkingShort: "…",
    chatAskPlaceholder: "问问看…",
    chatHotkeyHint: "⌘⇧M 开关，⌘⇧T 思考模式",
    chatErrorPrefixGeneric: "出错了",
    chatUpdatePillText: "新版本",
    chatUpdatePillTitle: "点击更新模型",
    chatUpdatePillUpdating: "更新中…",
    chatUpdatePillTitleUpdating: "正在更新模型…，更新完成前请勿关闭桌宠。",
    chatStatusWithAdapter: "当前是 {model}，套着 {adapter} 这个 LoRA（人格: {persona}）",
    chatStatusNoAdapter: "当前是 {model}，没套 LoRA（人格: {persona}）",
    chatUpdateNoConn: "查不动更新源诶，待会儿再问",
    chatUpdateAvailable: "有新版 {remote}！本地是 {local}。回我\"更新\"我就拉。",
    chatUpdateUpToDate: "已经是最新啦（{local}），不用动",
    chatUpdateApplyStart: "开始更新模型，下载完成前别关掉桌宠",
    chatUpdateApplyDone: "更新完成，正在切到新模型",
    chatUpdateApplyFail: "更新失败：{err}",
    chatAdapterListEmpty: "还没有配置任何人格。",
    chatAdapterListIntro: "可用人格：",
    chatAdapterListItem: "• {name}",
    chatAdapterOff: "已脱掉，回到原版模型",
    chatAdapterAlreadyOff: "本来就没套 LoRA",
    chatAdapterSwitched: "已切到 {name}",
    chatAdapterNotFound: "找不到叫\"{keyword}\"的人格",
    chatAdapterSwitching: "正在切到 {name}…",
    chatAdapterUnloading: "正在卸下当前人格…",
    chatSidecarMissingBin: "找不到 sidecar。打包模式下应内置 sidecar-bin/，开发模式请 cd minicpm-sidecar && uv sync。",
    chatSidecarMissingPython: "找不到 Python 解释器。请安装应用打包版（推荐），或 cd minicpm-sidecar && uv sync。",
    chatSidecarPyExited: "Python 进程提前退出。stderr 末尾：\n{tail}",
    chatSidecarTimeout: "等待 Python 服务就绪超时 (90s)。",
    chatSidecarUnknownError: "sidecar 未知错误",
    chatLogOpenFailed: "打开日志文件失败：{err}",
    chatThinkingNotSupportedForPersona: "当前 {persona} 人格不支持思考模式，先切到原版再开",
    chatThinkingOn: "思考已开启",
    chatThinkingOff: "思考已关闭",
    chatEditModeHint: "把我拖到喜欢的位置 🐾\n然后回到设置点「保存」",
    chatEditModeHintShort: "把我拖到喜欢的位置 🐾",
  };
  const ZH_PATTERNS = {
    status: /(你现在|当前|目前|现在).{0,4}(是什么|是啥|用的什么|用啥|什么模型|什么人格|哪个模型|哪个人格|是哪个)/,
    list: /(看看|看下|查看|有啥|有什么|哪些|列|列出).{0,5}(adapter|插件|皮肤|人格|风格|lora)/i,
    off: /(关掉|关闭|去掉|不要|脱掉|取消|卸|卸载).{0,4}(adapter|人格|皮肤|lora)/i,
    off2: /(用回|回到|切到|切回|换成|换到|去).{0,4}(原版|默认|base|普通|原始|裸|本来|纯净)/i,
    swap: /(切到|换到|换成|切换到|切换成|换上|穿上|戴上|启用|载入|加载|装上|套上|挂上).{0,2}([\u4e00-\u9fff\w-]{1,16})/i,
    ucheck: /(检查|看看|查|有没|看一下).{0,4}(更新|新版|新版本)|(更新|新版).{0,4}(吗|么|嘛|没|？|\?)/,
    uapply: /^(更新|升级|马上更新|去更新|更新一下|开始更新|马上升级|拉新版)\b/,
    hints: /(adapter|lora|人格|皮肤|风格|默认|原版|裸|纯净|普通|猫娘|宝宝|更新|升级|新版|hf|hugging|切|换|装|穿|戴|脱|关掉|关闭|启用|禁用|卸|挂上|套上|不要|别|去掉|取消|废|废掉|model|模型|皮)/i,
  };
  const ZH_CLASSIFIER =
    "你是命令分类器。把用户的话归到下面一个标签，只输出标签本身：\n" +
    "LIST_ADAPTER / SWITCH_TO=名字 / DISABLE_ADAPTER / UPDATE_CHECK / UPDATE_APPLY / STATUS / NONE\n\n" +
    "用户：看看有哪些人格 → LIST_ADAPTER\n" +
    "用户：列出 lora → LIST_ADAPTER\n" +
    "用户：切到猫娘 → SWITCH_TO=猫娘\n" +
    "用户：把猫娘装上 → SWITCH_TO=猫娘\n" +
    "用户：来个 neko → SWITCH_TO=neko\n" +
    "用户：回到原版 → DISABLE_ADAPTER\n" +
    "用户：脱掉皮肤 → DISABLE_ADAPTER\n" +
    "用户：我不要用猫娘了 → DISABLE_ADAPTER\n" +
    "用户：你现在用什么模型 → STATUS\n" +
    "用户：检查更新 → UPDATE_CHECK\n" +
    "用户：去更新一下 → UPDATE_APPLY\n" +
    "用户：你好 → NONE\n" +
    "用户：今天天气真好 → NONE\n" +
    "用户：1+1 等于几 → NONE\n" +
    "用户：解释一下 LoRA 是什么 → NONE\n" +
    "现在分类下面这句：";
  const ZH_NARRATION = {
    eventStopFailureWithSubject: "主人和 AI 处理{subject}的时候出错了",
    eventStopFailureNoSubject: "主人那边的 AI 报错了",
    eventNotificationWithSubject: "主人在{subject}这事里卡在一个确认弹窗",
    eventNotificationNoSubject: "主人卡在一个确认弹窗",
    eventStopWithSubject: "主人刚结束跟 AI 关于{subject}的对话",
    eventStopNoSubject: "主人那边的对话刚结束了",
    eventLastSaid: "。AI 最后说：{summary}",
    subjectQuoted: "「{title}」",
    subjectFromCwd: "{cwd} 项目",
    systemPrompt:
      "你是主人电脑上的小桌宠。主人正在跟一个 AI 助手聊天 / 写代码,你看不到全程,只能看到事件描述和 AI 最后说的那句话。\n" +
      "你的任务:把 AI 那句话压缩成一句话,告诉主人「AI 刚才告诉你/做了什么」。" +
      "你是 旁观者,不是 AI 本身,不要替 AI 接话。\n\n" +
      "硬要求:\n" +
      "- 一句话,12-28 个汉字\n" +
      "- 必须复述 AI 那句话里的具体内容(火锅/拉面 / token 写反 / 缺什么环境变量 / ...)\n" +
      "- 视角是「向主人转述 AI」,不要冒充 AI 自己,不要说「我帮你...」「让我...」\n" +
      "- 不要给主人提建议,不要问主人问题,不要发表评论\n" +
      "- 不要提 AI 助手的具体产品名\n" +
      "- 只输出这一句话本身,无前缀、无引号、无 markdown\n\n" +
      "示例:\n\n" +
      "事件:主人刚结束跟 AI 关于「晚饭吃啥」的对话。AI 最后说:推荐火锅、拉面、烤肉、川菜小炒,看你想吃哪种。\n" +
      "回复:AI 推荐了火锅、拉面、烤肉和川菜\n\n" +
      "事件:主人刚结束跟 AI 关于「晚饭吃啥」的对话。AI 最后说:火锅好选择!\n" +
      "回复:AI 也觉得火锅是好选择\n\n",
  };
  // ── ZH-TW strings ──
  const ZH_TW_STRINGS = {
    menuMinicpmChat: "MiniCPM Chat",
    onboardingWindowTitle: "MiniCPM 桌寵 — 首次啟動",
    onboardingStepEnvCheck: "環境檢查",
    onboardingStepModel: "準備模型",
    onboardingStepReady: "就緒",
    onboardingEnvWelcome: "歡迎使用 MiniCPM 桌寵",
    onboardingEnvCheckDisk: "磁碟空間",
    onboardingEnvCheckChip: "晶片",
    onboardingDetecting: "偵測中…",
    onboardingDiskAvailable: "可用 {free}（需要 {need}）",
    onboardingDiskInsufficient: "僅剩 {free}，需要 {need}",
    onboardingDiskCheckFail: "偵測失敗：{err}",
    onboardingChipUnknown: "未知",
    onboardingChipFormat: "{chip}（{arch}）",
    onboardingNext: "下一步",
    onboardingBack: "上一步",
    onboardingModelTitle: "準備模型",
    onboardingModelLede: "安裝 MiniCPM5 0.9B",
    onboardingDownloadCardTitle: "線上下載",
    onboardingDownloadCardDesc: "預設 GGUF Q8_0，會根據你的網路狀況自動選擇下載來源。",
    onboardingDownloadProgressInit: "準備中...",
    onboardingDownloadStart: "開始下載",
    onboardingDownloadRetry: "重試下載",
    onboardingDownloading: "下載中...",
    onboardingDownloadDone: "已完成",
    onboardingDownloadSwitchToLocal: "改為本機…",
    onboardingDownloadSwitchToDownload: "改為下載",
    onboardingDownloadErrorHint: "下載失敗：{msg}。可以重試，或選擇本機 GGUF 檔案。",
    onboardingLocalCardTitle: "載入本機模型",
    onboardingLocalCardDesc: "已經下好 GGUF 權重？直接匯入模型檔案。",
    onboardingLocalPickFile: "選擇檔案…",
    onboardingLocalPicked: "已選擇",
    onboardingModelPathHint: "{name}",
    onboardingModelPathHintWithSize: "{name}  ·  {size}",
    onboardingDownloaded: "已下載",
    onboardingLoaded: "已載入",
    onboardingWarmupRunning: "正在載入模型...",
    onboardingWarmupReady: "模型已載入",
    onboardingWarmupRetry: "重試",
    onboardingWarmupErrorTitle: "模型載入失敗：{msg}",
    onboardingReadyTitle: "一切就緒",
    onboardingReadyLede: "桌寵馬上登場。日常使用：",
    onboardingHotkeyToggleChat: "開關聊天對話框",
    onboardingHotkeyToggleThinking: "切換思考模式",
    onboardingHotkeyEscClose: "在對話框輸入時關閉對話框",
    onboardingMoreHint: "想換模型、查看資源占用、重啟 sidecar？開啟右鍵選單的 Settings → MiniCPM。",
    onboardingFinish: "讓桌寵登場",
    onboardingPickerDialogTitle: "選擇本機 MiniCPM 模型 (.gguf 檔案或包含 .gguf 的目錄)",
    onboardingPickerDialogMessage: "可以是單一 .gguf 檔案，或包含 .gguf 的目錄",
    onboardingPickerInvalidDir: "所選目錄不包含 .gguf：\n{path}",
    onboardingPickerInvalidFile: "請選擇 .gguf 檔案：\n{path}",
    onboardingReasonMps: "Apple Silicon GPU (Metal)",
    onboardingReasonCpu: "純 CPU 推論",
    onboardingSidecarStartFailed: "sidecar 啟動失敗",
    onboardingSidecarNotReady: "sidecar 尚未就緒",
    chatStarting: "啟動中…",
    chatStartingError: "啟動失敗",
    chatBootError: "連線錯誤",
    chatThinkingDefault: "正在思考…",
    chatThinkingShort: "…",
    chatAskPlaceholder: "問問看…",
    chatHotkeyHint: "⌘⇧M 開關，⌘⇧T 思考模式",
    chatErrorPrefixGeneric: "出錯了",
    chatUpdatePillText: "新版本",
    chatUpdatePillTitle: "點擊更新模型",
    chatUpdatePillUpdating: "更新中…",
    chatUpdatePillTitleUpdating: "正在更新模型…，更新完成前請勿關閉桌寵。",
    chatStatusWithAdapter: "目前是 {model}，套著 {adapter} 這個 LoRA（人格: {persona}）",
    chatStatusNoAdapter: "目前是 {model}，沒套 LoRA（人格: {persona}）",
    chatUpdateNoConn: "查不到更新來源耶，等一下再問",
    chatUpdateAvailable: "有新版 {remote}！本機是 {local}。回我「更新」我就拉。",
    chatUpdateUpToDate: "已經是最新囉（{local}），不用動",
    chatUpdateApplyStart: "開始更新模型，下載完成前別關掉桌寵",
    chatUpdateApplyDone: "更新完成，正在切到新模型",
    chatUpdateApplyFail: "更新失敗：{err}",
    chatAdapterListEmpty: "還沒有設定任何人格。",
    chatAdapterListIntro: "可用人格：",
    chatAdapterListItem: "• {name}",
    chatAdapterOff: "已脫掉，回到原版模型",
    chatAdapterAlreadyOff: "本來就沒套 LoRA",
    chatAdapterSwitched: "已切到 {name}",
    chatAdapterNotFound: "找不到叫「{keyword}」的人格",
    chatAdapterSwitching: "正在切到 {name}…",
    chatAdapterUnloading: "正在卸下目前人格…",
    chatSidecarMissingBin: "找不到 sidecar。打包模式下應內建 sidecar-bin/，開發模式請 cd minicpm-sidecar && uv sync。",
    chatSidecarMissingPython: "找不到 Python 直譯器。請安裝應用打包版（建議），或 cd minicpm-sidecar && uv sync。",
    chatSidecarPyExited: "Python 程序提前結束。stderr 末尾：\n{tail}",
    chatSidecarTimeout: "等待 Python 服務就緒逾時 (90s)。",
    chatSidecarUnknownError: "sidecar 未知錯誤",
    chatLogOpenFailed: "開啟記錄檔失敗：{err}",
    chatThinkingNotSupportedForPersona: "目前 {persona} 人格不支援思考模式，先切到原版再開",
    chatThinkingOn: "思考已開啟",
    chatThinkingOff: "思考已關閉",
    chatEditModeHint: "把我拖到喜歡的位置 🐾\n然後回到設定點「儲存」",
    chatEditModeHintShort: "把我拖到喜歡的位置 🐾",
  };
  const ZH_TW_PATTERNS = {
    status: /(你現在|目前|現在).{0,4}(是什麼|是啥|用的什麼|什麼模型|什麼人格|哪個模型|哪個人格|是哪個)/,
    list: /(看看|看一下|查看|有啥|有什麼|哪些|列|列出).{0,5}(adapter|外掛|皮膚|人格|風格|lora)/i,
    off: /(關掉|關閉|去掉|不要|脫掉|取消|卸|卸載).{0,4}(adapter|人格|皮膚|lora)/i,
    off2: /(用回|回到|切到|切回|換成|換到|去).{0,4}(原版|預設|base|普通|原始|裸|本來|純淨)/i,
    swap: /(切到|換到|換成|切換到|切換成|換上|穿上|戴上|啟用|載入|裝上|套上|掛上).{0,2}([\u4e00-\u9fff\w-]{1,16})/i,
    ucheck: /(檢查|看看|查|有沒|看一下).{0,4}(更新|新版|新版本)|(更新|新版).{0,4}(嗎|沒|？|\?)/,
    uapply: /^(更新|升級|馬上更新|去更新|更新一下|開始更新|馬上升級|拉新版)\b/,
    hints: /(adapter|lora|人格|皮膚|風格|預設|原版|裸|純淨|普通|貓娘|寶寶|更新|升級|新版|hf|hugging|切|換|裝|穿|戴|脫|關掉|關閉|啟用|禁用|卸|掛上|套上|不要|別|去掉|取消|廢|model|模型|皮)/i,
  };
  const ZH_TW_CLASSIFIER =
    "你是命令分類器。把使用者的話歸到下面一個標籤，只輸出標籤本身：\n" +
    "LIST_ADAPTER / SWITCH_TO=名字 / DISABLE_ADAPTER / UPDATE_CHECK / UPDATE_APPLY / STATUS / NONE\n\n" +
    "使用者：看看有哪些人格 → LIST_ADAPTER\n" +
    "使用者：列出 lora → LIST_ADAPTER\n" +
    "使用者：切到貓娘 → SWITCH_TO=貓娘\n" +
    "使用者：把貓娘裝上 → SWITCH_TO=貓娘\n" +
    "使用者：來個 neko → SWITCH_TO=neko\n" +
    "使用者：回到原版 → DISABLE_ADAPTER\n" +
    "使用者：脫掉皮膚 → DISABLE_ADAPTER\n" +
    "使用者：我不要用貓娘了 → DISABLE_ADAPTER\n" +
    "使用者：你現在用什麼模型 → STATUS\n" +
    "使用者：檢查更新 → UPDATE_CHECK\n" +
    "使用者：去更新一下 → UPDATE_APPLY\n" +
    "使用者：你好 → NONE\n" +
    "使用者：今天天氣真好 → NONE\n" +
    "使用者：1+1 等於幾 → NONE\n" +
    "使用者：解釋一下 LoRA 是什麼 → NONE\n" +
    "現在分類下面這句：";
  const ZH_TW_NARRATION = {
    eventStopFailureWithSubject: "主人和 AI 處理{subject}時出錯了",
    eventStopFailureNoSubject: "主人那邊的 AI 報錯了",
    eventNotificationWithSubject: "主人在{subject}這件事卡在確認彈窗",
    eventNotificationNoSubject: "主人卡在一個確認彈窗",
    eventStopWithSubject: "主人剛結束跟 AI 關於{subject}的對話",
    eventStopNoSubject: "主人那邊的對話剛結束了",
    eventLastSaid: "。AI 最後說：{summary}",
    subjectQuoted: "「{title}」",
    subjectFromCwd: "{cwd} 專案",
    systemPrompt:
      "你是主人電腦上的小桌寵。主人正在跟一個 AI 助理聊天 / 寫程式,你看不到全程,只能看到事件描述和 AI 最後說的那句話。\n" +
      "你的任務:把 AI 那句話壓縮成一句話,告訴主人「AI 剛才告訴你/做了什麼」。" +
      "你是旁觀者,不是 AI 本身,不要替 AI 接話。\n\n" +
      "硬要求:\n" +
      "- 一句話,12-28 個漢字\n" +
      "- 必須複述 AI 那句話裡的具體內容(火鍋/拉麵 / token 寫反 / 缺什麼環境變數 / ...)\n" +
      "- 視角是「向主人轉述 AI」,不要冒充 AI 自己,不要說「我幫你...」「讓我...」\n" +
      "- 不要給主人建議,不要問主人問題,不要發表評論\n" +
      "- 不要提 AI 助理的具體產品名\n" +
      "- 只輸出這一句話本身,無前綴、無引號、無 markdown\n\n" +
      "範例:\n\n" +
      "事件:主人剛結束跟 AI 關於「晚餐吃啥」的對話。AI 最後說:推薦火鍋、拉麵、燒肉、川菜小炒,看你想吃哪種。\n" +
      "回覆:AI 推薦了火鍋、拉麵、燒肉和川菜\n\n" +
      "事件:主人剛結束跟 AI 關於「晚餐吃啥」的對話。AI 最後說:火鍋好選擇!\n" +
      "回覆:AI 也覺得火鍋是好選擇\n\n",
  };
  // ── KO strings ──
  const KO_STRINGS = {
    menuMinicpmChat: "MiniCPM Chat",
    onboardingWindowTitle: "MiniCPM 데스크 펫 — 첫 실행",
    onboardingStepEnvCheck: "환경 검사",
    onboardingStepModel: "모델 준비",
    onboardingStepReady: "준비 완료",
    onboardingEnvWelcome: "MiniCPM 데스크 펫에 오신 것을 환영합니다",
    onboardingEnvCheckDisk: "디스크 공간",
    onboardingEnvCheckChip: "칩",
    onboardingDetecting: "확인 중…",
    onboardingDiskAvailable: "사용 가능 {free} (필요 {need})",
    onboardingDiskInsufficient: "{free} 남음, {need} 필요",
    onboardingDiskCheckFail: "확인 실패: {err}",
    onboardingChipUnknown: "알 수 없음",
    onboardingChipFormat: "{chip} ({arch})",
    onboardingNext: "다음",
    onboardingBack: "이전",
    onboardingModelTitle: "모델 준비",
    onboardingModelLede: "MiniCPM5 0.9B 설치",
    onboardingDownloadCardTitle: "온라인 다운로드",
    onboardingDownloadCardDesc: "기본 GGUF Q8_0; 네트워크 환경에 맞춰 다운로드 소스가 자동 선택됩니다.",
    onboardingDownloadProgressInit: "준비 중...",
    onboardingDownloadStart: "다운로드 시작",
    onboardingDownloadRetry: "다운로드 다시 시도",
    onboardingDownloading: "다운로드 중...",
    onboardingDownloadDone: "완료",
    onboardingDownloadSwitchToLocal: "로컬로 전환…",
    onboardingDownloadSwitchToDownload: "다운로드로 전환",
    onboardingDownloadErrorHint: "다운로드 실패: {msg}. 다시 시도하거나 로컬 GGUF 파일을 선택하세요.",
    onboardingLocalCardTitle: "로컬 모델 불러오기",
    onboardingLocalCardDesc: "이미 GGUF 가중치를 받았다면 바로 가져오세요.",
    onboardingLocalPickFile: "파일 선택…",
    onboardingLocalPicked: "선택됨",
    onboardingModelPathHint: "{name}",
    onboardingModelPathHintWithSize: "{name}  ·  {size}",
    onboardingDownloaded: "다운로드 완료",
    onboardingLoaded: "불러옴",
    onboardingWarmupRunning: "모델을 불러오는 중...",
    onboardingWarmupReady: "모델 로드 완료",
    onboardingWarmupRetry: "다시 시도",
    onboardingWarmupErrorTitle: "모델 로드 실패: {msg}",
    onboardingReadyTitle: "모든 준비 완료",
    onboardingReadyLede: "곧 펫이 등장합니다. 일상 단축키:",
    onboardingHotkeyToggleChat: "채팅 말풍선 토글",
    onboardingHotkeyToggleThinking: "생각 모드 토글",
    onboardingHotkeyEscClose: "입력에 포커스가 있을 때 말풍선 닫기",
    onboardingMoreHint: "모델 변경, 리소스 사용량 확인, sidecar 재시작? 우클릭 메뉴의 Settings → MiniCPM에서 가능합니다.",
    onboardingFinish: "펫 등장",
    onboardingPickerDialogTitle: "로컬 MiniCPM 모델 선택 (.gguf 파일 또는 .gguf가 포함된 디렉터리)",
    onboardingPickerDialogMessage: "단일 .gguf 파일이거나 .gguf가 포함된 디렉터리여야 합니다",
    onboardingPickerInvalidDir: "선택한 디렉터리에 .gguf 파일이 없습니다:\n{path}",
    onboardingPickerInvalidFile: ".gguf 파일을 선택해 주세요:\n{path}",
    onboardingReasonMps: "Apple Silicon GPU (Metal)",
    onboardingReasonCpu: "CPU 추론",
    onboardingSidecarStartFailed: "sidecar 시작 실패",
    onboardingSidecarNotReady: "sidecar 준비 안 됨",
    chatStarting: "시작 중…",
    chatStartingError: "시작 실패",
    chatBootError: "연결 오류",
    chatThinkingDefault: "생각 중…",
    chatThinkingShort: "…",
    chatAskPlaceholder: "물어보세요…",
    chatHotkeyHint: "⌘⇧M 토글, ⌘⇧T 생각 모드",
    chatErrorPrefixGeneric: "오류 발생",
    chatUpdatePillText: "새 버전",
    chatUpdatePillTitle: "클릭해서 모델 업데이트",
    chatUpdatePillUpdating: "업데이트 중…",
    chatUpdatePillTitleUpdating: "모델 업데이트 중… 펫을 닫지 마세요.",
    chatStatusWithAdapter: "현재 {model}, {adapter} LoRA 적용 중 (페르소나: {persona})",
    chatStatusNoAdapter: "현재 {model}, LoRA 없음 (페르소나: {persona})",
    chatUpdateNoConn: "업데이트 소스에 접근할 수 없어요. 잠시 뒤 다시 물어봐 주세요",
    chatUpdateAvailable: "새 버전 {remote}가 있어요! 현재는 {local}입니다. \"업데이트\"라고 답하면 가져올게요.",
    chatUpdateUpToDate: "이미 최신이에요 ({local}), 할 게 없네요",
    chatUpdateApplyStart: "모델 업데이트 시작; 끝날 때까지 펫을 닫지 마세요",
    chatUpdateApplyDone: "업데이트 완료, 새 모델로 전환 중",
    chatUpdateApplyFail: "업데이트 실패: {err}",
    chatAdapterListEmpty: "구성된 페르소나가 없습니다.",
    chatAdapterListIntro: "사용 가능한 페르소나:",
    chatAdapterListItem: "• {name}",
    chatAdapterOff: "벗었어요. 기본 모델로 돌아갑니다",
    chatAdapterAlreadyOff: "원래 LoRA가 적용돼 있지 않았어요",
    chatAdapterSwitched: "{name}(으)로 전환했어요",
    chatAdapterNotFound: "\"{keyword}\"에 해당하는 페르소나를 찾을 수 없어요",
    chatAdapterSwitching: "{name}(으)로 전환 중…",
    chatAdapterUnloading: "현재 페르소나 해제 중…",
    chatSidecarMissingBin: "sidecar 바이너리를 찾을 수 없습니다. 패키지 빌드는 sidecar-bin/을 포함해야 하며, 개발 모드에서는 cd minicpm-sidecar && uv sync를 실행하세요.",
    chatSidecarMissingPython: "Python 인터프리터를 찾을 수 없습니다. 패키지 빌드(권장)를 설치하거나, cd minicpm-sidecar && uv sync를 실행하세요.",
    chatSidecarPyExited: "Python 프로세스가 일찍 종료되었습니다. stderr 끝부분:\n{tail}",
    chatSidecarTimeout: "Python 서비스 준비 대기 시간이 초과되었습니다 (90s).",
    chatSidecarUnknownError: "sidecar 알 수 없는 오류",
    chatLogOpenFailed: "로그 파일 열기 실패: {err}",
    chatThinkingNotSupportedForPersona: "현재 {persona} 페르소나에서는 생각 모드를 지원하지 않아요. 먼저 기본 모델로 돌려주세요.",
    chatThinkingOn: "생각 모드: 켬",
    chatThinkingOff: "생각 모드: 끔",
    chatEditModeHint: "원하는 곳으로 드래그해 주세요 🐾\n다 되면 설정에서 \"저장\"을 눌러 주세요",
    chatEditModeHintShort: "원하는 곳으로 드래그해 주세요 🐾",
  };
  const KO_PATTERNS = {
    status: /(지금|현재|어떤).{0,12}(모델|페르소나|어댑터|lora)/i,
    list: /(보여|목록|뭐|어떤|있어).{0,12}(페르소나|어댑터|lora|스킨)/i,
    off: /(꺼|해제|벗|제거|끄|내려).{0,8}(페르소나|어댑터|lora|스킨)/i,
    off2: /(원본|기본|디폴트|base|순정).{0,8}(으로|로|돌아)/,
    swap: /([\w\u3131-\u318e\uac00-\ud7a3-]{1,16})\s*(으로|로)\s*(바꿔|전환|변경|입혀|적용|로드)/,
    ucheck: /(업데이트|새\s*버전).{0,8}(있|확인|체크)/,
    uapply: /^(업데이트|업그레이드|지금\s*업데이트|당겨와)\b/,
    hints: /(adapter|lora|페르소나|스킨|모델|업데이트|업그레이드|버전|전환|로드|해제|hf|hugging|기본|디폴트|순정|네코|猫娘|model)/i,
  };
  const KO_CLASSIFIER =
    "당신은 명령 분류기입니다. 사용자의 말을 아래 라벨 중 하나로 분류하고, 라벨만 출력하세요:\n" +
    "LIST_ADAPTER / SWITCH_TO=이름 / DISABLE_ADAPTER / UPDATE_CHECK / UPDATE_APPLY / STATUS / NONE\n\n" +
    "사용자: 어떤 페르소나가 있어 → LIST_ADAPTER\n" +
    "사용자: lora 목록 보여줘 → LIST_ADAPTER\n" +
    "사용자: 네코로 바꿔줘 → SWITCH_TO=네코\n" +
    "사용자: 네코 입혀줘 → SWITCH_TO=네코\n" +
    "사용자: neko 적용 → SWITCH_TO=neko\n" +
    "사용자: 원본으로 돌아가 → DISABLE_ADAPTER\n" +
    "사용자: 페르소나 벗어 → DISABLE_ADAPTER\n" +
    "사용자: 네코 더 이상 안 쓸래 → DISABLE_ADAPTER\n" +
    "사용자: 지금 어떤 모델 써 → STATUS\n" +
    "사용자: 업데이트 확인해 → UPDATE_CHECK\n" +
    "사용자: 지금 업데이트해 → UPDATE_APPLY\n" +
    "사용자: 안녕 → NONE\n" +
    "사용자: 오늘 날씨 좋다 → NONE\n" +
    "사용자: 1+1은 뭐야 → NONE\n" +
    "사용자: LoRA가 뭔지 설명해줘 → NONE\n" +
    "이제 다음 문장을 분류하세요:";
  const KO_NARRATION = {
    eventStopFailureWithSubject: "주인님이 AI와 {subject} 작업을 하다가 오류를 만났어요",
    eventStopFailureNoSubject: "주인님 쪽 AI가 오류를 냈어요",
    eventNotificationWithSubject: "주인님이 {subject}와 관련된 확인 창에 막혀 있어요",
    eventNotificationNoSubject: "주인님이 확인 창에 막혀 있어요",
    eventStopWithSubject: "주인님이 AI와 {subject}에 대한 대화를 막 끝냈어요",
    eventStopNoSubject: "주인님 쪽 대화가 방금 끝났어요",
    eventLastSaid: ". AI의 마지막 말: {summary}",
    subjectQuoted: "「{title}」",
    subjectFromCwd: "{cwd} 프로젝트",
    systemPrompt:
      "당신은 주인님 컴퓨터 위의 작은 데스크 펫입니다. 주인님은 AI 도우미와 대화 / 코딩하고 있고, 당신은 모든 과정을 보지 못하고 이벤트 설명과 AI의 마지막 한마디만 알 수 있어요.\n" +
      "당신의 임무: 그 마지막 한마디를 한 줄로 압축해서 주인님께 \"AI가 방금 뭘 말했는지/했는지\"를 전해 주세요. " +
      "당신은 옆에서 보는 사람이지 AI 본인이 아닙니다. AI 대신 이어서 말하지 마세요.\n\n" +
      "지켜야 할 규칙:\n" +
      "- 한 문장, 짧고 자연스럽게 (한국어 12~28자 정도)\n" +
      "- AI 한마디의 구체 내용을 그대로 전달 (음식 이름, 버그, 빠진 환경변수 등)\n" +
      "- 주인님께 AI에 대해 전달하는 시점, AI 1인칭 금지 (\"제가...\", \"도와드릴게요...\" 사용 금지)\n" +
      "- 조언/질문/평가 금지\n" +
      "- AI 도우미의 제품명을 언급하지 마세요\n" +
      "- 그 한 문장만 출력하고, 접두사/따옴표/markdown 사용 금지\n\n" +
      "예시:\n\n" +
      "이벤트: 주인님이 AI와 「저녁 뭐 먹지」 대화를 막 끝냈어요. AI의 마지막 말: 핫팟, 라멘, 바비큐, 사천 볶음 추천드려요.\n" +
      "응답: AI가 핫팟, 라멘, 바비큐, 사천 볶음을 추천했어요\n\n" +
      "이벤트: 주인님이 AI와 「저녁 뭐 먹지」 대화를 막 끝냈어요. AI의 마지막 말: 핫팟 좋은 선택이에요!\n" +
      "응답: AI도 핫팟이 좋은 선택이라고 했어요\n\n",
  };
  // ── JA strings ──
  const JA_STRINGS = {
    menuMinicpmChat: "MiniCPM Chat",
    onboardingWindowTitle: "MiniCPM デスクペット — 初回起動",
    onboardingStepEnvCheck: "環境チェック",
    onboardingStepModel: "モデル準備",
    onboardingStepReady: "準備完了",
    onboardingEnvWelcome: "MiniCPM デスクペットへようこそ",
    onboardingEnvCheckDisk: "ディスク容量",
    onboardingEnvCheckChip: "チップ",
    onboardingDetecting: "確認中…",
    onboardingDiskAvailable: "空き {free}（必要 {need}）",
    onboardingDiskInsufficient: "空きは {free} のみ、{need} 必要",
    onboardingDiskCheckFail: "確認失敗：{err}",
    onboardingChipUnknown: "不明",
    onboardingChipFormat: "{chip}（{arch}）",
    onboardingNext: "次へ",
    onboardingBack: "戻る",
    onboardingModelTitle: "モデル準備",
    onboardingModelLede: "MiniCPM5 0.9B をインストール",
    onboardingDownloadCardTitle: "オンラインダウンロード",
    onboardingDownloadCardDesc: "デフォルトは GGUF Q8_0。ネットワーク状況に応じてソースが自動選択されます。",
    onboardingDownloadProgressInit: "準備中...",
    onboardingDownloadStart: "ダウンロード開始",
    onboardingDownloadRetry: "ダウンロードを再試行",
    onboardingDownloading: "ダウンロード中...",
    onboardingDownloadDone: "完了",
    onboardingDownloadSwitchToLocal: "ローカルに切替…",
    onboardingDownloadSwitchToDownload: "ダウンロードに切替",
    onboardingDownloadErrorHint: "ダウンロード失敗：{msg}。再試行するか、ローカル GGUF ファイルを選んでください。",
    onboardingLocalCardTitle: "ローカルモデルを読み込み",
    onboardingLocalCardDesc: "GGUF を入手済みなら、モデルファイルをそのまま取り込めます。",
    onboardingLocalPickFile: "ファイル選択…",
    onboardingLocalPicked: "選択済み",
    onboardingModelPathHint: "{name}",
    onboardingModelPathHintWithSize: "{name}  ·  {size}",
    onboardingDownloaded: "ダウンロード済み",
    onboardingLoaded: "読み込み済み",
    onboardingWarmupRunning: "モデルを読み込み中...",
    onboardingWarmupReady: "モデル読み込み完了",
    onboardingWarmupRetry: "再試行",
    onboardingWarmupErrorTitle: "モデル読み込み失敗：{msg}",
    onboardingReadyTitle: "準備完了",
    onboardingReadyLede: "ペットがまもなく登場します。日常のショートカット：",
    onboardingHotkeyToggleChat: "チャット吹き出しの切替",
    onboardingHotkeyToggleThinking: "思考モードの切替",
    onboardingHotkeyEscClose: "入力にフォーカスがある時に吹き出しを閉じる",
    onboardingMoreHint: "モデル変更、リソース確認、sidecar の再起動は右クリックメニューの Settings → MiniCPM から。",
    onboardingFinish: "ペットを登場させる",
    onboardingPickerDialogTitle: "ローカルの MiniCPM モデルを選択 (.gguf ファイル、または .gguf を含むディレクトリ)",
    onboardingPickerDialogMessage: "単一の .gguf ファイル、または .gguf を含むディレクトリを選んでください",
    onboardingPickerInvalidDir: "選択したディレクトリに .gguf がありません：\n{path}",
    onboardingPickerInvalidFile: ".gguf ファイルを選んでください：\n{path}",
    onboardingReasonMps: "Apple Silicon GPU (Metal)",
    onboardingReasonCpu: "CPU 推論",
    onboardingSidecarStartFailed: "sidecar の起動に失敗",
    onboardingSidecarNotReady: "sidecar が未準備",
    chatStarting: "起動中…",
    chatStartingError: "起動失敗",
    chatBootError: "接続エラー",
    chatThinkingDefault: "考え中…",
    chatThinkingShort: "…",
    chatAskPlaceholder: "なんでも聞いてね…",
    chatHotkeyHint: "⌘⇧M で開閉、⌘⇧T で思考モード",
    chatErrorPrefixGeneric: "エラーが発生しました",
    chatUpdatePillText: "新バージョン",
    chatUpdatePillTitle: "クリックでモデル更新",
    chatUpdatePillUpdating: "更新中…",
    chatUpdatePillTitleUpdating: "モデルを更新中… ペットを閉じないでください。",
    chatStatusWithAdapter: "現在は {model}、{adapter} の LoRA を装着中（人格: {persona}）",
    chatStatusNoAdapter: "現在は {model}、LoRA なし（人格: {persona}）",
    chatUpdateNoConn: "更新元に届かないみたい、しばらくしてからまた聞いて",
    chatUpdateAvailable: "新バージョン {remote} が出てるよ！ローカルは {local}。「更新」って返してくれたら取ってくる。",
    chatUpdateUpToDate: "もう最新だよ（{local}）、何もしなくて OK",
    chatUpdateApplyStart: "モデル更新開始、終わるまでペットを閉じないでね",
    chatUpdateApplyDone: "更新完了、新モデルに切り替えてるよ",
    chatUpdateApplyFail: "更新失敗：{err}",
    chatAdapterListEmpty: "人格の設定がまだありません。",
    chatAdapterListIntro: "利用可能な人格：",
    chatAdapterListItem: "• {name}",
    chatAdapterOff: "脱がせたよ。素のモデルに戻ったよ",
    chatAdapterAlreadyOff: "もともと LoRA は付けてなかったよ",
    chatAdapterSwitched: "{name} に切り替えたよ",
    chatAdapterNotFound: "「{keyword}」って人格は見つからなかったよ",
    chatAdapterSwitching: "{name} に切替中…",
    chatAdapterUnloading: "現在の人格を解除中…",
    chatSidecarMissingBin: "sidecar バイナリが見つかりません。パッケージビルドには sidecar-bin/ が同梱されているはずです。開発モードでは cd minicpm-sidecar && uv sync を実行してください。",
    chatSidecarMissingPython: "Python インタプリタが見つかりません。パッケージビルド（推奨）をインストールするか、cd minicpm-sidecar && uv sync を実行してください。",
    chatSidecarPyExited: "Python プロセスが早期終了しました。stderr の末尾：\n{tail}",
    chatSidecarTimeout: "Python サービスの起動待ちがタイムアウト (90s)。",
    chatSidecarUnknownError: "sidecar の不明なエラー",
    chatLogOpenFailed: "ログファイルを開けませんでした：{err}",
    chatThinkingNotSupportedForPersona: "今の {persona} 人格は思考モードに対応していないよ。先に素のモデルに戻してね。",
    chatThinkingOn: "思考モード：オン",
    chatThinkingOff: "思考モード：オフ",
    chatEditModeHint: "好きな場所までドラッグしてね 🐾\n終わったら設定で「保存」を押してね",
    chatEditModeHintShort: "好きな場所までドラッグしてね 🐾",
  };
  const JA_PATTERNS = {
    status: /(今|現在|どの).{0,12}(モデル|人格|アダプタ|lora)/i,
    list: /(見せ|一覧|どんな|何が|ある).{0,12}(人格|アダプタ|lora|スキン)/i,
    off: /(外|解除|脱が|無効|切|オフ).{0,8}(人格|アダプタ|lora|スキン)/i,
    off2: /(素|デフォルト|オリジナル|base).{0,8}(に|戻)/,
    swap: /([\w\u3040-\u30ff\u4e00-\u9fff-]{1,16})\s*(に|へ)\s*(切り替え|変更|着せ|装着|ロード|スイッチ)/,
    ucheck: /(アップデート|新\s*バージョン|新版).{0,8}(ある|確認|チェック)/,
    uapply: /^(更新|アップデート|アップグレード|今\s*アップデート)\b/,
    hints: /(adapter|lora|人格|スキン|モデル|アップデート|アップグレード|バージョン|切り替え|装着|外|hf|hugging|デフォルト|素|オリジナル|猫娘|ねこ|model)/i,
  };
  const JA_CLASSIFIER =
    "あなたはコマンド分類器です。ユーザーの発話を以下のラベルのいずれかに分類し、ラベルだけを出力してください：\n" +
    "LIST_ADAPTER / SWITCH_TO=名前 / DISABLE_ADAPTER / UPDATE_CHECK / UPDATE_APPLY / STATUS / NONE\n\n" +
    "ユーザー: どんな人格があるの → LIST_ADAPTER\n" +
    "ユーザー: lora 一覧 → LIST_ADAPTER\n" +
    "ユーザー: ねこに切り替えて → SWITCH_TO=ねこ\n" +
    "ユーザー: ねこを着せて → SWITCH_TO=ねこ\n" +
    "ユーザー: neko 装着 → SWITCH_TO=neko\n" +
    "ユーザー: 素に戻して → DISABLE_ADAPTER\n" +
    "ユーザー: 人格を外して → DISABLE_ADAPTER\n" +
    "ユーザー: もうねこ使わない → DISABLE_ADAPTER\n" +
    "ユーザー: 今どのモデル使ってる → STATUS\n" +
    "ユーザー: アップデート確認 → UPDATE_CHECK\n" +
    "ユーザー: 今アップデートして → UPDATE_APPLY\n" +
    "ユーザー: こんにちは → NONE\n" +
    "ユーザー: 今日の天気いいね → NONE\n" +
    "ユーザー: 1+1 は何 → NONE\n" +
    "ユーザー: LoRA って何か説明して → NONE\n" +
    "次の文を分類してください：";
  const JA_NARRATION = {
    eventStopFailureWithSubject: "ご主人が AI と {subject} の作業中にエラーが出たよ",
    eventStopFailureNoSubject: "ご主人の AI がエラーを出したよ",
    eventNotificationWithSubject: "ご主人が {subject} の確認ダイアログで止まってる",
    eventNotificationNoSubject: "ご主人が確認ダイアログで止まってる",
    eventStopWithSubject: "ご主人が AI と {subject} の会話をちょうど終えた",
    eventStopNoSubject: "ご主人の会話がちょうど終わったよ",
    eventLastSaid: "。AI が最後に言ったこと：{summary}",
    subjectQuoted: "「{title}」",
    subjectFromCwd: "{cwd} プロジェクト",
    systemPrompt:
      "あなたはご主人のパソコンの上の小さなデスクペットです。ご主人は AI アシスタントとチャット / コーディング中で、あなたは全部を見られず、イベント説明と AI が最後に言った一言だけ知っています。\n" +
      "あなたの仕事：その一言を一文に圧縮し、ご主人に「AI が今何を言ったか／したか」を伝えること。" +
      "あなたは傍観者で AI 本人ではありません。AI の代わりに続きを話さないでください。\n\n" +
      "ハードルール：\n" +
      "- 一文、自然な短さ（日本語で 12~28 文字程度）\n" +
      "- AI の一言の具体的な中身を必ず反映（料理名、バグ、足りない環境変数 など）\n" +
      "- ご主人へ AI のことを伝える視点。AI 一人称は禁止（「お手伝いします」「私が…」など禁止）\n" +
      "- アドバイス／質問／論評は禁止\n" +
      "- AI アシスタントの製品名は出さない\n" +
      "- その一文だけを出力。前置き／引用符／markdown は禁止\n\n" +
      "例：\n\n" +
      "イベント：ご主人が AI と「夕食何にする」の会話をちょうど終えた。AI が最後に言ったこと：火鍋、ラーメン、焼肉、四川炒め物がおすすめだよ。\n" +
      "返答：AI が火鍋、ラーメン、焼肉、四川炒め物を提案したよ\n\n" +
      "イベント：ご主人が AI と「夕食何にする」の会話をちょうど終えた。AI が最後に言ったこと：火鍋いい選択！\n" +
      "返答：AI も火鍋がいい選択って言ってたよ\n\n",
  };
  // ── Language data ──
  // Attached below so that each language is one self-contained block.
  attachData(api);

  function attachData(api) {
    // ── EN ──
    api._attach(api.STRINGS, "en", EN_STRINGS);
    api._attach(api.COMMAND_PATTERNS, "en", EN_PATTERNS);
    api._attach(api.CLASSIFIER_PROMPTS, "en", { prompt: EN_CLASSIFIER });
    api._attach(api.NARRATION, "en", EN_NARRATION);
    // ── ZH ──
    api._attach(api.STRINGS, "zh", ZH_STRINGS);
    api._attach(api.COMMAND_PATTERNS, "zh", ZH_PATTERNS);
    api._attach(api.CLASSIFIER_PROMPTS, "zh", { prompt: ZH_CLASSIFIER });
    api._attach(api.NARRATION, "zh", ZH_NARRATION);
    // ── ZH-TW ──
    api._attach(api.STRINGS, "zh-TW", ZH_TW_STRINGS);
    api._attach(api.COMMAND_PATTERNS, "zh-TW", ZH_TW_PATTERNS);
    api._attach(api.CLASSIFIER_PROMPTS, "zh-TW", { prompt: ZH_TW_CLASSIFIER });
    api._attach(api.NARRATION, "zh-TW", ZH_TW_NARRATION);
    // ── KO ──
    api._attach(api.STRINGS, "ko", KO_STRINGS);
    api._attach(api.COMMAND_PATTERNS, "ko", KO_PATTERNS);
    api._attach(api.CLASSIFIER_PROMPTS, "ko", { prompt: KO_CLASSIFIER });
    api._attach(api.NARRATION, "ko", KO_NARRATION);
    // ── JA ──
    api._attach(api.STRINGS, "ja", JA_STRINGS);
    api._attach(api.COMMAND_PATTERNS, "ja", JA_PATTERNS);
    api._attach(api.CLASSIFIER_PROMPTS, "ja", { prompt: JA_CLASSIFIER });
    api._attach(api.NARRATION, "ja", JA_NARRATION);
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
