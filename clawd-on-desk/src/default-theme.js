"use strict";

/** Built-in theme used when prefs are missing or lenient load must recover. */
const DEFAULT_THEME_ID = "cybercat";

// Dual export: Node (main process / tests) gets module.exports; the
// Settings window renderer (nodeIntegration: false) consumes the same
// constant via globalThis.ClawdDefaultTheme. Keep both in sync.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { DEFAULT_THEME_ID };
}
if (typeof globalThis !== "undefined") {
  globalThis.ClawdDefaultTheme = { DEFAULT_THEME_ID };
}
