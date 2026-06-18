"use strict";
// MiniCPM Chat renderer — extracted from minicpm-chat.html so we can ship
// it as an external <script> (CSP `script-src 'self'`) and so the chat UI
// can be localized via `minicpm-i18n.js` (loaded as a UMD before this file).
//
// All hardcoded user-facing strings are routed through the translator
// `t(key, params)` driven by `currentLang`. Command regexes and the
// LLM classifier prompt likewise come from per-language config so the
// pet's natural-language commands work in en / zh / zh-TW / ko / ja.
//
// The actual flow / typewriter / streaming logic is unchanged from the
// original inline script — only the strings have moved.

// ── i18n bootstrap ──
const minicpmI18n = (typeof globalThis !== "undefined" && globalThis.ClawdMinicpmI18n) || null;
const chatContext = (typeof globalThis !== "undefined" && globalThis.ClawdMinicpmChatContext) || null;
let currentLang = "en";
const t = minicpmI18n ? minicpmI18n.makeTranslator(() => currentLang) : (k) => k;
let RGX = minicpmI18n ? minicpmI18n.getCommandPatterns(currentLang) : {};
let COMMAND_HINTS = RGX.hints || /./;
let CLASSIFIER_PROMPT = minicpmI18n ? minicpmI18n.getClassifierPrompt(currentLang) : "";

function applyLang(lang) {
  if (typeof lang !== "string" || !lang) return;
  currentLang = lang;
  if (minicpmI18n) {
    RGX = minicpmI18n.getCommandPatterns(lang);
    COMMAND_HINTS = RGX.hints || /./;
    CLASSIFIER_PROMPT = minicpmI18n.getClassifierPrompt(lang);
  }
  try { document.documentElement.setAttribute("lang", lang); } catch {}
  try { document.title = "MiniCPM"; } catch {}
  // Update statically-rendered strings (update pill, ask placeholder, etc.).
  refreshStaticUi();
}

function refreshStaticUi() {
  if (!updPill) return;
  updPill.title = t("chatUpdatePillTitle");
  // If pill is showing default text (no remote_revision merged in), refresh.
  if (updPillRevision == null) {
    updPill.textContent = t("chatUpdatePillText");
  }
  // If the user is currently in ask phase with the empty placeholder,
  // refresh it so a language change takes effect immediately.
  if (inputEl) {
    inputEl.placeholder = t("chatAskPlaceholder");
  }
}

// Event listener: open native context menu on right-click. Replaced the
// inline `oncontextmenu` attribute since CSP no longer permits inline JS.
document.body.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  if (window.minicpm && typeof window.minicpm.openContextMenu === "function") {
    window.minicpm.openContextMenu();
  }
});

const SIDECAR_URL = "http://127.0.0.1:18765";

// ── element refs ──
const bubble = document.getElementById("bubble");
const content = document.getElementById("content");
const updPill = document.getElementById("updPill");

// ── module state ──
let phase = "hidden";        // hidden | starting | ask | thinking | speak | error
let booted = false;
let sidecarUrl = null;
let history = [];            // multi-turn conversation; persists across opens
let abortCtrl = null;
let fadeTimer = null;
let inputEl = null;          // <textarea> while in ask state
// Tracks the latest remote revision shown in the update pill so we can
// re-render its label on a language change without losing the version.
let updPillRevision = null;

// Persisted default lives in minicpm-prefs.json (Settings → 默认思考模式).
// thinkingOverride is a per-session override from ⌘⇧T; null means follow
// the persisted default on each submit.
let thinkingOverride = null;

function resolveThinking(chatParams) {
  if (typeof thinkingOverride === "boolean") return thinkingOverride;
  return !!(chatParams && chatParams.thinking);
}

// ── window helpers ──
function clearFade() {
  if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
}

async function setBubbleSize(width, height) {
  // shell has 7px inset on each side (just enough for the tail to poke out)
  if (window.minicpm && window.minicpm.resize) {
    await window.minicpm.resize(width + 14, height + 14);
  }
}

async function showBubble() {
  clearFade();
  bubble.classList.remove("fading");
  // The window itself may have been hidden via hideWindow() while we were
  // waiting on the model. Bring it back before animating the bubble in.
  if (window.minicpm && window.minicpm.showWindow) {
    try { await window.minicpm.showWindow(); } catch {}
  }
  requestAnimationFrame(() => bubble.classList.add("show"));
}

async function hideBubble({ fade = true } = {}) {
  clearFade();
  await clearChatAnchor();
  if (!fade) {
    bubble.classList.remove("show", "fading");
    if (window.minicpm && window.minicpm.hideWindow) await window.minicpm.hideWindow();
    phase = "hidden";
    return;
  }
  bubble.classList.add("fading");
  bubble.classList.remove("show");
  fadeTimer = setTimeout(async () => {
    fadeTimer = null;
    bubble.classList.remove("fading");
    if (window.minicpm && window.minicpm.hideWindow) await window.minicpm.hideWindow();
    phase = "hidden";
  }, 220);
}

function setSide(side) {
  // side from main: 'right' | 'left' | 'above' | 'below'
  bubble.setAttribute("data-side", side || "right");
}

// ── bootstrap (Python sidecar) ──
async function ensureBooted() {
  if (booted) return true;
  showStarting();
  const r = await window.minicpm.start({});
  if (!r.ok) {
    showError(r.error || t("chatStartingError"));
    return false;
  }
  sidecarUrl = r.url || SIDECAR_URL;
  booted = true;
  return true;
}

// ── render: starting ──
async function showStarting() {
  phase = "starting";
  const main = t("chatStarting");
  content.innerHTML =
    '<div class="thinking-row"><span class="spinner"></span><span>' +
    escapeHtml(main) +
    '</span></div>';
  await measureAndShow({ width: naturalDisplayWidth(main) });
}

// ── render: error ──
async function showError(msg) {
  phase = "error";
  content.innerHTML = `<div class="err-text">⚠️ ${escapeHtml(msg.split("\n")[0])}<pre>${escapeHtml(msg)}</pre></div>`;
  await measureAndShow({ width: naturalDisplayWidth(msg, { max: 360 }) });
}

