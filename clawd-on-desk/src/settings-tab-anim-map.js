"use strict";

(function initSettingsTabAnimMap(root) {
  // Renderer context (nodeIntegration: false) — read the shared constant
  // from the global exposed by default-theme.js, which is loaded earlier
  // in settings.html. Keep a literal fallback so unit tests that eval
  // this file in isolation still work.
  const { DEFAULT_THEME_ID } = (typeof globalThis !== "undefined" && globalThis.ClawdDefaultTheme)
    || { DEFAULT_THEME_ID: "calico" };
  const ANIM_MAP_ROWS = [
    { stateKey: "error", labelKey: "animMapErrorLabel", descKey: "animMapErrorDesc" },
    { stateKey: "notification", labelKey: "animMapNotificationLabel", descKey: "animMapNotificationDesc" },
    { stateKey: "sweeping", labelKey: "animMapSweepingLabel", descKey: "animMapSweepingDesc" },
    { stateKey: "attention", labelKey: "animMapAttentionLabel", descKey: "animMapAttentionDesc" },
    { stateKey: "carrying", labelKey: "animMapCarryingLabel", descKey: "animMapCarryingDesc" },
  ];

  let state = null;
  let helpers = null;
  let ops = null;
  let readers = null;

  function t(key) {
    return helpers.t(key);
  }

  function isStateDisabled(themeId, stateKey) {
    const map = readers.readThemeOverrideMap(themeId);
    const states = map && map.states;
    const entry = (states && states[stateKey]) || (map && map[stateKey]);
    return !!(entry && entry.disabled === true);
  }

  function animMapSwitchId(themeId, stateKey) {
    return `${themeId}:${stateKey}`;
  }

  function readAnimMapVisualOn(themeId, stateKey) {
    return !isStateDisabled(themeId, stateKey);
  }

  function buildAnimMapRow(spec, themeId) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML =
      `<div class="row-text">` +
        `<span class="row-label"></span>` +
        `<span class="row-desc"></span>` +
      `</div>` +
      `<div class="row-control"><div class="switch" role="switch" tabindex="0"></div></div>`;
    row.querySelector(".row-label").textContent = t(spec.labelKey);
    row.querySelector(".row-desc").textContent = t(spec.descKey);
    const sw = row.querySelector(".switch");

    const switchId = animMapSwitchId(themeId, spec.stateKey);
    const override = state.transientUiState.animMapSwitches.get(switchId);
    const visualOn = override ? override.visualOn : readAnimMapVisualOn(themeId, spec.stateKey);
    helpers.setSwitchVisual(sw, visualOn, { pending: override ? override.pending : false });
    state.mountedControls.animMapSwitches.set(switchId, {
      element: sw,
      themeId,
      stateKey: spec.stateKey,
    });

    helpers.attachAnimatedSwitch(sw, {
      getCommittedVisual: () => readAnimMapVisualOn(themeId, spec.stateKey),
      getTransientState: () => state.transientUiState.animMapSwitches.get(switchId) || null,
      setTransientState: (value) => state.transientUiState.animMapSwitches.set(switchId, value),
      clearTransientState: (seq) => {
        const current = state.transientUiState.animMapSwitches.get(switchId);
        if (!current || (seq !== undefined && current.seq !== seq)) return;
        state.transientUiState.animMapSwitches.delete(switchId);
      },
      invoke: () => window.settingsAPI.command("setThemeOverrideDisabled", {
        themeId,
        stateKey: spec.stateKey,
        disabled: readAnimMapVisualOn(themeId, spec.stateKey),
      }),
    });
    return row;
  }

  function render(parent) {
    const h1 = document.createElement("h1");
    h1.textContent = t("animMapTitle");
    parent.appendChild(h1);

    const subtitle = document.createElement("p");
    subtitle.className = "subtitle";
    subtitle.textContent = t("animMapSubtitle");
    parent.appendChild(subtitle);

    const note = document.createElement("p");
    note.className = "subtitle";
    note.textContent = t("animMapSemanticsNote");
    parent.appendChild(note);

    const themeId = (state.snapshot && state.snapshot.theme) || DEFAULT_THEME_ID;
    const rows = ANIM_MAP_ROWS.map((spec) => buildAnimMapRow(spec, themeId));
    parent.appendChild(helpers.buildSection("", rows));

    const hasAny = readers.readThemeOverrideMap(themeId) !== null;
    const resetWrap = document.createElement("div");
    resetWrap.className = "anim-map-reset";
    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "theme-delete-btn anim-map-reset-btn";
    resetBtn.textContent = t("animMapResetAll");
    if (!hasAny) resetBtn.disabled = true;
    state.mountedControls.animMapReset = {
      element: resetBtn,
      themeId,
      syncFromSnapshot: () => {
        resetBtn.disabled = readers.readThemeOverrideMap(themeId) === null;
      },
    };
    helpers.attachActivation(resetBtn, () =>
      window.settingsAPI.command("resetThemeOverrides", { themeId })
        .then((result) => {
          if (result && result.status === "ok" && !result.noop) {
            ops.showToast(t("toastAnimMapResetOk"));
          }
          return result;
        })
    );
    resetWrap.appendChild(resetBtn);
    parent.appendChild(resetWrap);
  }

  function patchInPlace(changes) {
    if (!changes || !Object.prototype.hasOwnProperty.call(changes, "themeOverrides")) return false;
    if (Object.prototype.hasOwnProperty.call(changes, "theme")) return false;
    if (state.mountedControls.animMapSwitches.size === 0) return false;
    for (const [, meta] of state.mountedControls.animMapSwitches) {
      if (!meta || !document.body.contains(meta.element)) return false;
    }
    for (const [id, meta] of state.mountedControls.animMapSwitches) {
      state.transientUiState.animMapSwitches.delete(id);
      helpers.setSwitchVisual(meta.element, readAnimMapVisualOn(meta.themeId, meta.stateKey), { pending: false });
    }
    const reset = state.mountedControls.animMapReset;
    if (reset && document.body.contains(reset.element)) {
      reset.syncFromSnapshot();
    }
    return true;
  }

  function init(core) {
    state = core.state;
    helpers = core.helpers;
    ops = core.ops;
    readers = core.readers;
    core.tabs.animMap = {
      render,
      patchInPlace,
    };
  }

  root.ClawdSettingsTabAnimMap = { init };
})(globalThis);
