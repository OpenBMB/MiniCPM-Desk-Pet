"use strict";
// MiniCPM Onboarding renderer — drives the 3-stage wizard UI.
//
// Stages:
//   1 env-check  — disk / network / platform sanity checks
//   2 model      — pick how to obtain the GGUF: online download OR local
//                   file. Once the model is in place, warmup runs inline on
//                   the same panel; "Next" is unlocked when BOTH are ready.
//   3 ready      — handoff to the pet window.
//
// Strings come from `minicpm-i18n.js` (loaded as a UMD <script> in
// onboarding.html). The current language is fetched from the main
// process via `window.onboarding.getI18n()` and refreshed live on
// `onboarding:lang-change`.

const STEPS = ["env-check", "model", "ready"];

const el = (id) => document.getElementById(id);
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const minicpmI18n = (typeof globalThis !== "undefined" && globalThis.ClawdMinicpmI18n) || null;
let currentLang = "en";
let t = minicpmI18n ? minicpmI18n.makeTranslator(() => currentLang) : (k) => k;

let currentStep = "env-check";
let modelStatus = "idle";    // "idle" | "downloading" | "ready"
let modelSource = null;      // "download" | "local"
let modelInfo = null;        // { path, sizeBytes } once ready
let warmupStatus = "idle";   // "idle" | "running" | "ready" | "error"
let warmupKicked = false;    // guard against double-firing warmup
let envCheckRan = false;     // re-paint env-check details on lang change
let downloadFailed = false;  // show an explicit retry affordance after failure

// Apply translations to all `data-i18n` elements. Called once on boot
// and again on every language change.
function applyStaticTranslations() {
  const root = document;
  for (const node of root.querySelectorAll("[data-i18n]")) {
    const key = node.getAttribute("data-i18n");
    if (!key) continue;
    node.textContent = t(key);
  }
  try { document.documentElement.setAttribute("lang", currentLang); } catch {}
  try { document.title = t("onboardingWindowTitle"); } catch {}
}