// ── render: ask (input field) ──
// When there's a `lastReply`, render in continuous-chat mode: a fixed-
// size bubble where the previous reply scrolls inside its own region
// at the top, and the input box is pinned at the bottom. While typing,
// the bubble's outer dimensions stay locked — only inner regions scroll.
async function showAsk(lastReply) {
  clearFade();
  phase = "ask";
  abortCtrl = null;

  // Whenever we enter ask-with-reply, FIRST clear any prior chat anchor
  // (so initial measurement is centered), then re-pin after the bubble
  // has settled. This avoids the bubble sliding sideways on first show.
  if (window.minicpm && window.minicpm.setChatAnchor) {
    try { await window.minicpm.setChatAnchor(null); } catch {}
  }

  if (lastReply) {
    // Continuous-chat layout: bubble starts compact, grows as user types.
    // Outer height tracks content.offsetHeight via measureAndShow.
    const placeholder = escapeHtml(t("chatAskPlaceholder"));
    content.innerHTML =
      '<div class="chat-pane">' +
        '<div class="last-reply-region rendered" id="last-reply-region">' + renderMarkdown(lastReply) + '</div>' +
        '<div class="ask-input-wrap">' +
          '<textarea id="ask-input" placeholder="' + placeholder + '" rows="1"></textarea>' +
        '</div>' +
      '</div>';
    inputEl = document.getElementById("ask-input");
    inputEl.addEventListener("input", () => autoresizeFixed(inputEl));
    inputEl.addEventListener("keydown", onAskKey);
    await measureAndShow();
    const lr = document.getElementById("last-reply-region");
    if (lr) lr.scrollTop = lr.scrollHeight;
    // Now that the bubble is sized & placed, pin its bottom Y so future
    // grows extend UP (textarea stays under the user's gaze) instead of
    // re-centering on the pet (which would shove the textarea down too).
    if (window.minicpm && window.minicpm.setChatAnchor) {
      const r = bubble.getBoundingClientRect();
      // measureAndShow → setBounds set the window position; we need its
      // BOTTOM in screen coords. window.screenY + window inner height
      // approximates the bottom of the bubble panel.
      const bottomY = (window.screenY || 0) + window.innerHeight;
      try { await window.minicpm.setChatAnchor(bottomY); } catch {}
    }
  } else {
    // First-open compact layout: bubble starts as a tiny pill that just
    // fits the placeholder text, expanding horizontally as user types.
    const placeholder = escapeHtml(t("chatAskPlaceholder"));
    content.innerHTML =
      '<textarea id="ask-input" placeholder="' + placeholder + '" rows="1"></textarea>';
    inputEl = document.getElementById("ask-input");
    inputEl.addEventListener("input", () => autoresize(inputEl));
    inputEl.addEventListener("keydown", onAskKey);
    await measureAndShow({ width: naturalAskWidth("") });
  }
  if (window.minicpm && window.minicpm.focusWindow) {
    try { await window.minicpm.focusWindow(); } catch {}
  }
  setTimeout(() => inputEl && inputEl.focus(), 30);
}

// In continuous-chat mode the bubble follows content size: empty = small,
// long input = big. Resize the textarea internally then ask the window
// to remeasure so its outer height tracks. animate:false avoids the
// CSS opacity transition kicking in on every keystroke.
function autoresizeFixed(ta) {
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  measureAndShow({ animate: false });
}

function autoresize(ta) {
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 96) + "px";
  // Bubble width grows with text — empty = ~100px, full multi-line = 320px max.
  const w = naturalAskWidth(ta.value);
  measureAndShow({ animate: false, width: w });
}

async function onAskKey(e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = "";
    await submit(text);
  } else if (e.key === "Escape") {
    e.preventDefault();
    await dismiss();
  }
}

// ── render: thinking (transient — pet does the heavy work animating) ──
async function showThinking(label) {
  phase = "thinking";
  const text = label != null ? label : t("chatThinkingDefault");
  content.innerHTML = '<div class="thinking-row"><span class="spinner"></span><span>' + escapeHtml(text) + '</span></div>';
  await measureAndShow();
}

async function clearChatAnchor() {
  if (window.minicpm && window.minicpm.setChatAnchor) {
    try { await window.minicpm.setChatAnchor(null); } catch {}
  }
}

// ── render: think-stream (peek of the model's reasoning) ──
async function showThink() {
  phase = "think-stream";
  await clearChatAnchor();
  content.innerHTML = `<div class="think-stream" id="think-text"></div>`;
  // Speak/think phases get a comfortable reading width up front so the
  // streaming text doesn't wrap aggressively from the previous narrow
  // ask bubble width.
  await measureAndShow({ width: 300 });
}

// ── render: speak (streamed assistant reply) ──
async function showSpeak() {
  phase = "speak";
  await clearChatAnchor();
  content.innerHTML = `<div class="speak streaming" id="speak"></div>`;
  await measureAndShow({ width: 300 });
}

// Animate the bubble fading out, briefly drop the window, then fade it back
// in with new content. Used when the model finishes thinking and starts
// speaking — gives a "thought, then said it" cadence.
async function fadeOutAndHide(ms = 220) {
  return new Promise((resolve) => {
    clearFade();
    bubble.classList.add("fading");
    bubble.classList.remove("show");
    setTimeout(async () => {
      bubble.classList.remove("fading");
      if (window.minicpm && window.minicpm.hideWindow) {
        try { await window.minicpm.hideWindow(); } catch {}
      }
      resolve();
    }, ms);
  });
}

