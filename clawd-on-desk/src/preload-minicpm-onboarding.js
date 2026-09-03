"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("onboarding", {
  // One-shot reads
  getState: () => ipcRenderer.invoke("onboarding:get-state"),
  listDevices: () => ipcRenderer.invoke("onboarding:list-devices"),
  checkDisk: () => ipcRenderer.invoke("onboarding:check-disk"),
  diskInfo: () => ipcRenderer.invoke("onboarding:disk-info"),
  platformInfo: () => ipcRenderer.invoke("onboarding:platform-info"),

  // User actions
  selectDevice: (device) => ipcRenderer.invoke("onboarding:select-device", { device }),
  pickLocalModel: () => ipcRenderer.invoke("onboarding:pick-local-model"),
  warmup: () => ipcRenderer.invoke("onboarding:warmup"),
  complete: () => ipcRenderer.invoke("onboarding:complete"),
  // Used when the user switches between online download and local file
  // after one source already loaded — restarts the sidecar so warmup
  // picks up the new model file.
  restartSidecar: () => ipcRenderer.invoke("onboarding:restart-sidecar"),

  // Streaming progress (download + warmup)
  onProgress: (cb) => {
    const listener = (_e, p) => { try { cb(p || {}); } catch {} };
    ipcRenderer.on("onboarding:progress", listener);
    // Return an unsubscribe handle for completeness
    return () => ipcRenderer.removeListener("onboarding:progress", listener);
  },

  // i18n: initial fetch + live updates
  getI18n: () => ipcRenderer.invoke("onboarding:get-i18n"),
  onLangChange: (cb) => {
    const listener = (_e, payload) => { try { cb(payload || {}); } catch {} };
    ipcRenderer.on("onboarding:lang-change", listener);
    return () => ipcRenderer.removeListener("onboarding:lang-change", listener);
  },
});
