"use strict";

const { BrowserWindow, nativeTheme } = require("electron");
const path = require("path");
const { clampTextScale, scaleWidth, scaleHeight, applyZoomToWindow } = require("./text-scale");

const DEFAULT_WIDTH = 480;
const DEFAULT_HEIGHT = 600;
const MIN_WIDTH = 320;
const MIN_HEIGHT = 400;
const LIGHT_BACKGROUND = "#f5f5f7";
const DARK_BACKGROUND = "#1c1c1f";

function getDashboardBackgroundColor() {
  return nativeTheme.shouldUseDarkColors ? DARK_BACKGROUND : LIGHT_BACKGROUND;
}

function isUsableBounds(bounds) {
  return !!bounds
    && Number.isFinite(bounds.x)
    && Number.isFinite(bounds.y)
    && Number.isFinite(bounds.width)
    && Number.isFinite(bounds.height)
    && bounds.width > 0
    && bounds.height > 0;
}

function clampBoundsToWorkArea(bounds, workArea) {
  const width = Math.min(bounds.width, workArea.width);
  const height = Math.min(bounds.height, workArea.height);
  const minX = workArea.x;
  const minY = workArea.y;
  const maxX = workArea.x + workArea.width - width;
  const maxY = workArea.y + workArea.height - height;
  return {
    x: Math.round(Math.min(Math.max(bounds.x, minX), maxX)),
    y: Math.round(Math.min(Math.max(bounds.y, minY), maxY)),
    width: Math.round(width),
    height: Math.round(height),
  };
}