// ── helpers ──
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// ── tiny Markdown → HTML renderer ─────────────────────────────────────
// Handles **bold**, *italic*, headings (h1–h3), unordered / ordered
// lists, horizontal rules, inline / fenced code, and paragraphs. Always
// HTML-escapes the input first so model output cannot inject markup.
// Used for the post-streaming reply and the pinned last-reply pane —
// during streaming the typewriter still feeds plain text via textContent
// so the user sees a smooth char-by-char reveal.
function renderMarkdown(text) {
  if (text == null) return "";
  let s = escapeHtml(String(text));

  // Reserve code spans first so later inline / block rules can't
  // mangle code contents. The \x00 sentinel never appears in normal
  // text and survives the HTML-escape step above.
  const blocks = [];
  s = s.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_m, code) => {
    const i = blocks.length;
    blocks.push(`<pre><code>${code.replace(/^\n|\n+$/g, "")}</code></pre>`);
    return `\x00B${i}\x00`;
  });
  const inlines = [];
  s = s.replace(/`([^`\n]+)`/g, (_m, code) => {
    const i = inlines.length;
    inlines.push(`<code>${code}</code>`);
    return `\x00I${i}\x00`;
  });

  // Inline emphasis. Bold first so paired `**` never gets eaten by the
  // single-`*` italic rule. The italic lookbehind/lookahead avoid
  // matching mid-word `*` (e.g. function names with stars).
  s = s.replace(/\*\*([^*\n][^\n]*?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_\n][^\n]*?)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[\s>(])\*([^*\n]+?)\*(?=[\s<.,;:!?)\]]|$)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[\s>(])_([^_\n]+?)_(?=[\s<.,;:!?)\]]|$)/g, "$1<em>$2</em>");

  // Block rules, line-anchored. Anything that doesn't match a block
  // becomes a paragraph (consecutive non-block lines joined with <br>).
  const lines = s.split("\n");
  const out = [];
  const isPlaceholder = (l) => /^\x00B\d+\x00$/.test(l.trim());
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isPlaceholder(line)) { out.push(line.trim()); i++; continue; }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) { out.push(`<h${h[1].length}>${h[2]}</h${h[1].length}>`); i++; continue; }
    if (/^\s*---+\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
    if (/^[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(`<li>${lines[i].replace(/^[-*]\s+/, "")}</li>`);
        i++;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${lines[i].replace(/^\d+\.\s+/, "")}</li>`);
        i++;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }
    if (line.trim() === "") { i++; continue; }
    const para = [];
    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === "" || /^(?:#{1,3}\s|[-*]\s|\d+\.\s|\s*---+\s*$)/.test(l) || isPlaceholder(l)) break;
      para.push(l);
      i++;
    }
    if (para.length) out.push(`<p>${para.join("<br>")}</p>`);
  }

  let result = out.join("");
  result = result.replace(/\x00B(\d+)\x00/g, (_m, idx) => blocks[+idx]);
  result = result.replace(/\x00I(\d+)\x00/g, (_m, idx) => inlines[+idx]);
  return result;
}

// Hidden measurement span — used to compute the natural width of the
// currently-typed text so the bubble window can auto-fit to it.
const widthMeasurer = (() => {
  const s = document.createElement("span");
  s.style.cssText = "visibility:hidden; position:absolute; left:-9999px; top:0; white-space:pre; font:inherit;";
  document.body.appendChild(s);
  return s;
})();

async function measureAndShow({ animate = true, width = null } = {}) {
  const padY = 14;
  bubble.style.height = "auto";
  const cw = width !== null
    ? width
    : Math.max(220, bubble.offsetWidth || 280);
  const ch = Math.max(28, content.offsetHeight + padY);
  await setBubbleSize(cw, ch);
  if (animate) showBubble();
  else bubble.classList.add("show");
}

// Compute the natural width an input + content needs at the current font.
// Used in compact ask-mode (no lastReply) so the bubble starts tiny and
// expands with the typed text. Returns a value in pixels including all
// horizontal padding/inset.
function naturalAskWidth(text) {
  const sample = text && text.length > 0 ? text : t("chatAskPlaceholder");
  widthMeasurer.style.font = window.getComputedStyle(content).font;
  widthMeasurer.textContent = sample;
  const textW = widthMeasurer.offsetWidth;
  return Math.max(80, Math.min(320, Math.round(textW + 32)));
}

// For fixed-text panels (command replies, errors, narration, speak phase, …)
// the bubble should be wide enough to read comfortably without breaking
// short prompts onto multiple lines. Measures the longest line of `text`
// and clamps to a comfortable range.
function naturalDisplayWidth(text, { min = 220, max = 320, padding = 32 } = {}) {
  const lines = String(text || "").split(/\r?\n/);
  widthMeasurer.style.font = window.getComputedStyle(content).font;
  let widest = 0;
  for (const line of lines) {
    widthMeasurer.textContent = line || " ";
    if (widthMeasurer.offsetWidth > widest) widest = widthMeasurer.offsetWidth;
  }
  return Math.max(min, Math.min(max, Math.round(widest + padding)));
}

// ── flow ──
// Render a command result inside the bubble. Auto-fades after dwell.
async function showCommandReply(cmd) {
  clearFade();
  phase = "narration";
  const text = cmd.text || "";
  const escaped = escapeHtml(text);
  const accent = cmd.ok === false ? "#ff6b6b" : "var(--accent)";
  content.innerHTML = `
    <div style="display:flex; gap:6px; align-items:flex-start;">
      <span style="font-size:13px; line-height:1; color:${accent}; padding-top:1px;">🐾</span>
      <span style="font-size:13px; color:var(--text); white-space:pre-wrap; word-wrap:break-word;">${escaped}</span>
    </div>`;
  // +30 padding for the icon column so multi-line replies don't wrap
  // tighter than the icon alignment.
  await measureAndShow({ animate: true, width: naturalDisplayWidth(text, { min: 240, padding: 56 }) });
  const dwell = clamp(2800 + text.length * 100, 3500, 11000);
  fadeTimer = setTimeout(() => {
    fadeTimer = null;
    hideBubble({ fade: true });
  }, dwell);
}

// Same visual as showCommandReply, but pinned in place — no fade — used
// while a long-running command (adapter swap, model update) is mid-flight.
async function showCommandProgress(text) {
  clearFade();
  phase = "narration";
  const escaped = escapeHtml(text || "");
  content.innerHTML = `
    <div style="display:flex; gap:6px; align-items:flex-start;">
      <span class="spinner" style="margin-top:3px;"></span>
      <span style="font-size:13px; color:var(--text); white-space:pre-wrap; word-wrap:break-word;">${escaped}</span>
    </div>`;
  await measureAndShow({ animate: true, width: naturalDisplayWidth(text || "", { min: 220, padding: 56 }) });
}

// ── Intent classification: two-stage hybrid ──
// Stage 1: loose regex layer — fast, no model call, ~95% of explicit phrasings.
// Stage 2: LLM classifier — for fuzzy / colloquial messages that the regex
//          misses. Constrains the model to emit a single token like
//          "SWITCH_TO=neko" / "DISABLE" / "NONE", parses, and dispatches.
//          Skipped for messages that don't smell like a command at all
//          so casual chat stays fast.

