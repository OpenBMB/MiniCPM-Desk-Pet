"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("minicpm", {
  // Sidecar lifecycle
  start: (opts) => ipcRenderer.invoke("minicpm:start", opts),
  status: () => ipcRenderer.invoke("minicpm:status"),

  // Bubble window controls
  resize: (width, height) => ipcRenderer.invoke("minicpm:resize", { width, height }),
  setChatAnchor: (bottomY) => ipcRenderer.invoke("minicpm:set-chat-anchor", { bottomY }),
  hideWindow: () => ipcRenderer.invoke("minicpm:hide-window"),
  showWindow: () => ipcRenderer.invoke("minicpm:show-window"),
  focusWindow: () => ipcRenderer.invoke("minicpm:focus-window"),
  openContextMenu: () => ipcRenderer.send("minicpm:open-context-menu"),

  // Updater
  updateStatus: () => ipcRenderer.invoke("minicpm:update-status"),
  updateApply:  () => ipcRenderer.invoke("minicpm:update-apply"),

  // Chat generation parameters (shared with Settings tab)
  getChatParams: () => ipcRenderer.invoke("minicpm:get-chat-params"),

  // Adapter (LoRA) load/unload — same IPC handler the Settings tab
  // uses, so chat-based switching ("切到猫娘") persists the user's
  // choice to prefs and shares the 90s timeout + bubble notification
  // pipeline. Pass `null` to unload.
  loadAdapter: (pathOrNull) => ipcRenderer.invoke("minicpm-settings:load-adapter", { path: pathOrNull }),

  // Messages from main → renderer
  onOpen:           (cb) => ipcRenderer.on("minicpm:cmd-open",            (_e, payload) => cb(payload || {})),
  onDismiss:        (cb) => ipcRenderer.on("minicpm:cmd-dismiss",         () => cb()),
  onReset:          (cb) => ipcRenderer.on("minicpm:cmd-reset",           () => cb()),
  onToggleThinking: (cb) => ipcRenderer.on("minicpm:cmd-toggle-thinking", () => cb()),
  onUpdateStatus:   (cb) => ipcRenderer.on("minicpm:update-status",       (_e, p) => cb(p || {})),
  onUpdateApplying: (cb) => ipcRenderer.on("minicpm:update-applying",     (_e, p) => cb(p || {})),
  onNarrate:        (cb) => ipcRenderer.on("minicpm:narrate",             (_e, p) => cb(p || {})),
  onCmdReply:       (cb) => ipcRenderer.on("minicpm:cmd-reply",           (_e, p) => cb(p || {})),
  onEditMode:       (cb) => ipcRenderer.on("minicpm:edit-mode",           (_e, p) => cb(p || {})),
});
