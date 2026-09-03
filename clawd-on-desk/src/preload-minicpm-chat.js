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

  // Chat generation parameters (shared with Settings tab)
  getChatParams: () => ipcRenderer.invoke("minicpm:get-chat-params"),

  // i18n: initial fetch + live updates
  getI18n: () => ipcRenderer.invoke("minicpm:get-i18n"),
  onLangChange: (cb) => {
    const listener = (_e, payload) => { try { cb(payload || {}); } catch {} };
    ipcRenderer.on("minicpm:lang-change", listener);
    return () => ipcRenderer.removeListener("minicpm:lang-change", listener);
  },

  // Messages from main → renderer
  onOpen:           (cb) => ipcRenderer.on("minicpm:cmd-open",            (_e, payload) => cb(payload || {})),
  onDismiss:        (cb) => ipcRenderer.on("minicpm:cmd-dismiss",         () => cb()),
  onReset:          (cb) => ipcRenderer.on("minicpm:cmd-reset",           () => cb()),
  onToggleThinking: (cb) => ipcRenderer.on("minicpm:cmd-toggle-thinking", () => cb()),
  onNarrate:        (cb) => ipcRenderer.on("minicpm:narrate",             (_e, p) => cb(p || {})),
  onCmdReply:       (cb) => ipcRenderer.on("minicpm:cmd-reply",           (_e, p) => cb(p || {})),
  onEditMode:       (cb) => ipcRenderer.on("minicpm:edit-mode",           (_e, p) => cb(p || {})),
});