// `RGX` and `COMMAND_HINTS` are populated dynamically in `applyLang()` so
// the natural-language command surface adapts to the user's UI language.

async function tryHandleAsCommand(text, onProgress) {
  const t = text.trim();
  if (!t) return null;
  const progress = onProgress || (async () => {});

  // ── Stage 1: regex (free, instant) ──
  const stage1 = matchByRegex(t);
  if (stage1) return await dispatch(stage1, t, progress);

  // ── Stage 2: LLM classifier (≈1-2s) — gated ──
  // Only run for messages that look like they might be a management
  // command. If you talk to the pet about anything else the request
  // skips the classifier entirely and goes straight to chat.
  if (t.length <= 50 && COMMAND_HINTS.test(t)) {
    try {
      await progress("…");
      const intent = await classifyIntentWithLLM(t);
      if (intent) return await dispatch(intent, t, progress);
    } catch (err) {
      console.warn("LLM classifier failed:", err);
    }
  }
  return null; // fall through to chat
}

// Trailing particle stripper for swap matches. Per-language particles —
// English/Korean/Japanese mostly don't suffix the keyword, but Chinese
// (both variants) often does (吧/啊/呢/了/嘛/哦/哈/喵). Keep all in one
// regex so it's safe across languages.
const TRAILING_PARTICLES = /(吧|啊|呢|了|嘛|哦|哈|喵|よ|ね|ぞ|だ|です|요|네)+$/u;

function matchByRegex(text) {
  // Patterns can be missing if the dictionary load failed — guard each.
  if (RGX.status && RGX.status.test(text)) return { intent: "status" };
  if (RGX.uapply && RGX.uapply.test(text)) return { intent: "update_apply" };
  if (RGX.ucheck && RGX.ucheck.test(text)) return { intent: "update_check" };
  if (RGX.list && RGX.list.test(text))   return { intent: "list" };
  if (RGX.off && RGX.off.test(text))    return { intent: "off" };
  if (RGX.off2 && RGX.off2.test(text))   return { intent: "off" };
  if (RGX.swap) {
    const m = text.match(RGX.swap);
    if (m) {
      // Some languages capture the persona name in group 1, others in
      // group 2 — pick whichever non-trivial group we get.
      const candidate = (m[2] || m[1] || "").trim();
      if (candidate) {
        const kw = candidate.replace(TRAILING_PARTICLES, "").trim();
        if (kw) return { intent: "switch", keyword: kw };
      }
    }
  }
  return null;
}

