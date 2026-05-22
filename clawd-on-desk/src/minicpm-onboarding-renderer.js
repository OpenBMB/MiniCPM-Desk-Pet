"use strict";
// MiniCPM Onboarding renderer — drives the 3-stage wizard UI.
//
// Stages:
//   1 env-check  — disk / network / platform sanity checks
//   2 model      — pick how to obtain the GGUF: online download OR local
//                   file. Once the model is in place, warmup runs inline on
//                   the same panel; "下一步" is unlocked when BOTH are ready.
//   3 ready      — handoff to the pet window.
//
// Accelerator selection was retired in this redesign — the sidecar auto
// picks Metal / CUDA / CPU based on the host platform. Settings tab can
// still override later.

const STEPS = ["env-check", "model", "ready"];

const el = (id) => document.getElementById(id);
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let currentStep = "env-check";
let modelStatus = "idle";    // "idle" | "downloading" | "ready"
let modelSource = null;      // "download" | "local"
let modelInfo = null;        // { path, sizeBytes } once ready
let warmupStatus = "idle";   // "idle" | "running" | "ready" | "error"
let warmupKicked = false;    // guard against double-firing warmup

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

// ── Step 1: env-check ─────────────────────────────────────────────────
// Each row resolves live from the main process: disk space pulls fs.statfs
// against userData, chip pulls sysctl / os.cpus(). The detail cell on the
// right shows the actual values so the user knows exactly what they have.
async function runEnvCheck() {
  const diskLi = el("check-disk");
  const diskDetail = el("check-disk-detail");
  const platLi = el("check-platform");
  const platDetail = el("check-platform-detail");

  diskLi.classList.remove("ok", "err");
  platLi.classList.remove("ok", "err");
  diskDetail.textContent = "检测中…";
  platDetail.textContent = "检测中…";

  await Promise.all([
    (async () => {
      try {
        const info = await window.onboarding.diskInfo();
        const free = Number.isFinite(info.freeBytes) ? bytesPretty(info.freeBytes) : "—";
        const need = Number.isFinite(info.requiredBytes) ? bytesPretty(info.requiredBytes) : "5 GB";
        diskDetail.textContent = info.ok
          ? `可用 ${free}（需要 ${need}）`
          : (info.error
              ? `检测失败：${info.error}`
              : `仅剩 ${free}，需要 ${need}`);
        diskLi.classList.add(info.ok ? "ok" : "err");
      } catch (err) {
        diskDetail.textContent = `检测失败：${err && err.message || err}`;
        diskLi.classList.add("err");
      }
    })(),
    (async () => {
      try {
        const info = await window.onboarding.platformInfo();
        const chip = info && info.chip ? info.chip : "未知";
        platDetail.textContent = info && info.arch ? `${chip}（${info.arch}）` : chip;
        platLi.classList.add(info && info.supported ? "ok" : "err");
      } catch (err) {
        platDetail.textContent = `检测失败：${err && err.message || err}`;
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
    // During an active download we lock the other card to avoid races —
    // partial files + a sidecar swap would corrupt onboarding state.
    dlCard.classList.add("selected");
    localCard.classList.add("disabled");
    dlBtn.disabled = true;
    dlBtn.textContent = "下载中...";
    localBtn.disabled = true;
    localBtn.textContent = "选择文件…";
    dlProgress.classList.remove("hidden");
    return;
  }

  if (modelStatus === "ready") {
    // Show the selected card with ✓ + filename. The OTHER card stays
    // fully clickable so the user can switch sources at any time.
    if (modelSource === "download") {
      dlCard.classList.add("selected");
      dlStatus.classList.remove("hidden");
      dlStatusText.textContent = modelInfo && modelInfo.path
        ? `${basename(modelInfo.path)}${modelInfo.sizeBytes ? "  ·  " + bytesPretty(modelInfo.sizeBytes) : ""}`
        : "已下载";
      dlBtn.disabled = true;
      dlBtn.textContent = "已完成";
      localBtn.disabled = false;
      localBtn.textContent = "改为本地…";
    } else {
      localCard.classList.add("selected");
      localStatus.classList.remove("hidden");
      localStatusText.textContent = modelInfo && modelInfo.path
        ? `${basename(modelInfo.path)}${modelInfo.sizeBytes ? "  ·  " + bytesPretty(modelInfo.sizeBytes) : ""}`
        : "已加载";
      localBtn.disabled = true;
      localBtn.textContent = "已选择";
      dlBtn.disabled = false;
      dlBtn.textContent = "改为下载";
    }
    return;
  }

  // idle
  dlBtn.disabled = false;
  dlBtn.textContent = "开始下载";
  localBtn.disabled = false;
  localBtn.textContent = "选择文件…";
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
    status.textContent = "正在加载模型...";
  } else if (warmupStatus === "ready") {
    row.classList.add("done");
    spinner.style.display = "none";
    check.style.display = "";
    status.textContent = "模型已加载";
  } else if (warmupStatus === "error") {
    row.classList.add("err");
    spinner.style.display = "none";
    check.style.display = "none";
    status.textContent = "加载失败";
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
    paintModelPanel();
  }
}

async function startModelDownload() {
  const errBox = el("model-error");
  errBox.classList.add("hidden");

  // If a local file was already loaded, the sidecar holds it in memory.
  // Restart it before downloading so the next warmup picks up the fresh
  // weights from disk rather than no-op'ing against the stale model.
  const switching = modelStatus === "ready" && modelSource !== "download";
  if (switching) {
    resetWarmup();
    try { await window.onboarding.restartSidecar(); } catch {}
  }

  modelStatus = "downloading";
  modelSource = "download";
  paintModelPanel();
  setProgress(0, "正在连接 Hugging Face...");

  const unsub = window.onboarding.onProgress((p) => {
    if (p.event === "download" && p.phase === "transfer") {
      const done = p.bytes_done || 0;
      const total = p.bytes_total || 0;
      const pct = total > 0 ? (done / total) * 100 : 0;
      setProgress(pct, `${bytesPretty(done)} / ${bytesPretty(total)}${p.file ? "  ·  " + p.file : ""}`);
    } else if (p.event === "download" && p.phase === "swap") {
      setProgress(98, "正在写入磁盘...");
    } else if (p.event === "download" && p.phase === "complete") {
      setProgress(100, "下载完成");
    } else if (p.event === "download" && p.phase === "reloaded") {
      setProgress(100, "已加载");
    } else if (p.event === "error") {
      errBox.textContent = `下载失败 (${p.phase}): ${p.message || "未知错误"}`;
      errBox.classList.remove("hidden");
    }
  });

  const r = await window.onboarding.startModelDownload();
  if (unsub) unsub();

  if (r && r.ok) {
    // Re-query state so we get the actual on-disk path + size.
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
    paintModelPanel();
    errBox.textContent = (r && r.error) || "下载失败，请检查网络后重试";
    errBox.classList.remove("hidden");
  }
}

async function pickLocalModel() {
  const errBox = el("model-error");
  errBox.classList.add("hidden");

  // Same logic as startModelDownload: restart sidecar before warming up
  // if we're switching away from a previously-loaded model.
  const switching = modelStatus === "ready" && modelSource !== "local";

  const r = await window.onboarding.pickLocalModel();
  if (r && r.ok) {
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
    errBox.textContent = r.error || "选择失败";
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
      // Surface warmup-related errors in the same box so they're visible.
      errBox.textContent = `${p.phase} 失败: ${p.message}`;
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
    errBox.textContent = (r && r.error) || "模型加载失败";
    errBox.classList.remove("hidden");
  }
  paintWarmupRow();
  updateNextBtn();
}

// ── Wire up navigation ────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
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
