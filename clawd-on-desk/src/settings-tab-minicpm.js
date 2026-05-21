"use strict";

// ── MiniCPM settings tab (model-focused, compact) ──
//
// Sections (top → bottom):
//   1. 状态     —— 模型版本（带「打开模型目录」图标按钮）+ Sidecar 运行状态
//   2. 行为     —— 桌宠旁白 / 默认思考模式（均真实影响推理路径）
//   3. 快捷操作 —— 检查模型更新 / 选择本地 .gguf / 重启 Sidecar / 打开日志
//
// /api/health is polled at most once a minute (and on focus / manual refresh).
// Resource usage is intentionally hidden — sidecar health is the only signal
// regular users care about.

(function initSettingsTabMinicpm(root) {
  let core = null;
  let helpers = null;

  let healthTimer = null;
  let visibilityHandler = null;
  let mounted = false;

  // Health polling cadence. Cheap (single HTTP GET on localhost), but the
  // user explicitly asked for "about once a minute" instead of the previous
  // 4-second resource ticker.
  const HEALTH_INTERVAL_MS = 60_000;

  // ── Inline SVGs used by the action cards and the folder button ─────────
  // Same 24x24 / stroke=1.6 visual language as the sidebar icons so they
  // sit consistently in the panel.
  const SVG_FOLDER =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%">' +
    '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>' +
    '</svg>';
  const SVG_UPDATE =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%">' +
    '<path d="M21 12a9 9 0 1 1-3-6.7"/>' +
    '<path d="M21 4v5h-5"/>' +
    '</svg>';
  const SVG_FILE =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%">' +
    '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/>' +
    '<path d="M14 3v5h5"/>' +
    '</svg>';
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

  function cleanupTimers() {
    if (healthTimer) {
      clearInterval(healthTimer);
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

  function iconBtn(svgString, onClick, opts = {}) {
    const b = el("button", {
      type: "button",
      className: "soft-btn minicpm-icon-btn",
      onClick,
      title: opts.title || "",
      "aria-label": opts.ariaLabel || opts.title || "",
    });
    b.innerHTML = svgString;
    if (opts.disabled) b.disabled = true;
    return b;
  }

  function statusBadge(text, tone) {
    const cls = tone === "ready"
      ? "remote-ssh-status-connected"
      : tone === "starting"
        ? "remote-ssh-status-connecting"
        : tone === "offline"
          ? "remote-ssh-status-failed"
          : "remote-ssh-status-idle";
    return el("span", { className: `remote-ssh-status-badge ${cls}` }, text);
  }

  function statusRow(label, primary, secondary, extras) {
    const row = el("div", { className: "row minicpm-status-row" });
    const text = el("div", { className: "row-text" });
    text.appendChild(el("span", { className: "row-label" }, label));
    if (secondary) text.appendChild(el("span", { className: "row-desc" }, secondary));
    row.appendChild(text);
    const ctl = el("div", { className: "row-control minicpm-status-control" });
    if (primary) ctl.appendChild(primary);
    if (Array.isArray(extras)) {
      for (const node of extras) if (node) ctl.appendChild(node);
    }
    row.appendChild(ctl);
    return row;
  }

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
    const toggle = () => {
      const next = !sw.classList.contains("on");
      sw.classList.toggle("on", next);
      sw.setAttribute("aria-checked", next ? "true" : "false");
      onChange(next);
    };
    sw.addEventListener("click", toggle);
    sw.addEventListener("keydown", (ev) => {
      if (ev.key === " " || ev.key === "Enter") {
        ev.preventDefault();
        toggle();
      }
    });
    const ctl = el("div", { className: "row-control" });
    ctl.appendChild(sw);
    row.appendChild(ctl);
    return row;
  }

  function buildSectionHeader(title, rightChild) {
    const header = el("h2", { className: "section-title minicpm-section-header" });
    header.appendChild(el("span", {}, title));
    if (rightChild) header.appendChild(rightChild);
    return header;
  }

  // ── Sections ──────────────────────────────────────────────────────────

  async function renderStatusSection(box, ctx) {
    box.innerHTML = "";
    const refreshBtn = softBtn("立即刷新", () => { void ctx.refreshAll(); });
    const section = helpers.buildSection("", []);
    const rows = section.querySelector(".section-rows");
    section.insertBefore(buildSectionHeader("状态", refreshBtn), rows);

    let st = null;
    try { st = await window.minicpmSettings.getStatus(); } catch {}

    const h = (st && st.health) || {};
    const sidecarReady = !!(st && st.healthy);
    // Llama subprocess can still be warming up after the FastAPI side comes
    // online. Use it to choose between "运行中" and "启动中" for the badge.
    const llamaReady = sidecarReady
      && (h.alive === true || !!(h.llama_server && h.llama_server.status === "ok"));

    // ── 模型 row ────────────────────────────────────────────────────────
    // model_name is just the .gguf filename (e.g. MiniCPM5-0.9B-Q4_K_M.gguf)
    // — surface it as the "model version" because that's what users actually
    // identify the model by. We fall back to the basename of model_dir for
    // the rare case where health came back without model_name.
    const modelName = h.model_name
      || (h.model_dir ? h.model_dir.split(/[/\\]/).pop() : null);
    const modelChip = el(
      "span",
      { className: "collapsible-summary-chip" + (modelName ? " accent" : "") },
      modelName || "未加载模型",
    );
    const folderBtn = iconBtn(SVG_FOLDER, async () => {
      const ret = await window.minicpmSettings.openModelDir();
      if (ret && !ret.ok) alert(ret.error || "无法打开模型目录");
    }, { title: "打开模型目录", ariaLabel: "打开模型目录" });

    rows.appendChild(statusRow(
      "模型",
      modelChip,
      h.model_dir || "尚未配置模型，使用下方「选择本地 .gguf」",
      [folderBtn],
    ));

    // ── Sidecar row ────────────────────────────────────────────────────
    let sidecarLabel;
    let sidecarTone;
    if (!sidecarReady) {
      sidecarTone = "offline";
      sidecarLabel = "未连接";
    } else if (!llamaReady) {
      sidecarTone = "starting";
      sidecarLabel = "启动中";
    } else {
      sidecarTone = "ready";
      sidecarLabel = "运行中";
    }
    const sidecarHint = sidecarReady
      ? `${(st && st.sidecarUrl) || ""}  ·  ${h.accel || h.device || "auto"}`
      : "Sidecar 未运行 — 启动桌宠后会自动连接，或点「立即刷新」";

    rows.appendChild(statusRow(
      "Sidecar",
      statusBadge(sidecarLabel, sidecarTone),
      sidecarHint,
    ));

    box.appendChild(section);
  }

  async function renderBehaviorSection(box) {
    box.innerHTML = "";
    const section = helpers.buildSection("", []);
    const rows = section.querySelector(".section-rows");
    section.insertBefore(buildSectionHeader("行为"), rows);

    let st = null;
    try { st = await window.minicpmSettings.getStatus(); } catch {}
    let paramsPayload = null;
    try { paramsPayload = await window.minicpmSettings.getChatParams(); } catch {}
    const thinking = !!(paramsPayload && paramsPayload.params && paramsPayload.params.thinking);

    // narrationEnabled gates the narration codepath in minicpm-chat.js
    // (see `if (!narrationEnabled) return;` in narrateState). Toggling it
    // through this row is the same source of truth used by the tray menu.
    rows.appendChild(switchRow(
      "桌宠旁白",
      "Cursor / Claude / Codex 事件触发时，桌宠主动用本地模型说话",
      !!(st && st.narration),
      async (on) => { await window.minicpmSettings.setNarration(on); },
    ));

    // chatParams.thinking is read by the chat bubble on each /api/chat
    // submit and forwarded to the sidecar (server.py honours it via the
    // thinking flag → llama-cpp prompt template).
    rows.appendChild(switchRow(
      "默认思考模式",
      "新对话默认请求 thinking=true，模型会先输出 <think>…</think> 推理过程",
      thinking,
      async (on) => {
        const cur = (paramsPayload && paramsPayload.params) || {};
        await window.minicpmSettings.setChatParams({ ...cur, thinking: on });
      },
    ));

    box.appendChild(section);
  }

  function actionCard({ icon, title, desc, onClick, primary = false }) {
    const card = el("button", {
      type: "button",
      className: "minicpm-action-card" + (primary ? " primary" : ""),
    });
    const iconBox = el("span", { className: "minicpm-action-icon" });
    iconBox.innerHTML = icon;
    const text = el("span", { className: "minicpm-action-text" });
    text.appendChild(el("span", { className: "minicpm-action-title" }, title));
    if (desc) text.appendChild(el("span", { className: "minicpm-action-desc" }, desc));
    card.appendChild(iconBox);
    card.appendChild(text);
    // Wrap the click handler so each action can ask the card to swap its
    // descriptive text and disabled state without juggling DOM lookups
    // everywhere.
    const helpers2 = {
      setBusy(busyDesc) {
        card.disabled = true;
        card.classList.add("is-busy");
        if (busyDesc != null) {
          const d = card.querySelector(".minicpm-action-desc");
          if (d) d.textContent = busyDesc;
        }
      },
      setDesc(text2) {
        const d = card.querySelector(".minicpm-action-desc");
        if (d) d.textContent = text2;
      },
      reset(originalDesc) {
        card.disabled = false;
        card.classList.remove("is-busy");
        const d = card.querySelector(".minicpm-action-desc");
        if (d && originalDesc != null) d.textContent = originalDesc;
      },
    };
    card.addEventListener("click", () => {
      if (card.disabled) return;
      try { void onClick(helpers2, card); } catch (err) {
        console.warn("minicpm action failed:", err);
      }
    });
    return card;
  }

  function renderActionsSection(box, ctx) {
    box.innerHTML = "";
    const section = helpers.buildSection("", []);
    const rows = section.querySelector(".section-rows");
    section.insertBefore(buildSectionHeader("快捷操作"), rows);

    const updateDesc = "对比远端最新 .gguf 修订";
    const restartDesc = "应用模型 / 加速器变更";

    const grid = el("div", { className: "minicpm-quick-actions" });

    grid.appendChild(actionCard({
      icon: SVG_UPDATE,
      title: "检查模型更新",
      desc: updateDesc,
      primary: true,
      onClick: async (api) => {
        api.setBusy("检查中…");
        let upd = null;
        try { upd = await window.minicpmSettings.checkUpdate(); } catch {}
        if (upd && upd.available) {
          api.setDesc("发现新版");
          const ok = confirm(`发现新版：${upd.remote_revision || "?"}\n是否立即下载？`);
          if (ok) {
            api.setBusy("下载中…");
            await window.minicpmSettings.applyUpdate();
            api.reset(updateDesc);
            void ctx.refreshAll();
            return;
          }
        } else if (upd) {
          api.setDesc("已是最新版本");
        } else {
          api.setDesc("无法获取版本（sidecar 未就绪？）");
        }
        setTimeout(() => api.reset(updateDesc), 4000);
      },
    }));

    grid.appendChild(actionCard({
      icon: SVG_FILE,
      title: "选择本地 .gguf",
      desc: "使用你已下载好的模型文件",
      onClick: async (api) => {
        const ret = await window.minicpmSettings.pickModelDir();
        if (ret && ret.ok) {
          void ctx.refreshAll();
        } else if (ret && !ret.canceled && ret.error) {
          alert(ret.error);
        }
        api.reset("使用你已下载好的模型文件");
      },
    }));

    grid.appendChild(actionCard({
      icon: SVG_RESTART,
      title: "重启 Sidecar",
      desc: restartDesc,
      onClick: async (api) => {
        api.setBusy("重启中…");
        try { await window.minicpmSettings.restartSidecar(); } catch {}
        api.reset(restartDesc);
        void ctx.refreshAll();
      },
    }));

    grid.appendChild(actionCard({
      icon: SVG_LOG,
      title: "打开日志目录",
      desc: "排查 sidecar / llama 启动问题",
      onClick: async (api) => {
        const ret = await window.minicpmSettings.openLogsDir();
        if (ret && !ret.ok) alert(ret.error || "无法打开日志目录");
        api.reset("排查 sidecar / llama 启动问题");
      },
    }));

    rows.appendChild(grid);

    box.appendChild(section);
  }

  // ── Refresh + polling ─────────────────────────────────────────────────

  async function refreshAll(ctx) {
    if (!window.minicpmSettings || !ctx) return;
    await renderStatusSection(ctx.statusBox, ctx);
    await renderBehaviorSection(ctx.behaviorBox);
    renderActionsSection(ctx.actionsBox, ctx);
  }

  function startHealthPolling(ctx) {
    if (healthTimer) clearInterval(healthTimer);
    healthTimer = setInterval(() => {
      if (!mounted || document.hidden || core.state.activeTab !== "minicpm") return;
      // Only the status row depends on /api/health — refreshing it alone
      // keeps the switches and action cards stable across ticks.
      void renderStatusSection(ctx.statusBox, ctx);
    }, HEALTH_INTERVAL_MS);
  }

  async function render(parent) {
    cleanupTimers();
    parent.innerHTML = "";

    parent.appendChild(el("h1", {}, "MiniCPM"));
    parent.appendChild(el(
      "p",
      { className: "subtitle" },
      "配置你的本地 MiniCPM 模型。",
    ));

    if (!window.minicpmSettings) {
      parent.appendChild(el("div", { className: "row-desc" }, "MiniCPM IPC 不可用 (preload 未加载)"));
      return;
    }

    const ctx = {
      statusBox: el("div", {}),
      behaviorBox: el("div", {}),
      actionsBox: el("div", {}),
      refreshAll: null,
    };
    ctx.refreshAll = () => refreshAll(ctx);

    parent.appendChild(ctx.statusBox);
    parent.appendChild(ctx.behaviorBox);
    parent.appendChild(ctx.actionsBox);

    mounted = true;
    visibilityHandler = () => {
      if (document.hidden || core.state.activeTab !== "minicpm") {
        if (healthTimer) {
          clearInterval(healthTimer);
          healthTimer = null;
        }
      } else {
        void refreshAll(ctx);
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
    core.tabs.minicpm = {
      render: (parent) => { void render(parent); },
    };
  }

  root.ClawdSettingsTabMinicpm = { init };
})(typeof globalThis !== "undefined" ? globalThis : window);