// Few-shot LLM classifier — the 0.9B base model with greedy decode and
// 12 few-shot examples. ~350ms per call. We tried first-token logit
// scoring with single-char labels but the logit signal-to-noise on
// 0.9B is too low (correct vs wrong winner often <0.4 apart).
async function classifyIntentWithLLM(text) {
  // Per-language few-shot prompt; loaded by applyLang().
  const sysprompt = CLASSIFIER_PROMPT || "";
  const body = {
    messages: [{ role: "user", content: text }],
    system: sysprompt,
    stream: false,
    max_new_tokens: 16,
    thinking: false,
    temperature: 0,
    top_p: 1,
    repetition_penalty: 1.0,
    silent: true,
    disable_adapter: true,
  };
  const resp = await fetch(sidecarUrl + "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) return null;
  const d = await resp.json();
  let reply = (d.content || "").trim();
  reply = reply.split(/\r?\n/)[0].replace(/^[`'""'']+|[`'""''.。]+$/g, "").trim();
  // Sometimes the model echoes the example format "用户：xxx → LABEL".
  // Strip everything before the arrow so we get the label cleanly.
  if (reply.includes("→")) reply = reply.split("→").pop().trim();
  console.log("[classifier]", JSON.stringify(text), "→", JSON.stringify(reply));

  // Search anywhere in the reply for one of the known labels — handles
  // any leading garbage the model leaks through.
  if (/\bNONE\b/i.test(reply))             return null;
  if (/\bLIST_ADAPTER\b/i.test(reply))     return { intent: "list" };
  if (/\bDISABLE_ADAPTER\b/i.test(reply))  return { intent: "off" };
  if (/\bUPDATE_CHECK\b/i.test(reply))     return { intent: "update_check" };
  if (/\bUPDATE_APPLY\b/i.test(reply))     return { intent: "update_apply" };
  if (/\bSTATUS\b/i.test(reply))           return { intent: "status" };
  const m = reply.match(/SWITCH_TO\s*=\s*([^\s,。]+)/i);
  if (m) {
    const kw = m[1].replace(/[「」『』"'""''.。]/g, "").trim();
    if (kw) return { intent: "switch", keyword: kw };
  }
  return null;
}

async function dispatch(intent, fullMsg, progress) {
  switch (intent.intent) {
    case "status":       return runStatusQuery();
    case "list":         return runAdapterList();
    case "off":          return runAdapterOff(progress);
    case "switch":       return runAdapterSwitchByKeyword(intent.keyword, fullMsg, progress);
    case "update_check": return runUpdateCheck();
    case "update_apply": return runUpdateApply(progress);
    default:             return null;
  }
}

async function runStatusQuery() {
  const r = await fetch(sidecarUrl + "/api/health");
  const d = await r.json();
  const persona = d.persona || "default";
  const model = d.model_name || "(unknown)";
  const adapter = d.adapter ? (d.adapter.split("/").pop()) : null;
  const text = adapter
    ? t("chatStatusWithAdapter", { model, adapter, persona })
    : t("chatStatusNoAdapter", { model, persona });
  return { ok: true, text };
}

async function runUpdateCheck() {
  const r = await fetch(sidecarUrl + "/api/update-check");
  const d = await r.json();
  if (!d) return { ok: false, text: t("chatUpdateNoConn") };
  if (d.available) {
    return {
      ok: true,
      text: t("chatUpdateAvailable", {
        remote: d.remote_revision || "?",
        local: d.local_revision || "?",
      }),
    };
  }
  return { ok: true, text: t("chatUpdateUpToDate", { local: d.local_revision || "?" }) };
}

async function runUpdateApply(progress) {
  await progress(t("chatUpdateApplyStart"));
  showUpdateProgress({ phase: "start" });
  if (window.minicpm && window.minicpm.updateApply) {
    await window.minicpm.updateApply();
  }
  await refreshUpdateBadge();
  return {
    ok: true,
    text: t("chatUpdateApplyDone"),
    resetHistory: true,
  };
}

async function runAdapterList() {
  const r = await fetch(sidecarUrl + "/api/adapters");
  const d = await r.json();
  if (!d.items || !d.items.length) {
    return { ok: true, text: t("chatAdapterListEmpty") };
  }
  const lines = d.items.map((a) => t("chatAdapterListItem", { name: a.name }) + (a.path === d.current ? "  ←" : ""));
  return {
    ok: true,
    text: t("chatAdapterListIntro") + "\n" + lines.join("\n"),
  };
}

async function runAdapterOff(progress) {
  await (progress || (() => {}))(t("chatAdapterUnloading"));
  // Route through the main-proc IPC so we get the same 90s timeout
  // and the same `active_adapter_id` persistence the Settings tab
  // enjoys. Direct fetch from the renderer used to hit a shorter
  // implicit timeout on cold restart of llama-server and skipped
  // the prefs write, leaving the user's choice unsaved across
  // sidecar restarts.
  const d = (window.minicpm && window.minicpm.loadAdapter)
    ? await window.minicpm.loadAdapter(null)
    : null;
  if (!d || !d.ok) {
    return { ok: false, text: t("chatUpdateApplyFail", { err: (d && d.error) || t("chatSidecarUnknownError") }) };
  }
  return {
    ok: true,
    text: t("chatAdapterOff"),
    resetHistory: true,  // submit() will skip pushing this turn AND wipe `history`
  };
}

// Keywords that mean "stop using any LoRA" rather than "switch to a
// specific persona". These stay hardcoded because they're product
// vocabulary, not adapter metadata; the rest of the routing is fully
// data-driven from the manifest exposed via /api/adapters.
// Cross-language vocabulary for "go back to the base model". These are
// product-level keywords (not localized strings the user reads), so we
// keep them as a single Set covering all supported UI langs.
const DISABLE_ADAPTER_KEYWORDS = new Set([
  // English
  "base", "default", "vanilla", "plain", "original",
  // 简体中文
  "原版", "默认", "原始", "裸", "纯净", "普通",
  // 繁體中文
  "原版", "預設", "純淨", "純净",
  // 한국어
  "원본", "기본", "순정", "디폴트",
  // 日本語
  "素", "デフォルト", "オリジナル", "ベース",
]);

// Find the manifest item that best matches `kw` (already lowercased).
// Strategies in descending confidence:
//   1) exact alias hit
//   2) alias substring (tolerates classifier truncation like "猫娘"→"娘")
//   3) displayName substring
//   4) filename substring (legacy fallback for adapters without a
//      manifest entry — preserves the pre-manifest UX)
function pickAdapterByKeyword(items, kw) {
  const probe = (kw || "").toLowerCase().trim();
  if (!probe) return null;
  const visible = items.filter((it) => !it.missing);
  // 1) exact alias
  for (const it of visible) {
    const aliases = Array.isArray(it.aliases) ? it.aliases : [];
    if (aliases.some((a) => String(a).toLowerCase() === probe)) return it;
  }
  // 2) alias substring
  for (const it of visible) {
    const aliases = Array.isArray(it.aliases) ? it.aliases : [];
    if (aliases.some((a) => {
      const al = String(a).toLowerCase();
      return al && (al.includes(probe) || probe.includes(al));
    })) return it;
  }
  // 3) displayName substring
  for (const it of visible) {
    const dn = String(it.displayName || "").toLowerCase();
    if (dn && (dn.includes(probe) || probe.includes(dn))) return it;
  }
  // 4) filename substring fallback
  for (const it of visible) {
    if (String(it.name || "").toLowerCase().includes(probe)) return it;
  }
  return null;
}

async function runAdapterSwitchByKeyword(keyword, fullMessage, progress) {
  const onProgress = progress || (async () => {});
  const kw = (keyword || "").toLowerCase().trim();

  // Disable keywords short-circuit before we even touch /api/adapters,
  // so "切回原版" still works when the user has no LoRAs registered.
  if (DISABLE_ADAPTER_KEYWORDS.has(kw)) {
    return runAdapterOff(onProgress);
  }

  const r = await fetch(sidecarUrl + "/api/adapters");
  const d = await r.json();
  const items = (d && Array.isArray(d.items)) ? d.items : [];
  if (!items.length) {
    return { ok: true, text: t("chatAdapterListEmpty") };
  }

  const pick = pickAdapterByKeyword(items, kw);
  if (!pick) {
    return { ok: true, text: t("chatAdapterNotFound", { keyword }) };
  }
  if (pick.path === d.current) {
    return { ok: true, text: t("chatAdapterSwitched", { name: pick.displayName || pick.name }) };
  }
  return await doSwap(pick);

  async function doSwap(picked) {
    const label = picked.displayName || picked.name;
    await onProgress(t("chatAdapterSwitching", { name: label }));
    // Route through the main-proc IPC (same handler the Settings tab
    // uses) so we share its 90s timeout + the `active_adapter_id`
    // persistence. The direct-fetch flow used to skip both: chat-side
    // switches worked in the current session but didn't survive a
    // sidecar restart, and a cold reload (Base → LoRA) sometimes
    // hit shorter renderer timeouts.
    const sd = (window.minicpm && window.minicpm.loadAdapter)
      ? await window.minicpm.loadAdapter(picked.path)
      : null;
    if (!sd || !sd.ok) {
      return { ok: false, text: t("chatUpdateApplyFail", { err: (sd && sd.error) || t("chatSidecarUnknownError") }) };
    }

    // Persona-LoRAs don't follow the <think> chat template, so flip
    // thinking off when switching INTO one. Going back to base leaves
    // the user's preference alone.
    const newPersona = sd.persona || "default";
    let chatParams = {};
    try {
      chatParams = (window.minicpm && typeof window.minicpm.getChatParams === "function")
        ? (await window.minicpm.getChatParams()) || {}
        : {};
    } catch {}
    if (newPersona !== "default" && resolveThinking(chatParams)) {
      thinkingOverride = false;
    }
    return {
      ok: true,
      text: t("chatAdapterSwitched", { name: label }),
      resetHistory: true,
    };
  }
}

async function submit(text) {
  // Try command intents first. If matched, render the result as the
  // assistant turn and skip the model call entirely.
  try {
    const cmd = await tryHandleAsCommand(text, async (progressText) => {
      // Show interim progress immediately so the user knows the request
      // is being worked on (adapter swaps take ~3-4 s).
      await showCommandProgress(progressText);
    });
    if (cmd) {
      if (cmd.resetHistory) {
        // Adapter / model swap: the chat "voice" just changed, so we wipe
        // the entire prior history AND we don't even keep this admin turn
        // — meta-config chatter shouldn't anchor the new model.
        history = [];
      } else {
        history.push({ role: "user", content: text });
        history.push({ role: "assistant", content: cmd.text });
      }
      await showCommandReply(cmd);
      return;
    }
  } catch (err) {
    console.error("command dispatch error:", err);
  }

  history.push({ role: "user", content: text });

  // Tell the sidecar: start generating. The sidecar pushes pet states
  // (thinking → working → attention) to clawd-on-desk over HTTP, so the
  // pet animates while we wait.
  abortCtrl = new AbortController();

  // Brief "thinking" hint, then hide the bubble so the pet's own reaction
  // animation takes the spotlight. The bubble reappears as soon as the
  // first delta arrives.
  await showThinking("…");
  setTimeout(() => {
    if (phase === "thinking") hideBubble({ fade: true });
  }, 350);

  let replyAcc = "";
  let thinkAcc = "";
  let speakEl = null;
  let thinkEl = null;
  let sawThink = false;
  let sawReply = false;
  let typer = null;

  // Re-measure + auto-scroll the active streaming pane on every painted char.
  function onTick() {
    measureAndShow({ animate: false });
    if (typer && typer.target) typer.target.scrollTop = typer.target.scrollHeight;
  }

  // Pull persisted generation params from main proc on every submit so
  // the Settings tab can hot-tune them without bouncing the bubble.
  let chatParams = {};
  try {
    chatParams = (window.minicpm && typeof window.minicpm.getChatParams === "function")
      ? (await window.minicpm.getChatParams()) || {}
      : {};
  } catch {}
  // thinkingOverride (⌘⇧T) takes precedence over the persisted default
  // when the user has overridden this session.
  const effectiveThinking = resolveThinking(chatParams);
  // Sidecar bumps max_new_tokens to ≥1280 when thinking=true so the
  // <think> block doesn't consume the whole generation budget.
  const maxNewTokens = chatParams.max_new_tokens || 768;

  // Bound the prompt before it reaches the sidecar: a sliding window + token
  // estimate keeps the oldest turns from silently overflowing llama-server's
  // KV window (default 4096). `messagesToSend` is what we transmit; we also
  // prune `history` itself to the turn cap so memory stays bounded.
  let messagesToSend = history;
  if (chatContext && typeof chatContext.trimHistoryForContext === "function") {
    messagesToSend = chatContext.trimHistoryForContext(history, { maxNewTokens });
    const cap = chatContext.MAX_HISTORY_TURNS;
    if (Number.isFinite(cap) && history.length > cap) {
      history = history.slice(-cap);
    }
  }

  try {
    const resp = await fetch(sidecarUrl + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: messagesToSend,
        stream: true,
        max_new_tokens: maxNewTokens,
        temperature: (typeof chatParams.temperature === "number") ? chatParams.temperature : 0.6,
        top_p: (typeof chatParams.top_p === "number") ? chatParams.top_p : 0.95,
        top_k: (typeof chatParams.top_k === "number") ? chatParams.top_k : 0,
        repetition_penalty: (typeof chatParams.repetition_penalty === "number") ? chatParams.repetition_penalty : 1.05,
        thinking: effectiveThinking,
      }),
      signal: abortCtrl.signal,
    });
    if (!resp.ok) throw new Error("HTTP " + resp.status);

    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (!block.startsWith("data:")) continue;
        const payload = block.slice(5).trim();
        if (!payload) continue;
        let obj;
        try { obj = JSON.parse(payload); } catch { continue; }

        if (obj.event === "think" && effectiveThinking) {
          if (!sawThink) {
            sawThink = true;
            await showThink();
            thinkEl = document.getElementById("think-text");
            typer = new Typewriter(thinkEl, { onChange: onTick });
          }
          thinkAcc += obj.content;
          typer.feed(obj.content);
        } else if (obj.event === "delta") {
          // First reply chunk → drain whatever's left in the thought
          // typewriter, then transition to a fresh reply bubble.
          if (!sawReply) {
            sawReply = true;
            if (typer) await typer.drain();
            if (sawThink && phase === "think-stream") {
              await fadeOutAndHide(220);
              await new Promise((r) => setTimeout(r, 100));
            }
            await showSpeak();
            speakEl = document.getElementById("speak");
            typer = new Typewriter(speakEl, { onChange: onTick });
          }
          replyAcc += obj.content;
          typer.feed(obj.content);
        } else if (obj.event === "error") {
          throw new Error(obj.message || "model error");
        }
      }
    }

    if (typer) await typer.drain();
    history.push({ role: "assistant", content: replyAcc });
    if (speakEl) {
      speakEl.classList.remove("streaming");
      // Swap the plain typewriter text for a markdown-rendered version
      // once the stream completes — keeps the streaming reveal smooth
      // (no HTML thrash per chunk) while still presenting bold/italics/
      // headings/lists/code in their final form.
      speakEl.classList.add("rendered");
      speakEl.innerHTML = renderMarkdown(replyAcc);
    }

    // ── New: keep the bubble alive for follow-up turns. After a tiny
    // dwell so the streaming animation settles, swap the speak content
    // back to an ask box so the user can type the next message without
    // having to re-click the pet. If no follow-up arrives within the
    // inactivity window, the bubble fades quietly.
    const readingMs = 1500;
    const lastReply = replyAcc;
    fadeTimer = setTimeout(async () => {
      fadeTimer = null;
      // Re-render with the previous reply pinned dimly above a fresh input.
      await showAsk(lastReply);
      // Auto-fade if user idles in ask phase for ~25s.
      fadeTimer = setTimeout(() => {
        fadeTimer = null;
        if (phase === "ask" && (!inputEl || !inputEl.value.trim())) {
          hideBubble({ fade: true });
        }
      }, 25000);
    }, readingMs);
  } catch (err) {
    if (typer) typer.stop();
    if (err.name === "AbortError") return;
    await showError(err.message || String(err));
    setTimeout(() => hideBubble({ fade: true }), 4000);
  }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ── Typewriter: paint chars at a steady, focused pace ────────────────────
// The model can produce tokens in bursty chunks (a Chinese word at a time).
// The typewriter buffers them and reveals chars one-by-one at ~16ms/char,
// catching up faster when the backlog grows so we never fall too far behind.
class Typewriter {
  constructor(target, { tickMs = 16, onChange = () => {} } = {}) {
    this.target = target;
    this.tickMs = tickMs;
    this.buf = "";
    this.timer = null;
    this.onChange = onChange;
    this._doneResolvers = [];
  }
  feed(text) {
    if (!text) return;
    this.buf += text;
    if (!this.timer) this._start();
  }
  _start() {
    this.timer = setInterval(() => {
      if (!this.buf.length) {
        clearInterval(this.timer);
        this.timer = null;
        const rs = this._doneResolvers.slice();
        this._doneResolvers.length = 0;
        rs.forEach((r) => r());
        return;
      }
      // Adaptive: catch up faster when backlog grows. ~60 char/s nominal,
      // up to ~250 char/s when buffer is huge. Feels like an attentive
      // typist rather than a print queue.
      const n = this.buf.length > 120 ? 4
              : this.buf.length > 40  ? 2
              : 1;
      const chunk = this.buf.slice(0, n);
      this.buf = this.buf.slice(n);
      this.target.textContent += chunk;
      this.onChange();
    }, this.tickMs);
  }
  // Wait for the buffer to fully drain (used before transitioning think→speak).
  drain() {
    return new Promise((resolve) => {
      if (!this.buf.length && !this.timer) { resolve(); return; }
      this._doneResolvers.push(resolve);
    });
  }
  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.buf = "";
    this._doneResolvers = [];
  }
  reset(target) {
    this.stop();
    if (target) this.target = target;
    this.target.textContent = "";
  }
}

