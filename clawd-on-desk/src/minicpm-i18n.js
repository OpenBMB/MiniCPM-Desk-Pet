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
    onboardingModelLede: "Point the pet at an OpenVINO model you converted",
    onboardingLocalCardTitle: "Load an OpenVINO model",
    onboardingLocalCardDesc: "Choose the IR directory — the folder holding openvino_model.xml.",
    onboardingLocalPicked: "Selected",
    onboardingModelPathHint: "{name}",
    onboardingModelPathHintWithSize: "{name}  ·  {size}",
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
    onboardingOpenvinoPickerTitle: "Choose an OpenVINO model directory",
    onboardingOpenvinoPickerMessage: "Pick the folder holding openvino_model.xml, or its parent",
    onboardingOpenvinoInvalidDir: "Not an OpenVINO model — openvino_model.xml is missing:\n{path}",
    onboardingOpenvinoPickDir: "Choose model folder",
    onboardingOpenvinoPickAnother: "Choose a different folder",
    onboardingOpenvinoConvertHint: "OpenVINO needs a converted model. Run: python minicpm-sidecar/scripts/convert-openvino.py --source <checkpoint> --preset gpu",
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
    // Chat sidecar errors
    chatSidecarMissingBin: "sidecar binary not found. Packaged builds should ship sidecar-bin/; for dev mode, run cd minicpm-sidecar && uv sync.",
    chatSidecarMissingPython: "Python interpreter not found. Install the packaged build (recommended), or cd minicpm-sidecar && uv sync.",
    chatSidecarPyExited: "Python exited early. stderr tail:\n{tail}",
    chatSidecarTimeout: "Timed out waiting for the Python service (90s).",
    chatSidecarUnknownError: "Unknown sidecar error",
    chatStatusEngine: "Running {model} on the {device}",
    chatLogOpenFailed: "Couldn't open the log file: {err}",
    chatThinkingOn: "Thinking mode: on",
    chatThinkingOff: "Thinking mode: off",
    chatEditModeHint: "Drag me where you want me, then hit Save in Settings.",
    chatEditModeHintShort: "Drag me where you want me",
  };
  const EN_PATTERNS = {
    status: /\b(what|which|current|now)\b.{0,30}\b(model|device|gpu|npu|running)\b/i,
    hints: /\b(model|device|gpu|npu|openvino|running|status)\b/i,
  };
  const EN_CLASSIFIER =
    "You are a command classifier. Map the user's message to one of the labels below and output ONLY the label:\n" +
    "STATUS / NONE\n\n" +
    "User: which model are you using → STATUS\n" +
    "User: what are you running on → STATUS\n" +
    "User: are you on the GPU or the NPU → STATUS\n" +
    "User: what device is this running on → STATUS\n" +
    "User: hi → NONE\n" +
    "User: what's the weather → NONE\n" +
    "User: what is 1+1 → NONE\n" +
    "User: explain OpenVINO → NONE\n" +
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
    onboardingModelLede: "指向你转换好的 OpenVINO 模型",
    onboardingLocalCardTitle: "加载 OpenVINO 模型",
    onboardingLocalCardDesc: "选择 IR 目录，也就是包含 openvino_model.xml 的那个文件夹。",
    onboardingLocalPicked: "已选择",
    onboardingModelPathHint: "{name}",
    onboardingModelPathHintWithSize: "{name}  ·  {size}",
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
    onboardingOpenvinoPickerTitle: "选择 OpenVINO 模型目录",
    onboardingOpenvinoPickerMessage: "请选中包含 openvino_model.xml 的文件夹，或它的上一层",
    onboardingOpenvinoInvalidDir: "所选目录不是 OpenVINO 模型（缺 openvino_model.xml）：\n{path}",
    onboardingOpenvinoPickDir: "选择模型目录",
    onboardingOpenvinoPickAnother: "换一个目录",
    onboardingOpenvinoConvertHint: "OpenVINO 需要先转换模型。运行：python minicpm-sidecar/scripts/convert-openvino.py --source <检查点> --preset gpu",
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
    chatSidecarMissingBin: "找不到 sidecar。打包模式下应内置 sidecar-bin/，开发模式请 cd minicpm-sidecar && uv sync。",
    chatSidecarMissingPython: "找不到 Python 解释器。请安装应用打包版（推荐），或 cd minicpm-sidecar && uv sync。",
    chatSidecarPyExited: "Python 进程提前退出。stderr 末尾：\n{tail}",
    chatSidecarTimeout: "等待 Python 服务就绪超时 (90s)。",
    chatSidecarUnknownError: "sidecar 未知错误",
    chatStatusEngine: "当前在 {device} 上跑 {model}",
    chatLogOpenFailed: "打开日志文件失败：{err}",
    chatThinkingOn: "思考已开启",
    chatThinkingOff: "思考已关闭",
    chatEditModeHint: "把我拖到喜欢的位置 🐾\n然后回到设置点「保存」",
    chatEditModeHintShort: "把我拖到喜欢的位置 🐾",
  };
  const ZH_PATTERNS = {
    status: /(你现在|当前|目前|现在).{0,4}(是什么|是啥|用的什么|用啥|什么模型|哪个模型|什么设备|哪个设备|跑在)/,
    hints: /(模型|设备|显卡|核显|gpu|npu|openvino|状态|在跑|跑在|model)/i,
  };
  const ZH_CLASSIFIER =
    "你是一个命令分类器。把用户的话映射到下面的标签之一，只输出标签：\n" +
    "STATUS / NONE\n\n" +
    "用户：你现在用的什么模型 → STATUS\n" +
    "用户：你跑在什么设备上 → STATUS\n" +
    "用户：现在是 GPU 还是 NPU → STATUS\n" +
    "用户：当前状态 → STATUS\n" +
    "用户：你好 → NONE\n" +
    "用户：今天天气怎么样 → NONE\n" +
    "用户：1+1 等于几 → NONE\n" +
    "用户：讲讲 OpenVINO → NONE\n" +
    "现在分类下一句：";
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
    onboardingModelLede: "指向你轉換好的 OpenVINO 模型",
    onboardingLocalCardTitle: "載入 OpenVINO 模型",
    onboardingLocalCardDesc: "選擇 IR 目錄，也就是包含 openvino_model.xml 的那個資料夾。",
    onboardingLocalPicked: "已選擇",
    onboardingModelPathHint: "{name}",
    onboardingModelPathHintWithSize: "{name}  ·  {size}",
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
    onboardingOpenvinoPickerTitle: "選擇 OpenVINO 模型目錄",
    onboardingOpenvinoPickerMessage: "請選取包含 openvino_model.xml 的資料夾，或它的上一層",
    onboardingOpenvinoInvalidDir: "所選目錄不是 OpenVINO 模型（缺 openvino_model.xml）：\n{path}",
    onboardingOpenvinoPickDir: "選擇模型目錄",
    onboardingOpenvinoPickAnother: "換一個目錄",
    onboardingOpenvinoConvertHint: "OpenVINO 需要先轉換模型。執行：python minicpm-sidecar/scripts/convert-openvino.py --source <檢查點> --preset gpu",
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
    chatSidecarMissingBin: "找不到 sidecar。打包模式下應內建 sidecar-bin/，開發模式請 cd minicpm-sidecar && uv sync。",
    chatSidecarMissingPython: "找不到 Python 直譯器。請安裝應用打包版（建議），或 cd minicpm-sidecar && uv sync。",
    chatSidecarPyExited: "Python 程序提前結束。stderr 末尾：\n{tail}",
    chatSidecarTimeout: "等待 Python 服務就緒逾時 (90s)。",
    chatSidecarUnknownError: "sidecar 未知錯誤",
    chatStatusEngine: "目前在 {device} 上跑 {model}",
    chatLogOpenFailed: "開啟記錄檔失敗：{err}",
    chatThinkingOn: "思考已開啟",
    chatThinkingOff: "思考已關閉",
    chatEditModeHint: "把我拖到喜歡的位置 🐾\n然後回到設定點「儲存」",
    chatEditModeHintShort: "把我拖到喜歡的位置 🐾",
  };
  const ZH_TW_PATTERNS = {
    status: /(你現在|目前|現在).{0,4}(是什麼|是啥|用的什麼|什麼模型|哪個模型|什麼裝置|哪個裝置|跑在)/,
    hints: /(模型|裝置|顯卡|核顯|gpu|npu|openvino|狀態|在跑|跑在|model)/i,
  };
  const ZH_TW_CLASSIFIER =
    "你是一個命令分類器。把使用者的話對應到下面的標籤之一，只輸出標籤：\n" +
    "STATUS / NONE\n\n" +
    "使用者：你現在用的什麼模型 → STATUS\n" +
    "使用者：你跑在什麼裝置上 → STATUS\n" +
    "使用者：現在是 GPU 還是 NPU → STATUS\n" +
    "使用者：目前狀態 → STATUS\n" +
    "使用者：你好 → NONE\n" +
    "使用者：今天天氣如何 → NONE\n" +
    "使用者：1+1 等於幾 → NONE\n" +
    "使用者：講講 OpenVINO → NONE\n" +
    "現在分類下一句：";
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
    onboardingModelLede: "변환해 둔 OpenVINO 모델을 지정하세요",
    onboardingLocalCardTitle: "OpenVINO 모델 불러오기",
    onboardingLocalCardDesc: "openvino_model.xml이 들어 있는 IR 디렉터리를 선택하세요.",
    onboardingLocalPicked: "선택됨",
    onboardingModelPathHint: "{name}",
    onboardingModelPathHintWithSize: "{name}  ·  {size}",
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
    onboardingOpenvinoPickerTitle: "OpenVINO 모델 디렉터리 선택",
    onboardingOpenvinoPickerMessage: "openvino_model.xml이 있는 폴더 또는 그 상위 폴더를 선택하세요",
    onboardingOpenvinoInvalidDir: "OpenVINO 모델이 아닙니다 — openvino_model.xml 없음:\n{path}",
    onboardingOpenvinoPickDir: "모델 폴더 선택",
    onboardingOpenvinoPickAnother: "다른 폴더 선택",
    onboardingOpenvinoConvertHint: "OpenVINO는 변환된 모델이 필요합니다. 실행: python minicpm-sidecar/scripts/convert-openvino.py --source <체크포인트> --preset gpu",
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
    chatSidecarMissingBin: "sidecar 바이너리를 찾을 수 없습니다. 패키지 빌드는 sidecar-bin/을 포함해야 하며, 개발 모드에서는 cd minicpm-sidecar && uv sync를 실행하세요.",
    chatSidecarMissingPython: "Python 인터프리터를 찾을 수 없습니다. 패키지 빌드(권장)를 설치하거나, cd minicpm-sidecar && uv sync를 실행하세요.",
    chatSidecarPyExited: "Python 프로세스가 일찍 종료되었습니다. stderr 끝부분:\n{tail}",
    chatSidecarTimeout: "Python 서비스 준비 대기 시간이 초과되었습니다 (90s).",
    chatSidecarUnknownError: "sidecar 알 수 없는 오류",
    chatStatusEngine: "{device}에서 {model} 실행 중",
    chatLogOpenFailed: "로그 파일 열기 실패: {err}",
    chatThinkingOn: "생각 모드: 켬",
    chatThinkingOff: "생각 모드: 끔",
    chatEditModeHint: "원하는 곳으로 드래그해 주세요 🐾\n다 되면 설정에서 \"저장\"을 눌러 주세요",
    chatEditModeHintShort: "원하는 곳으로 드래그해 주세요 🐾",
  };
  const KO_PATTERNS = {
    status: /(지금|현재|어떤).{0,12}(모델|장치|그래픽|gpu|npu)/i,
    hints: /(모델|장치|그래픽|gpu|npu|openvino|상태|실행|model)/i,
  };
  const KO_CLASSIFIER =
    "당신은 명령 분류기입니다. 사용자의 말을 아래 라벨 중 하나로 분류하고 라벨만 출력하세요:\n" +
    "STATUS / NONE\n\n" +
    "사용자: 지금 어떤 모델 쓰고 있어 → STATUS\n" +
    "사용자: 어떤 장치에서 실행 중이야 → STATUS\n" +
    "사용자: GPU야 NPU야 → STATUS\n" +
    "사용자: 현재 상태 → STATUS\n" +
    "사용자: 안녕 → NONE\n" +
    "사용자: 오늘 날씨 어때 → NONE\n" +
    "사용자: 1+1은 뭐야 → NONE\n" +
    "사용자: OpenVINO 설명해줘 → NONE\n" +
    "이제 다음 줄을 분류하세요:";
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
    onboardingModelLede: "変換済みの OpenVINO モデルを指定します",
    onboardingLocalCardTitle: "OpenVINO モデルを読み込み",
    onboardingLocalCardDesc: "openvino_model.xml がある IR ディレクトリを選んでください。",
    onboardingLocalPicked: "選択済み",
    onboardingModelPathHint: "{name}",
    onboardingModelPathHintWithSize: "{name}  ·  {size}",
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
    onboardingOpenvinoPickerTitle: "OpenVINO モデルのディレクトリを選択",
    onboardingOpenvinoPickerMessage: "openvino_model.xml があるフォルダ、またはその親を選んでください",
    onboardingOpenvinoInvalidDir: "OpenVINO モデルではありません — openvino_model.xml がありません：\n{path}",
    onboardingOpenvinoPickDir: "モデルフォルダを選択",
    onboardingOpenvinoPickAnother: "別のフォルダを選ぶ",
    onboardingOpenvinoConvertHint: "OpenVINO には変換済みモデルが必要です。実行: python minicpm-sidecar/scripts/convert-openvino.py --source <チェックポイント> --preset gpu",
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
    chatSidecarMissingBin: "sidecar バイナリが見つかりません。パッケージビルドには sidecar-bin/ が同梱されているはずです。開発モードでは cd minicpm-sidecar && uv sync を実行してください。",
    chatSidecarMissingPython: "Python インタプリタが見つかりません。パッケージビルド（推奨）をインストールするか、cd minicpm-sidecar && uv sync を実行してください。",
    chatSidecarPyExited: "Python プロセスが早期終了しました。stderr の末尾：\n{tail}",
    chatSidecarTimeout: "Python サービスの起動待ちがタイムアウト (90s)。",
    chatSidecarUnknownError: "sidecar の不明なエラー",
    chatStatusEngine: "{device} で {model} を実行中",
    chatLogOpenFailed: "ログファイルを開けませんでした：{err}",
    chatThinkingOn: "思考モード：オン",
    chatThinkingOff: "思考モード：オフ",
    chatEditModeHint: "好きな場所までドラッグしてね 🐾\n終わったら設定で「保存」を押してね",
    chatEditModeHintShort: "好きな場所までドラッグしてね 🐾",
  };
  const JA_PATTERNS = {
    status: /(今|現在|どの).{0,12}(モデル|デバイス|グラフィック|gpu|npu)/i,
    hints: /(モデル|デバイス|グラフィック|gpu|npu|openvino|状態|動いて|model)/i,
  };
  const JA_CLASSIFIER =
    "あなたはコマンド分類器です。ユーザーの発話を次のラベルのいずれかに分類し、ラベルのみを出力してください:\n" +
    "STATUS / NONE\n\n" +
    "ユーザー: 今どのモデルを使ってる → STATUS\n" +
    "ユーザー: どのデバイスで動いてる → STATUS\n" +
    "ユーザー: GPU それとも NPU → STATUS\n" +
    "ユーザー: 現在の状態 → STATUS\n" +
    "ユーザー: こんにちは → NONE\n" +
    "ユーザー: 今日の天気は → NONE\n" +
    "ユーザー: 1+1は → NONE\n" +
    "ユーザー: OpenVINO について教えて → NONE\n" +
    "次の行を分類してください:";
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