function bytesPretty(n) {
  if (!Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function basename(p) {
  if (!p) return "";
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function formatModelDetail(info) {
  if (!info || !info.path) return null;
  const name = basename(info.path);
  if (info.sizeBytes) {
    return t("onboardingModelPathHintWithSize", { name, size: bytesPretty(info.sizeBytes) });
  }
  return t("onboardingModelPathHint", { name });
}

function show(step) {
  currentStep = step;
  $$(".panel").forEach((p) => {
    p.classList.toggle("hidden", p.dataset.panel !== step);
  });
  $$(".step").forEach((s) => {
    const idx = STEPS.indexOf(s.dataset.step);
    const curIdx = STEPS.indexOf(step);
    s.classList.toggle("active", idx === curIdx);
    s.classList.toggle("done", idx < curIdx);
  });
}

// ── Step 1: env-check ─────────────────────────────────────────────────
async function runEnvCheck() {
  envCheckRan = true;
  const diskLi = el("check-disk");
  const diskDetail = el("check-disk-detail");
  const platLi = el("check-platform");
  const platDetail = el("check-platform-detail");

  diskLi.classList.remove("ok", "err");
  platLi.classList.remove("ok", "err");
  diskDetail.textContent = t("onboardingDetecting");
  platDetail.textContent = t("onboardingDetecting");

  await Promise.all([
    (async () => {
      try {
        const info = await window.onboarding.diskInfo();
        const free = Number.isFinite(info.freeBytes) ? bytesPretty(info.freeBytes) : "—";
        const need = Number.isFinite(info.requiredBytes) ? bytesPretty(info.requiredBytes) : "5 GB";
        diskDetail.textContent = info.ok
          ? t("onboardingDiskAvailable", { free, need })
          : (info.error
              ? t("onboardingDiskCheckFail", { err: info.error })
              : t("onboardingDiskInsufficient", { free, need }));
        diskLi.classList.add(info.ok ? "ok" : "err");
      } catch (err) {
        diskDetail.textContent = t("onboardingDiskCheckFail", { err: (err && err.message) || err });
        diskLi.classList.add("err");
      }
    })(),
    (async () => {
      try {
        const info = await window.onboarding.platformInfo();
        const chip = info && info.chip ? info.chip : t("onboardingChipUnknown");
        platDetail.textContent = info && info.arch
          ? t("onboardingChipFormat", { chip, arch: info.arch })
          : chip;
        platLi.classList.add(info && info.supported ? "ok" : "err");
      } catch (err) {
        platDetail.textContent = t("onboardingDiskCheckFail", { err: (err && err.message) || err });
        platLi.classList.add("err");
      }
    })(),
  ]);
}

// ── Step 2: model panel ───────────────────────────────────────────────
function setProgress(percent, detail) {
  el("progress-fill").style.width = `${Math.max(0, Math.min(100, percent))}%`;
  el("progress-percent").textContent = `${Math.round(percent)}%`;
  if (detail !== undefined) el("progress-detail").textContent = detail;
}

function paintModelCards() {
  const dlCard = el("model-card-download");
  const localCard = el("model-card-local");
  const dlBtn = el("model-download-btn");
  const localBtn = el("model-pick-local");
  const dlStatus = el("model-download-status");
  const dlStatusText = el("model-download-status-text");
  const dlProgress = el("model-progress-card");
  const localStatus = el("model-local-status");
  const localStatusText = el("model-local-status-text");

  dlCard.classList.remove("selected", "disabled");
  localCard.classList.remove("selected", "disabled");
  dlStatus.classList.add("hidden");
  localStatus.classList.add("hidden");
  dlProgress.classList.add("hidden");

  if (modelStatus === "downloading") {
    dlCard.classList.add("selected");
    localCard.classList.add("disabled");
    dlBtn.disabled = true;
    dlBtn.textContent = t("onboardingDownloading");
    localBtn.disabled = true;
    localBtn.textContent = t("onboardingLocalPickFile");
    dlProgress.classList.remove("hidden");
    return;
  }

  if (modelStatus === "ready") {
    if (modelSource === "download") {
      dlCard.classList.add("selected");
      dlStatus.classList.remove("hidden");
      dlStatusText.textContent = formatModelDetail(modelInfo) || t("onboardingDownloaded");
      dlBtn.disabled = true;
      dlBtn.textContent = t("onboardingDownloadDone");
      localBtn.disabled = false;
      localBtn.textContent = t("onboardingDownloadSwitchToLocal");
    } else {
      localCard.classList.add("selected");
      localStatus.classList.remove("hidden");
      localStatusText.textContent = formatModelDetail(modelInfo) || t("onboardingLoaded");
      localBtn.disabled = true;
      localBtn.textContent = t("onboardingLocalPicked");
      dlBtn.disabled = false;
      dlBtn.textContent = t("onboardingDownloadSwitchToDownload");
    }
    return;
  }

  // idle
  dlBtn.disabled = false;
  dlBtn.textContent = downloadFailed
    ? t("onboardingDownloadRetry")
    : t("onboardingDownloadStart");
  localBtn.disabled = false;
  localBtn.textContent = t("onboardingLocalPickFile");
}

function paintWarmupRow() {
  const row = el("warmup-row");
  const spinner = el("warmup-spinner");
  const check = row.querySelector(".warmup-check");
  const status = el("warmup-status");
  const retry = el("warmup-retry");

  if (modelStatus !== "ready") {
    row.classList.add("hidden");
    return;
  }
  row.classList.remove("hidden");
  row.classList.remove("done", "err");
  retry.classList.add("hidden");

  if (warmupStatus === "running" || warmupStatus === "idle") {
    spinner.style.display = "";
    check.style.display = "none";
    status.textContent = t("onboardingWarmupRunning");
  } else if (warmupStatus === "ready") {
    row.classList.add("done");
    spinner.style.display = "none";
    check.style.display = "";
    status.textContent = t("onboardingWarmupReady");
  } else if (warmupStatus === "error") {
    row.classList.add("err");
    spinner.style.display = "none";
    check.style.display = "none";
    status.textContent = t("onboardingWarmupErrorTitle", { msg: "" });
    retry.classList.remove("hidden");
  }
}

function updateNextBtn() {
  const nextBtn = el("model-next");
  nextBtn.disabled = !(modelStatus === "ready" && warmupStatus === "ready");
}

function paintModelPanel() {
  paintModelCards();
  paintWarmupRow();
  updateNextBtn();
}

async function detectExistingModel() {
  const state = await window.onboarding.getState().catch(() => null);
  if (state && state.modelPresent) {
    modelStatus = "ready";
    modelSource = "local";
    modelInfo = { path: state.modelDir || null, sizeBytes: null };
    paintModelPanel();
    void runWarmupInline();
  } else {
    modelStatus = "idle";
    modelSource = null;
    modelInfo = null;
    warmupStatus = "idle";
    warmupKicked = false;
    downloadFailed = false;
    paintModelPanel();
  }
}

async function startModelDownload() {
  const errBox = el("model-error");
  errBox.classList.add("hidden");

  const switching = modelStatus === "ready" && modelSource !== "download";
  if (switching) {
    resetWarmup();
    try { await window.onboarding.restartSidecar(); } catch {}
  }

  modelStatus = "downloading";
  modelSource = "download";
  downloadFailed = false;
  paintModelPanel();
  setProgress(0, t("onboardingDownloadProgressInit"));

  const unsub = window.onboarding.onProgress((p) => {
    if (p.event === "download" && p.phase === "transfer") {
      const done = p.bytes_done || 0;
      const total = p.bytes_total || 0;
      const pct = total > 0 ? (done / total) * 100 : 0;
      const detail = `${bytesPretty(done)} / ${bytesPretty(total)}${p.file ? "  ·  " + p.file : ""}`;
      setProgress(pct, detail);
    } else if (p.event === "download" && p.phase === "swap") {
      setProgress(98, t("onboardingDownloading"));
    } else if (p.event === "download" && p.phase === "complete") {
      setProgress(100, t("onboardingDownloadDone"));
    } else if (p.event === "download" && p.phase === "reloaded") {
      setProgress(100, t("onboardingLoaded"));
    } else if (p.event === "error") {
      errBox.textContent = t("onboardingWarmupErrorTitle", { msg: p.message || p.phase || "" });
      errBox.classList.remove("hidden");
    }
  });

  const r = await window.onboarding.startModelDownload();
  if (unsub) unsub();

  if (r && r.ok) {
    const state = await window.onboarding.getState().catch(() => null);
    modelStatus = "ready";
    modelSource = "download";
    modelInfo = {
      path: (state && state.modelDir) || null,
      sizeBytes: null,
    };
    paintModelPanel();
    void runWarmupInline();
  } else {
    modelStatus = "idle";
    modelSource = null;
    downloadFailed = true;
    paintModelPanel();
    errBox.textContent = t("onboardingDownloadErrorHint", {
      msg: (r && r.error) || "",
    });
    errBox.classList.remove("hidden");
  }
}

async function pickLocalModel() {
  const errBox = el("model-error");
  errBox.classList.add("hidden");

  const switching = modelStatus === "ready" && modelSource !== "local";

  const r = await window.onboarding.pickLocalModel();
  if (r && r.ok) {
    downloadFailed = false;
    if (switching) {
      resetWarmup();
      try { await window.onboarding.restartSidecar(); } catch {}
    }
    modelStatus = "ready";
    modelSource = "local";
    modelInfo = { path: r.modelDir || null, sizeBytes: null };
    paintModelPanel();
    void runWarmupInline();
  } else if (r && !r.canceled) {
    errBox.textContent = r.error || t("onboardingWarmupErrorTitle", { msg: "" });
    errBox.classList.remove("hidden");
  }
}

function resetWarmup() {
  warmupStatus = "idle";
  warmupKicked = false;
  paintWarmupRow();
  updateNextBtn();
}

async function runWarmupInline() {
  if (warmupKicked && warmupStatus !== "error") return;
  warmupKicked = true;
  warmupStatus = "running";
  paintWarmupRow();
  updateNextBtn();

  const errBox = el("model-error");

  const unsub = window.onboarding.onProgress((p) => {
    if (p.event === "error" && p.phase && p.phase !== "download") {
      errBox.textContent = t("onboardingWarmupErrorTitle", { msg: `${p.phase}: ${p.message}` });
      errBox.classList.remove("hidden");
    }
  });

  const r = await window.onboarding.warmup();
  if (unsub) unsub();

  if (r && r.ok) {
    warmupStatus = "ready";
    errBox.classList.add("hidden");
  } else {
    warmupStatus = "error";
    errBox.textContent = t("onboardingWarmupErrorTitle", { msg: (r && r.error) || "" });
    errBox.classList.remove("hidden");
  }
  paintWarmupRow();
  updateNextBtn();
}

// ── Live language change ──────────────────────────────────────────────
function applyLang(lang) {
  if (typeof lang !== "string" || !lang) return;
  currentLang = lang;
  applyStaticTranslations();
  // Re-paint dynamic UI areas in the new language.
  if (envCheckRan) {
    void runEnvCheck();
  }
  if (currentStep === "model") {
    paintModelPanel();
  }
}

async function bootstrapI18n() {
  let initial = "en";
  try {
    if (window.onboarding && typeof window.onboarding.getI18n === "function") {
      const payload = await window.onboarding.getI18n();
      if (payload && typeof payload.lang === "string") initial = payload.lang;
    }
  } catch {}
  currentLang = initial;
  applyStaticTranslations();
  if (window.onboarding && typeof window.onboarding.onLangChange === "function") {
    window.onboarding.onLangChange((payload) => {
      if (payload && typeof payload.lang === "string") applyLang(payload.lang);
    });
  }
}

// ── Wire up navigation ────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", async () => {
  await bootstrapI18n();
  show("env-check");
  void runEnvCheck();

  el("env-next").addEventListener("click", async () => {
    show("model");
    await detectExistingModel();
  });

  el("model-download-btn").addEventListener("click", () => { void startModelDownload(); });
  el("model-pick-local").addEventListener("click", () => { void pickLocalModel(); });
  el("warmup-retry").addEventListener("click", () => {
    warmupKicked = false;
    warmupStatus = "idle";
    void runWarmupInline();
  });

  el("model-next").addEventListener("click", () => {
    show("ready");
  });

  el("ready-finish").addEventListener("click", async () => {
    await window.onboarding.complete();
  });

  $$("[data-back]").forEach((b) => {
    b.addEventListener("click", () => show(b.dataset.back));
  });
});