// ── public commands invoked from main process ──
async function cmdOpen({ side } = {}) {
  if (side) setSide(side);
  // If we were waiting / generating, dismiss it so the user can type.
  if (abortCtrl) {
    try { abortCtrl.abort(); } catch {}
    abortCtrl = null;
  }
  if (!await ensureBooted()) return;
  await showAsk();
}

async function cmdDismiss() {
  if (abortCtrl) {
    try { abortCtrl.abort(); } catch {}
    abortCtrl = null;
  }
  await hideBubble({ fade: true });
}

async function cmdReset() {
  history = [];
  thinkingOverride = null;
  if (phase === "ask" && inputEl) inputEl.value = "";
}

function cmdToggleThinking() {
  // Legacy sync helper — the live path is onToggleThinking below.
  thinkingOverride = !resolveThinking({});
  return thinkingOverride;
}

async function dismiss() { await cmdDismiss(); }

let toastTimer = null;
async function showToast(text) {
  if (toastTimer) clearTimeout(toastTimer);
  const prevPhase = phase;
  const prevHTML = content.innerHTML;
  content.innerHTML = `<div style="text-align:center;color:var(--muted);font-size:12px;padding:2px 0;">${escapeHtml(text)}</div>`;
  await measureAndShow();
  toastTimer = setTimeout(async () => {
    toastTimer = null;
    if (prevPhase === "ask") {
      await showAsk();
    } else if (prevPhase === "hidden" || prevPhase === "starting") {
      await hideBubble({ fade: true });
    } else {
      content.innerHTML = prevHTML;
      await measureAndShow({ animate: false });
    }
  }, 1200);
}