module.exports = function initDashboard(ctx) {
  let dashboardWindow = null;
  const scheduleLater = typeof ctx.setTimeout === "function" ? ctx.setTimeout : setTimeout;

  function getCurrentSnapshot() {
    return typeof ctx.getSessionSnapshot === "function"
      ? ctx.getSessionSnapshot()
      : { sessions: [], groups: [], orderedIds: [], menuOrderedIds: [] };
  }

  function getTextScale() {
    return clampTextScale(typeof ctx.getTextScale === "function" ? ctx.getTextScale() : 1);
  }

  // DEFAULT_*/MIN_* are CSS px; windows are sized in DIP.
  function getScaledMetrics() {
    const scale = getTextScale();
    return {
      defaultWidth: scaleWidth(DEFAULT_WIDTH, scale),
      defaultHeight: scaleHeight(DEFAULT_HEIGHT, scale),
      minWidth: scaleWidth(MIN_WIDTH, scale),
      minHeight: scaleHeight(MIN_HEIGHT, scale),
    };
  }

  function computeInitialBounds() {
    const petBounds = typeof ctx.getPetWindowBounds === "function"
      ? ctx.getPetWindowBounds()
      : null;
    const cx = petBounds ? petBounds.x + petBounds.width / 2 : 0;
    const cy = petBounds ? petBounds.y + petBounds.height / 2 : 0;
    const workArea = typeof ctx.getNearestWorkArea === "function"
      ? ctx.getNearestWorkArea(cx, cy)
      : { x: 0, y: 0, width: 1280, height: 800 };
    const metrics = getScaledMetrics();
    const width = Math.min(metrics.defaultWidth, Math.max(metrics.minWidth, workArea.width));
    const height = Math.min(metrics.defaultHeight, Math.max(metrics.minHeight, workArea.height));
    return {
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: Math.round(workArea.y + (workArea.height - height) / 2),
      width,
      height,
    };
  }

  function getSettingsWindow() {
    return typeof ctx.getSettingsWindow === "function"
      ? ctx.getSettingsWindow()
      : null;
  }

  function getSettingsBounds(settingsWindow) {
    if (!settingsWindow || typeof settingsWindow.isDestroyed !== "function") return null;
    if (settingsWindow.isDestroyed()) return null;
    if (typeof settingsWindow.isMinimized === "function" && settingsWindow.isMinimized()) return null;
    if (typeof settingsWindow.getBounds !== "function") return null;
    const bounds = settingsWindow.getBounds();
    return isUsableBounds(bounds) ? bounds : null;
  }

  function computeSettingsAnchoredBounds(settingsBounds) {
    const cx = settingsBounds.x + settingsBounds.width / 2;
    const cy = settingsBounds.y + settingsBounds.height / 2;
    const workArea = typeof ctx.getNearestWorkArea === "function"
      ? ctx.getNearestWorkArea(cx, cy)
      : { x: 0, y: 0, width: 1280, height: 800 };
    const metrics = getScaledMetrics();
    const width = Math.max(metrics.minWidth, Math.min(metrics.defaultWidth, settingsBounds.width, workArea.width));
    const height = Math.max(metrics.minHeight, Math.min(settingsBounds.height, workArea.height));
    return clampBoundsToWorkArea({
      x: settingsBounds.x + (settingsBounds.width - width) / 2,
      y: settingsBounds.y,
      width,
      height,
    }, workArea);
  }

  function getDashboardPlacement(options = {}) {
    if (options.source !== "settings") {
      return { bounds: computeInitialBounds() };
    }
    // Keep Settings-opened dashboards visually attached with absolute bounds.
    // Matching native outer frames exactly is brittle on Windows because DWM can
    // add invisible borders and titlebar frame offsets per window.
    const settingsWindow = getSettingsWindow();
    const settingsBounds = getSettingsBounds(settingsWindow);
    if (!settingsBounds) {
      return { bounds: computeInitialBounds() };
    }
    return {
      bounds: computeSettingsAnchoredBounds(settingsBounds),
    };
  }

  function applySettingsPlacement(options = {}) {
    if (options.source !== "settings") return;
    if (!dashboardWindow || dashboardWindow.isDestroyed()) return;
    const placement = getDashboardPlacement(options);
    if (isUsableBounds(placement.bounds) && typeof dashboardWindow.setBounds === "function") {
      dashboardWindow.setBounds(placement.bounds);
      // The anchored placement can land the window on a display with a
      // different textScale; re-zoom right away (memoized — cheap no-op when
      // nothing changed).
      applyTextScaleToWindow();
    }
  }

  function scheduleSettingsPlacementSync(options = {}) {
    if (options.source !== "settings") return;
    for (const delay of [0, 80]) {
      scheduleLater(() => {
        applySettingsPlacement(options);
      }, delay);
    }
  }

  function sendSnapshot(snapshot = getCurrentSnapshot()) {
    if (!dashboardWindow || dashboardWindow.isDestroyed()) return;
    if (!dashboardWindow.webContents || dashboardWindow.webContents.isDestroyed()) return;
    dashboardWindow.webContents.send("dashboard:session-snapshot", snapshot);
  }

  function sendI18n() {
    if (!dashboardWindow || dashboardWindow.isDestroyed()) return;
    if (!dashboardWindow.webContents || dashboardWindow.webContents.isDestroyed()) return;
    if (typeof ctx.getI18n !== "function") return;
    dashboardWindow.webContents.send("dashboard:lang-change", ctx.getI18n());
  }

  function createDashboardWindow(options = {}) {
    const placement = getDashboardPlacement(options);
    const metrics = getScaledMetrics();
    const opts = {
      ...placement.bounds,
      minWidth: metrics.minWidth,
      minHeight: metrics.minHeight,
      show: false,
      frame: true,
      transparent: false,
      resizable: true,
      minimizable: true,
      maximizable: true,
      skipTaskbar: false,
      alwaysOnTop: false,
      title: typeof ctx.t === "function" ? ctx.t("dashboardWindowTitle") : "Sessions",
      backgroundColor: getDashboardBackgroundColor(),
      webPreferences: {
        preload: path.join(__dirname, "preload-dashboard.js"),
        nodeIntegration: false,
        contextIsolation: true,
      },
    };
    if (ctx.iconPath) opts.icon = ctx.iconPath;

    dashboardWindow = new BrowserWindow(opts);
    dashboardWindow.setMenuBarVisibility(false);
    dashboardWindow.loadFile(path.join(__dirname, "dashboard.html"));
    // textScale is per-display: re-resolve after the user drags the window
    // somewhere else (debounced — "move" fires continuously during drags).
    let moveTextScaleTimer = null;
    dashboardWindow.on("move", () => {
      if (moveTextScaleTimer) clearTimeout(moveTextScaleTimer);
      moveTextScaleTimer = scheduleLater(() => {
        moveTextScaleTimer = null;
        applyTextScaleToWindow();
      }, 350);
    });
    dashboardWindow.webContents.once("did-finish-load", () => {
      applyZoomToWindow(dashboardWindow, getTextScale());
      sendI18n();
      sendSnapshot();
    });
    dashboardWindow.once("ready-to-show", () => {
      if (!dashboardWindow || dashboardWindow.isDestroyed()) return;
      applySettingsPlacement(options);
      dashboardWindow.show();
      scheduleSettingsPlacementSync(options);
      dashboardWindow.focus();
    });
    dashboardWindow.on("closed", () => {
      dashboardWindow = null;
    });
    return dashboardWindow;
  }

  function syncThemeBackground() {
    if (!dashboardWindow || dashboardWindow.isDestroyed()) return;
    dashboardWindow.setBackgroundColor(getDashboardBackgroundColor());
  }

  if (nativeTheme && typeof nativeTheme.on === "function") {
    nativeTheme.on("updated", syncThemeBackground);
  }

  function showDashboard(options = {}) {
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      if (dashboardWindow.isMinimized()) dashboardWindow.restore();
      applySettingsPlacement(options);
      dashboardWindow.show();
      scheduleSettingsPlacementSync(options);
      dashboardWindow.focus();
      sendI18n();
      sendSnapshot();
      return dashboardWindow;
    }
    return createDashboardWindow(options);
  }

  function broadcastSessionSnapshot(snapshot) {
    sendSnapshot(snapshot);
  }

  // textScale changed while the dashboard is open: re-zoom, raise the minimum
  // size, and only grow the window if it now sits below that minimum — never
  // touch a user-chosen size otherwise.
  function applyTextScaleToWindow() {
    if (!dashboardWindow || dashboardWindow.isDestroyed()) return;
    const metrics = getScaledMetrics();
    applyZoomToWindow(dashboardWindow, getTextScale());
    if (typeof dashboardWindow.setMinimumSize === "function") {
      dashboardWindow.setMinimumSize(metrics.minWidth, metrics.minHeight);
    }
    if (typeof dashboardWindow.getBounds !== "function") return;
    const bounds = dashboardWindow.getBounds();
    if (bounds.width < metrics.minWidth || bounds.height < metrics.minHeight) {
      dashboardWindow.setBounds({
        ...bounds,
        width: Math.max(bounds.width, metrics.minWidth),
        height: Math.max(bounds.height, metrics.minHeight),
      });
    }
  }

  return {
    showDashboard,
    broadcastSessionSnapshot,
    sendI18n,
    getWindow: () => dashboardWindow,
    applyTextScaleToWindow,
  };
};
