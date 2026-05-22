"use strict";

// ── MiniCPM settings tab ──
//
// Page layout (top → bottom):
//   • Page header: title + subtitle on the left, sidecar status pill on the right
//   • 行为 / Behavior              — narration + default thinking switches
//   • 模型 / Model                  — fixed model label + truncated path + buttons
//   • 高级设置 / Advanced (collapsed by default) — restart Sidecar, open logs
//
// Sidecar health is polled at most once a minute (5s during cold-start
// grace), and now only re-renders the header pill. The rest of the page
// stays stable across ticks so the user can interact with switches and
// buttons without re-mount flicker.

(function initSettingsTabMinicpm(root) {
  let core = null;
  let helpers = null;
  let ops = null;

  let healthTimer = null;
  let visibilityHandler = null;
  let mounted = false;
  // Survives re-renders within the same Settings session so the user
  // doesn't have to re-expand Advanced every time they revisit the tab.
  let advancedExpanded = false;

  // The product surface treats MiniCPM5 0.9B as the canonical bundled
  // model. Showing the actual gguf filename here would create noise once
  // users sideload variants — we still expose that in the path row.
  const MODEL_INFO_LABEL = "MiniCPM5 0.9B";
  const PATH_TRUNCATE_MAX = 56;

  const HEALTH_INTERVAL_MS_SLOW = 60_000;
  const HEALTH_INTERVAL_MS_FAST = 5_000;
  const HEALTH_FAST_ATTEMPTS = 6;

  function t(key) {
    return helpers.t(key);
  }

  // ── Inline SVGs ────────────────────────────────────────────────────────
  const SVG_RESTART =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%">' +
    '<path d="M12 4v8"/>' +
    '<path d="M16.24 7.76a6 6 0 1 1-8.49 0"/>' +
    '</svg>';
  const SVG_LOG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%">' +
    '<rect x="3" y="4" width="18" height="16" rx="2"/>' +
    '<path d="M7 9l3 3-3 3"/>' +
    '<path d="M13 15h5"/>' +
    '</svg>';
  const SVG_CHEVRON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%">' +
    '<path d="M9 6l6 6-6 6"/>' +
    '</svg>';

  function cleanupTimers() {
    if (healthTimer) {
      clearTimeout(healthTimer);
      healthTimer = null;
    }
    if (visibilityHandler) {
      document.removeEventListener("visibilitychange", visibilityHandler);
      visibilityHandler = null;
    }
    mounted = false;
  }

  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    for (const k of Object.keys(attrs || {})) {
      if (k === "style") Object.assign(e.style, attrs[k]);
      else if (k === "className") e.className = attrs[k];
      else if (k.startsWith("on") && typeof attrs[k] === "function") {
        e.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
      } else e.setAttribute(k, attrs[k]);
    }
    for (const child of children) {
      if (child == null) continue;
      e.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return e;
  }

  function softBtn(label, onClick, opts = {}) {
    const b = el("button", {
      type: "button",
      className: "soft-btn" + (opts.accent ? " accent" : ""),
      onClick,
    });
    b.textContent = label;
    if (opts.disabled) b.disabled = true;
    return b;
  }

  // ── Status pill (top-right of page header) ────────────────────────────
  //
  // Three states. We deliberately collapse the original "probing" and
  // "starting" labels into a single yellow "starting" pill: at the page
  // level the user only cares whether things are healthy, warming up, or
  // broken. The full debug breakdown lives in the logs.
  function deriveStatus(sidecarReady, llamaReady, probing) {
    if (sidecarReady && llamaReady) return { tone: "ready", label: t("minicpmStatusRunning") };
    if (sidecarReady || probing) return { tone: "starting", label: t("minicpmStatusStarting") };
    return { tone: "offline", label: t("minicpmStatusError") };
  }

  function statusPill(tone, label) {
    const cls = tone === "ready"
      ? "remote-ssh-status-connected"
      : tone === "starting"
        ? "remote-ssh-status-connecting"
        : tone === "offline"
          ? "remote-ssh-status-failed"
          : "remote-ssh-status-idle";
    return el("span", { className: `remote-ssh-status-badge ${cls}` }, label);
  }

  // ── Switch row (committed-vs-pending; rolls back on IPC failure) ──────
  function switchRow(label, hint, checked, onChange) {
    const row = el("div", { className: "row" });
    const text = el("div", { className: "row-text" });
    text.appendChild(el("span", { className: "row-label" }, label));
    if (hint) text.appendChild(el("span", { className: "row-desc" }, hint));
    row.appendChild(text);
    const sw = el("div", {
      className: "switch" + (checked ? " on" : ""),
      role: "switch",
      tabindex: "0",
      "aria-checked": checked ? "true" : "false",
    });

    let committedOn = !!checked;
    let pending = false;

    function applyVisual(on, isPending) {
      sw.classList.toggle("on", !!on);
      sw.classList.toggle("pending", !!isPending);
      sw.setAttribute("aria-checked", on ? "true" : "false");
    }

    function isOk(result) {
      if (!result) return false;
      if (result.ok === true) return true;
      if (result.status === "ok") return true;
      return false;
    }

    function notifyFailure(message) {
      if (ops && typeof ops.showToast === "function") {
        ops.showToast(t("toastSaveFailed") + (message || "unknown error"), { error: true });
      }
    }

    async function runToggle() {
      if (pending) return;
      const next = !committedOn;
      pending = true;
      applyVisual(next, true);
      let ok = false;
      let message = "";
      try {
        const result = await onChange(next);
        ok = isOk(result);
        if (!ok) message = (result && (result.error || result.message)) || "";
      } catch (err) {
        ok = false;
        message = (err && err.message) || "";
      } finally {
        pending = false;
      }
      if (ok) {
        committedOn = next;
        applyVisual(next, false);
      } else {
        applyVisual(committedOn, false);
        notifyFailure(message);
      }
    }

    sw.addEventListener("click", () => { void runToggle(); });
    sw.addEventListener("keydown", (ev) => {
      if (ev.key === " " || ev.key === "Enter") {
        ev.preventDefault();
        void runToggle();
      }
    });
    const ctl = el("div", { className: "row-control" });
    ctl.appendChild(sw);
    row.appendChild(ctl);
    return row;
  }

  // ── Path helpers ───────────────────────────────────────────────────────
  //
  // Path-aware middle truncation: always keeps the filename + its parent
  // directory, then greedily extends the tail and starts the head with the
  // leading components until we run out of room. Character-level fallback
  // for inputs that don't look like a path. Tooltip restores the full
  // string so we never hide information, only collapse it.
  function truncatePath(p, maxLen = PATH_TRUNCATE_MAX) {
    if (!p) return "";
    if (p.length <= maxLen) return p;
    const usesBackslash = p.includes("\\") && !p.includes("/");
    const sep = usesBackslash ? "\\" : "/";
    const parts = p.split(sep);
    if (parts.length < 3) {
      const headLen = Math.ceil((maxLen - 1) / 2);
      const tailLen = Math.floor((maxLen - 1) / 2);
      return p.slice(0, headLen) + "…" + p.slice(-tailLen);
    }
    const fileName = parts[parts.length - 1];
    const tailPieces = [fileName];
    let tailLen = fileName.length;
    let i = parts.length - 2;
    while (i >= 0 && tailLen + parts[i].length + 1 < maxLen - 6) {
      tailPieces.unshift(parts[i]);
      tailLen += parts[i].length + 1;
      i--;
    }
    const headPieces = [];
    let headLen = 0;
    for (let j = 0; j <= i; j++) {
      const piece = parts[j];
      const pieceTotal = piece.length + (j === 0 ? 0 : 1);
      if (headLen + pieceTotal + tailLen + 3 > maxLen) break;
      headPieces.push(piece);
      headLen += pieceTotal;
    }
    if (headPieces.length === 0) headPieces.push(parts[0] || "");
    return headPieces.join(sep) + sep + "…" + sep + tailPieces.join(sep);
  }

  // ── Section header (matches the small-caps title used elsewhere) ──────
  function sectionTitle(text) {
    return el("h2", { className: "section-title minicpm-section-title" }, text);
  }

  // ── Header (title + subtitle on left, status pill on right) ───────────
  function renderHeader(ctx) {
    ctx.headerBox.innerHTML = "";
    const wrap = el("div", { className: "minicpm-page-header" });
    const textCol = el("div", { className: "minicpm-page-header-text" });
    textCol.appendChild(el("h1", {}, t("minicpmTitle")));
    textCol.appendChild(el("p", { className: "subtitle" }, t("minicpmSubtitle")));
    wrap.appendChild(textCol);
    ctx.statusPillSlot = el("div", { className: "minicpm-page-header-status" });
    wrap.appendChild(ctx.statusPillSlot);
    ctx.headerBox.appendChild(wrap);
    syncStatusPill(ctx);
  }

  function syncStatusPill(ctx) {
    if (!ctx.statusPillSlot) return;
    const { sidecarReady, llamaReady, probing } = ctx.healthSnapshot;
    const { tone, label } = deriveStatus(sidecarReady, llamaReady, probing);
    ctx.statusPillSlot.innerHTML = "";
    ctx.statusPillSlot.appendChild(statusPill(tone, label));
  }

  // ── Health probe → updates ctx.healthSnapshot ─────────────────────────
  async function probeHealth(ctx) {
    let st = null;
    try { st = await window.minicpmSettings.getStatus(); } catch {}
    const h = (st && st.health) || {};
    const sidecarReady = !!(st && st.healthy);
    const llamaReady = sidecarReady
      && (h.alive === true || !!(h.llama_server && h.llama_server.status === "ok"));
    if (sidecarReady) ctx.everHealthy = true;
    const probing = !sidecarReady && !ctx.everHealthy && ctx.fastAttemptsLeft > 0;

    const modelNameNow = h.model_name
      || (h.model_dir ? h.model_dir.split(/[/\\]/).pop() : null);
    if (modelNameNow) {
      ctx.lastModelName = modelNameNow;
      ctx.lastModelDir = h.model_dir || ctx.lastModelDir;
    }

    ctx.healthSnapshot = {
      st, h, sidecarReady, llamaReady, probing,
      modelName: modelNameNow
        || ((probing || sidecarReady) ? ctx.lastModelName : null),
      modelDir: h.model_dir || ctx.lastModelDir,
    };
    return ctx.healthSnapshot;
  }

  // ── Sections ──────────────────────────────────────────────────────────

  async function renderBehaviorSection(box, ctx) {
    box.innerHTML = "";
    const st = ctx.healthSnapshot && ctx.healthSnapshot.st;
    let paramsPayload = null;
    try { paramsPayload = await window.minicpmSettings.getChatParams(); } catch {}
    const thinking = !!(paramsPayload && paramsPayload.params && paramsPayload.params.thinking);

    box.appendChild(sectionTitle(t("minicpmSectionBehavior")));
    const section = helpers.buildSection("", []);
    const rows = section.querySelector(".section-rows");

    // narrationEnabled gates the narration codepath in minicpm-chat.js
    // (`if (!narrationEnabled) return;` in narrateState). Same source of
    // truth as the tray menu — they read/write the same prefs file.
    rows.appendChild(switchRow(
      t("minicpmRowNarration"),
      t("minicpmRowNarrationDesc"),
      !!(st && st.narration),
      (on) => window.minicpmSettings.setNarration(on),
    ));

    // chatParams.thinking is persisted to minicpm-prefs.json and read by
    // the chat bubble on each submit (unless ⌘⇧T overrides for the session).
    rows.appendChild(switchRow(
      t("minicpmRowDefaultThinking"),
      t("minicpmRowDefaultThinkingDesc"),
      thinking,
      (on) => {
        const cur = (paramsPayload && paramsPayload.params) || {};
        return window.minicpmSettings.setChatParams({ ...cur, thinking: on });
      },
    ));
    box.appendChild(section);
  }

  function renderModelSection(box, ctx) {
    box.innerHTML = "";
    const snap = ctx.healthSnapshot || {};
    const modelDir = snap.modelDir || "";
    const hasPath = !!modelDir;
    const truncated = hasPath ? truncatePath(modelDir, PATH_TRUNCATE_MAX) : t("minicpmModelPathUnset");

    box.appendChild(sectionTitle(t("minicpmSectionModel")));
    const section = helpers.buildSection("", []);
    const rows = section.querySelector(".section-rows");

    // ── Model info row (hardcoded product name) ───────────────────────
    const infoRow = el("div", { className: "row minicpm-info-row" });
    const infoText = el("div", { className: "row-text" });
    infoText.appendChild(el("span", { className: "row-label" }, t("minicpmRowModelInfo")));
    infoRow.appendChild(infoText);
    const infoVal = el("div", { className: "row-control minicpm-info-value" }, MODEL_INFO_LABEL);
    infoRow.appendChild(infoVal);
    rows.appendChild(infoRow);

    // ── Model path row (truncated + tooltip + two buttons) ────────────
    const pathRow = el("div", { className: "row minicpm-path-row" });
    const pathText = el("div", { className: "row-text" });
    pathText.appendChild(el("span", { className: "row-label" }, t("minicpmRowModelPath")));
    const pathDesc = el("span", {
      className: "row-desc minicpm-path-value" + (hasPath ? "" : " is-unset"),
    }, truncated);
    if (hasPath) pathDesc.setAttribute("title", modelDir);
    pathText.appendChild(pathDesc);
    pathRow.appendChild(pathText);

    const ctl = el("div", { className: "row-control minicpm-path-actions" });
    const showBtn = softBtn(t("minicpmOpenModelPath"), async () => {
      const ret = await window.minicpmSettings.openModelDir();
      if (ret && !ret.ok) alert(ret.error || t("minicpmOpenModelDirFailed"));
    });
    if (!hasPath) showBtn.disabled = true;
    const changeLabel = t("minicpmChangeModel");
    // The IPC handler also kicks off /api/load-model after persisting, so
    // resolution may take 5–30s depending on model size. Show a busy state
    // on both buttons so the user gets immediate feedback rather than
    // staring at a frozen dialog while llama-server re-spawns.
    const changeBtn = softBtn(changeLabel, async () => {
      if (changeBtn.disabled) return;
      showBtn.disabled = true;
      changeBtn.disabled = true;
      changeBtn.classList.add("is-busy");
      changeBtn.textContent = t("minicpmChangeModelBusy");
      let ret = null;
      try {
        ret = await window.minicpmSettings.pickModelDir();
      } catch (err) {
        alert(t("minicpmReloadError") + (err && err.message || err));
      }
      // refreshAll() rebuilds the model section from scratch (replacing
      // these buttons), so restoring the busy state explicitly is only
      // necessary on the canceled / error paths.
      if (ret && ret.ok) {
        if (ret.reloadError) alert(t("minicpmReloadError") + ret.reloadError);
        void ctx.refreshAll();
        return;
      }
      if (ret && !ret.canceled && ret.error) alert(ret.error);
      changeBtn.classList.remove("is-busy");
      changeBtn.textContent = changeLabel;
      changeBtn.disabled = false;
      showBtn.disabled = !hasPath;
    }, { accent: true });
    ctl.appendChild(showBtn);
    ctl.appendChild(changeBtn);
    pathRow.appendChild(ctl);
    rows.appendChild(pathRow);

    box.appendChild(section);
  }

  // ── Advanced (collapsible) — restart Sidecar + open logs ──────────────
  //
  // Hand-rolled instead of using helpers.buildCollapsibleGroup so the
  // disclosure trigger can sit in the small-caps section-title style. The
  // body is just a standard section-rows block of two rows; we toggle its
  // visibility with display:none rather than a height animation because
  // the row count is tiny (2) and reflow is instant.
  function renderAdvancedSection(box, ctx) {
    box.innerHTML = "";
    const wrap = el("section", { className: "section minicpm-advanced-section" });

    const trigger = el("button", {
      type: "button",
      className: "minicpm-advanced-trigger" + (advancedExpanded ? " open" : ""),
      "aria-expanded": advancedExpanded ? "true" : "false",
    });
    const chev = el("span", { className: "minicpm-advanced-chevron", "aria-hidden": "true" });
    chev.innerHTML = SVG_CHEVRON;
    trigger.appendChild(chev);
    trigger.appendChild(el("span", { className: "section-title minicpm-advanced-title" }, t("minicpmSectionAdvanced")));
    wrap.appendChild(trigger);

    const section = helpers.buildSection("", []);
    section.classList.add("minicpm-advanced-body");
    const rows = section.querySelector(".section-rows");

    rows.appendChild(buildAdvancedRow({
      icon: SVG_RESTART,
      title: t("minicpmActionRestartSidecar"),
      desc: t("minicpmActionRestartSidecarDesc"),
      busyLabel: t("minicpmActionRestartSidecarBusy"),
      onClick: async () => {
        try { await window.minicpmSettings.restartSidecar(); } catch {}
        void ctx.refreshAll();
      },
    }));
    rows.appendChild(buildAdvancedRow({
      icon: SVG_LOG,
      title: t("minicpmActionOpenLogs"),
      desc: t("minicpmActionOpenLogsDesc"),
      onClick: async () => {
        const ret = await window.minicpmSettings.openLogsDir();
        if (ret && !ret.ok) alert(ret.error || t("minicpmActionOpenLogsFailed"));
      },
    }));

    wrap.appendChild(section);
    box.appendChild(wrap);

    function applyExpanded() {
      trigger.classList.toggle("open", advancedExpanded);
      trigger.setAttribute("aria-expanded", advancedExpanded ? "true" : "false");
      section.style.display = advancedExpanded ? "" : "none";
    }
    applyExpanded();
    trigger.addEventListener("click", () => {
      advancedExpanded = !advancedExpanded;
      applyExpanded();
    });
  }

  function buildAdvancedRow({ icon, title, desc, busyLabel, onClick }) {
    const row = el("div", { className: "row minicpm-advanced-row" });
    const iconBox = el("span", { className: "minicpm-advanced-row-icon", "aria-hidden": "true" });
    iconBox.innerHTML = icon;
    row.appendChild(iconBox);
    const text = el("div", { className: "row-text" });
    text.appendChild(el("span", { className: "row-label" }, title));
    if (desc) text.appendChild(el("span", { className: "row-desc" }, desc));
    row.appendChild(text);
    const ctl = el("div", { className: "row-control" });
    // The trigger button blends visually with the row; we keep the entire
    // row clickable so the touch target matches the visual surface.
    row.classList.add("clickable");
    row.setAttribute("role", "button");
    row.setAttribute("tabindex", "0");
    let pending = false;
    async function run() {
      if (pending) return;
      pending = true;
      row.classList.add("is-busy");
      if (busyLabel) text.querySelector(".row-label").textContent = busyLabel;
      try { await onClick(); } catch {}
      pending = false;
      row.classList.remove("is-busy");
      if (busyLabel) text.querySelector(".row-label").textContent = title;
    }
    row.addEventListener("click", () => { void run(); });
    row.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); void run(); }
    });
    row.appendChild(ctl);
    return row;
  }

  // ── Refresh + polling ─────────────────────────────────────────────────

  async function refreshAll(ctx) {
    if (!window.minicpmSettings || !ctx) return;
    await probeHealth(ctx);
    syncStatusPill(ctx);
    await renderBehaviorSection(ctx.behaviorBox, ctx);
    renderModelSection(ctx.modelBox, ctx);
    renderAdvancedSection(ctx.advancedBox, ctx);
  }

  function nextHealthDelay(ctx) {
    if (!ctx.everHealthy && ctx.fastAttemptsLeft > 0) return HEALTH_INTERVAL_MS_FAST;
    return HEALTH_INTERVAL_MS_SLOW;
  }

  // The polling loop refreshes only the status pill + model path (cheap)
  // so switches and the advanced collapsible state stay put across ticks.
  function startHealthPolling(ctx) {
    if (healthTimer) {
      clearTimeout(healthTimer);
      healthTimer = null;
    }
    const tick = async () => {
      healthTimer = null;
      if (!mounted || document.hidden || core.state.activeTab !== "minicpm") return;
      const wasHealthy = ctx.everHealthy;
      await probeHealth(ctx);
      syncStatusPill(ctx);
      // Path may have switched after a load-model — keep the model card
      // honest, but never re-render Behavior/Advanced (would lose focus).
      renderModelSection(ctx.modelBox, ctx);
      if (!ctx.everHealthy && ctx.fastAttemptsLeft > 0) ctx.fastAttemptsLeft -= 1;
      if (!wasHealthy && ctx.everHealthy) ctx.fastAttemptsLeft = 0;
      healthTimer = setTimeout(tick, nextHealthDelay(ctx));
    };
    healthTimer = setTimeout(tick, nextHealthDelay(ctx));
  }

  function armFastProbes(ctx) {
    ctx.fastAttemptsLeft = HEALTH_FAST_ATTEMPTS;
  }

  async function render(parent) {
    cleanupTimers();
    parent.innerHTML = "";

    const ctx = {
      headerBox: el("div", {}),
      behaviorBox: el("div", { className: "minicpm-section-box" }),
      modelBox: el("div", { className: "minicpm-section-box" }),
      advancedBox: el("div", { className: "minicpm-section-box" }),
      statusPillSlot: null,
      everHealthy: false,
      fastAttemptsLeft: HEALTH_FAST_ATTEMPTS,
      lastModelName: null,
      lastModelDir: null,
      healthSnapshot: {
        st: null, h: {}, sidecarReady: false, llamaReady: false, probing: true,
        modelName: null, modelDir: null,
      },
      refreshAll: null,
    };
    ctx.refreshAll = () => {
      armFastProbes(ctx);
      const p = refreshAll(ctx);
      startHealthPolling(ctx);
      return p;
    };

    // Build the header eagerly so the page never flashes empty before
    // /api/health resolves — the pill starts in the "starting" yellow
    // state via the initial probing=true snapshot.
    renderHeader(ctx);

    if (!window.minicpmSettings) {
      parent.appendChild(ctx.headerBox);
      parent.appendChild(el("div", { className: "row-desc" }, t("minicpmIpcUnavailable")));
      return;
    }

    parent.appendChild(ctx.headerBox);
    parent.appendChild(ctx.behaviorBox);
    parent.appendChild(ctx.modelBox);
    parent.appendChild(ctx.advancedBox);

    mounted = true;
    visibilityHandler = () => {
      if (document.hidden || core.state.activeTab !== "minicpm") {
        if (healthTimer) {
          clearTimeout(healthTimer);
          healthTimer = null;
        }
      } else {
        armFastProbes(ctx);
        void (async () => {
          await probeHealth(ctx);
          syncStatusPill(ctx);
          renderModelSection(ctx.modelBox, ctx);
        })();
        startHealthPolling(ctx);
      }
    };
    document.addEventListener("visibilitychange", visibilityHandler);

    await refreshAll(ctx);
    startHealthPolling(ctx);
  }

  function init(coreArg) {
    core = coreArg;
    helpers = core.helpers;
    ops = core.ops;
    core.tabs.minicpm = {
      render: (parent) => { void render(parent); },
    };
  }

  root.ClawdSettingsTabMinicpm = { init };
})(typeof globalThis !== "undefined" ? globalThis : window);