if (window.minicpm) {
  if (window.minicpm.onOpen) window.minicpm.onOpen(cmdOpen);
  if (window.minicpm.onDismiss) window.minicpm.onDismiss(cmdDismiss);
  if (window.minicpm.onReset) window.minicpm.onReset(cmdReset);
  if (window.minicpm.onToggleThinking) window.minicpm.onToggleThinking(async () => {
    // When a persona LoRA is loaded, thinking-mode is broken (the model
    // doesn't emit </think>). Warn instead of letting the user flip it on
    // and stare at an empty bubble.
    let persona = "default";
    try {
      const r = await fetch(sidecarUrl + "/api/health");
      const d = await r.json();
      persona = d.persona || "default";
    } catch {}
    let chatParams = {};
    try {
      chatParams = (window.minicpm && typeof window.minicpm.getChatParams === "function")
        ? (await window.minicpm.getChatParams()) || {}
        : {};
    } catch {}
    const willEnable = !resolveThinking(chatParams);
    if (willEnable && persona !== "default") {
      showToast(t("chatThinkingNotSupportedForPersona", { persona }));
      return;
    }
    thinkingOverride = willEnable;
    showToast(willEnable ? t("chatThinkingOn") : t("chatThinkingOff"));
  });
  if (window.minicpm.onUpdateStatus) window.minicpm.onUpdateStatus(updateBadge);
  if (window.minicpm.onUpdateApplying) window.minicpm.onUpdateApplying(showUpdateProgress);
  if (window.minicpm.onNarrate) window.minicpm.onNarrate(showNarration);
  // Out-of-band system messages (e.g. "已切换到 X" pushed from the
  // Settings panel after an adapter swap). Routed to the same
  // showCommandReply path the in-chat commands use, with optional
  // history wipe so the new persona starts clean.
  if (window.minicpm.onCmdReply) window.minicpm.onCmdReply(async (cmd) => {
    if (!cmd || !cmd.text) return;
    if (cmd.resetHistory) history = [];
    await showCommandReply(cmd);
  });
  // Drag-to-position: turn the whole window into a draggable handle
  // and render a sample bubble so the user has something to grab.
  if (window.minicpm.onEditMode) window.minicpm.onEditMode(async (payload) => {
    if (payload && payload.enabled) {
      enterEditMode();
    } else {
      exitEditMode();
    }
  });
}

// ── Drag-to-position edit mode ─────────────────────────────────────────
// Toggled by the Settings panel via ipcMain → renderer. While on, the
// whole bubble window is OS-draggable (CSS region: drag) and shows a
// fixed sample. Settings captures bubble.getBounds() on save and turns
// that into a (dx, dy) offset relative to the pet hit rect.
async function enterEditMode() {
  if (abortCtrl) { try { abortCtrl.abort(); } catch {} abortCtrl = null; }
  clearFade();
  phase = "narration";
  // Apply drag region to body and the bubble shell.
  document.body.classList.add("edit-mode");
  const hint = t("chatEditModeHint");
  const hintShort = t("chatEditModeHintShort");
  content.innerHTML =
    '<div style="display:flex; gap:6px; align-items:flex-start;">' +
      '<span style="font-size:14px; line-height:1; color:var(--accent); padding-top:1px;">📍</span>' +
      '<span style="font-size:13px; color:var(--text); white-space:pre-wrap;">' + escapeHtml(hint) + '</span>' +
    '</div>';
  await measureAndShow({ animate: true, width: naturalDisplayWidth(hintShort, { min: 240, padding: 56 }) });
}

function exitEditMode() {
  document.body.classList.remove("edit-mode");
  // The main proc hides the window for us; just reset internal phase
  // so the next open starts clean.
  clearFade();
  phase = "hidden";
}

// ── Narration: ambient one-line reaction to coding-agent events ────────
async function showNarration({ text, kind }) {
  if (!text) return;
  if (phase === "speak" || phase === "think-stream") return;
  if (abortCtrl) { try { abortCtrl.abort(); } catch {} abortCtrl = null; }

  clearFade();
  phase = "narration";
  const escaped = escapeHtml(text);
  const accent = kind === "StopFailure" ? "#ff6b6b" : "var(--accent)";
  content.innerHTML = `
    <div style="display:flex; gap:6px; align-items:flex-start;">
      <span style="font-size:13px; line-height:1; color:${accent}; padding-top:1px;">🐾</span>
      <span style="font-size:13px; color:var(--text); white-space:pre-wrap; word-wrap:break-word;">${escaped}</span>
    </div>`;
  await measureAndShow({ animate: true, width: naturalDisplayWidth(text, { min: 220, padding: 56 }) });
}

// ── Updater UI ────────────────────────────────────────────────────────────
updPill.addEventListener("click", async () => {
  // Switch to "applying" mode immediately, then start the SSE flow.
  showUpdateProgress({ phase: "start" });
  if (window.minicpm && window.minicpm.updateApply) {
    await window.minicpm.updateApply();
  }
  // updateBadge will fire via onUpdateStatus after refresh
  await refreshUpdateBadge();
});

async function refreshUpdateBadge() {
  if (window.minicpm && window.minicpm.updateStatus) {
    const s = await window.minicpm.updateStatus();
    updateBadge(s);
  }
}

function updateBadge(status) {
  if (!status || !status.available) {
    updPill.style.display = "none";
    updPillRevision = null;
    return;
  }
  updPillRevision = status.remote_revision || null;
  updPill.textContent = updPillRevision
    ? `${t("chatUpdatePillText")} ${updPillRevision}`
    : t("chatUpdatePillText");
  updPill.title = t("chatUpdatePillTitle");
  updPill.style.display = "inline-flex";
}

let updProgressEl = null;
function showUpdateProgress(ev) {
  // Render a focused "downloading" view that takes over the bubble until done.
  if (ev.phase === "start" || !updProgressEl) {
    phase = "speak"; // borrow speak phase so toast/transitions don't fire
    content.innerHTML =
      '<div class="upd-progress">' +
        '<div id="upd-text">' + escapeHtml(t("chatUpdateApplyStart")) + '</div>' +
        '<div class="bar"><i id="upd-bar"></i></div>' +
      '</div>';
    measureAndShow({ width: 280 });
    updProgressEl = {
      text: document.getElementById("upd-text"),
      bar: document.getElementById("upd-bar"),
    };
  }
  if (!updProgressEl) return;

  if (ev.phase === "transfer" && ev.bytes_total > 0) {
    const pct = Math.min(100, (ev.bytes_done / ev.bytes_total) * 100);
    updProgressEl.bar.style.width = pct.toFixed(1) + "%";
    const mb = (n) => (n / (1024 * 1024)).toFixed(1);
    updProgressEl.text.textContent = t("onboardingDownloading") + ` ${mb(ev.bytes_done)} / ${mb(ev.bytes_total)} MB`;
  } else if (ev.phase === "swap") {
    updProgressEl.text.textContent = t("onboardingDownloading");
  } else if (ev.phase === "complete") {
    updProgressEl.bar.style.width = "100%";
    updProgressEl.text.textContent = t("chatUpdateApplyDone");
  } else if (ev.phase === "reloaded") {
    updProgressEl.text.textContent = "✓ " + t("onboardingWarmupReady");
    setTimeout(() => {
      updProgressEl = null;
      hideBubble({ fade: true });
      refreshUpdateBadge();
    }, 1500);
  } else if (ev.phase === "error" || ev.phase === "reload-error") {
    updProgressEl.text.textContent = t("chatUpdateApplyFail", {
      err: ev.message || t("chatSidecarUnknownError"),
    });
    setTimeout(() => {
      updProgressEl = null;
      hideBubble({ fade: true });
    }, 4000);
  }
}

// ── i18n bootstrap (after all functions are declared) ──
async function bootstrapI18n() {
  if (window.minicpm && typeof window.minicpm.getI18n === "function") {
    try {
      const payload = await window.minicpm.getI18n();
      if (payload && typeof payload.lang === "string") applyLang(payload.lang);
    } catch {}
  } else {
    applyLang(currentLang);
  }
  if (window.minicpm && typeof window.minicpm.onLangChange === "function") {
    window.minicpm.onLangChange((payload) => {
      if (payload && typeof payload.lang === "string") applyLang(payload.lang);
    });
  }
}

// Initial check on first load (will also fire when main pushes status).
refreshUpdateBadge();

// First-render: attempt to open right away (the main process opens us
// after creating the window, but we also handle the case where we're
// loaded standalone).
bootstrapI18n().finally(() => cmdOpen({}));
