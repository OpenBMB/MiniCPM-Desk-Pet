"use strict";
//
// MiniCPM Onboarding — first-launch wizard.
//
// Lives as a single BrowserWindow (NOT a panel) shown before the pet
// when <userData>/minicpm-onboarding.json is missing or stale. Drives
// the user through 3 stages (compressed from the earlier 5 in v0.8.1):
//   1 env-check  — disk space + network + platform sanity
//   2 model      — user picks online download OR loads a local .gguf;
//                  warmup runs inline on the same panel
//   3 ready      — handoff to the pet window
//
// Accelerator selection was retired in this redesign — sidecar picks
// the right backend automatically (Metal on mac, CUDA/CPU elsewhere).
// The legacy `onboarding:list-devices` / `onboarding:select-device`
// IPC handlers are kept untouched so that other call sites (Settings
// tab, automation scripts) keep working, but the wizard renderer no
// longer invokes them.
//
// On `onboarding:complete` we write a sentinel file and invoke the
// `onComplete` callback supplied by main.js, which then constructs the
// pet window and warms the sidecar in the background.
//

const { BrowserWindow, ipcMain, dialog, app } = require("electron");
const fs = require("fs");
const http = require("http");
const path = require("path");
const os = require("os");

const isMac = process.platform === "darwin";
const SENTINEL_FILE = "minicpm-onboarding.json";
const CURRENT_VERSION = 1;

function userDataPath(name) {
  try { return path.join(app.getPath("userData"), name); }
  catch { return path.join(os.tmpdir(), name); }
}

function httpJson(method, urlStr, body, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const opts = {
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + (u.search || ""),
      method,
      headers: { "content-type": "application/json" },
      timeout: timeoutMs,
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode || 0, json: data ? JSON.parse(data) : null });
        } catch {
          resolve({ status: res.statusCode || 0, json: null, raw: data });
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Stream SSE from a POST endpoint and call `onEvent(parsedJSON)` for each
// "data: {...}" block. Resolves when the stream ends.
function postSSE(urlStr, onEvent) {
  return new Promise((resolve) => {
    const u = new URL(urlStr);
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname,
      method: "POST",
      headers: { "content-type": "application/json", "content-length": 0 },
      timeout: 0,
    }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (!block.startsWith("data:")) continue;
          try {
            const ev = JSON.parse(block.slice(5).trim());
            try { onEvent && onEvent(ev); } catch {}
          } catch {}
        }
      });
      res.on("end", () => resolve({ ok: true }));
    });
    req.on("error", (err) => resolve({ ok: false, error: err.message }));
    req.end();
  });
}

module.exports = function initOnboarding(ctx) {
  // ctx must provide:
  //   getSidecarUrl()    — http://127.0.0.1:18765
  //   getChat()          — the _minicpmChat instance from main.js (lazy
  //                         access so we can read effective model dir,
  //                         restart sidecar, etc.)
  //   onComplete()       — called once user finishes the wizard; main.js
  //                         creates the pet window inside this callback
  //   onCancel()         — called when the user closes the wizard window
  //                         without finishing it; main.js should quit the
  //                         entire app so the spawned sidecar / llama-
  //                         server children don't get orphaned (LSUIElement
  //                         apps never reach `window-all-closed` → quit
  //                         on their own with no pet window or tray yet).
  const log = (msg) => { try { console.log(msg); } catch {} };
  let win = null;
  // True while the close was initiated by `onboarding:complete` (or any
  // other internal call to close()). Lets the `closed` handler tell user-
  // cancel apart from completion so onCancel only fires on the former.
  let internalClose = false;

  // ── sentinel file (records "did the user already finish onboarding") ───
  function readSentinel() {
    try {
      return JSON.parse(fs.readFileSync(userDataPath(SENTINEL_FILE), "utf-8"));
    } catch { return null; }
  }
  function writeSentinel(extra = {}) {
    const payload = {
      complete: true,
      version: CURRENT_VERSION,
      completedAt: new Date().toISOString(),
      ...extra,
    };
    try {
      fs.writeFileSync(userDataPath(SENTINEL_FILE), JSON.stringify(payload, null, 2), "utf-8");
    } catch (err) {
      log(`[onboarding] sentinel save failed: ${err && err.message}`);
    }
    return payload;
  }
  function shouldShow() {
    // Force-rerun via env (developer override).
    if (process.env.MINICPM_FORCE_ONBOARDING === "1") return true;
    const s = readSentinel();
    if (!s || s.complete !== true) return true;
    // Future-proof: a schema bump invalidates older sentinels.
    if (typeof s.version === "number" && s.version < CURRENT_VERSION) return true;
    // If the model directory the user picked has vanished (e.g. they
    // deleted ~/Library/.../models/ manually) we re-show the wizard so
    // they can pick a new path or re-download.
    try {
      const chat = ctx && ctx.getChat && ctx.getChat();
      if (chat && typeof chat.isModelPresent === "function" && !chat.isModelPresent()) {
        return true;
      }
    } catch {}
    return false;
  }
  function reset() {
    try { fs.unlinkSync(userDataPath(SENTINEL_FILE)); } catch {}
  }

  // ── BrowserWindow lifecycle ────────────────────────────────────────────
  function createWindow() {
    win = new BrowserWindow({
      width: 820,
      height: 560,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      title: "MiniCPM 桌宠 — 首次启动",
      show: false,
      autoHideMenuBar: true,
      // Plain top-level window — not a panel — so it behaves like a
      // normal install wizard with proper focus/zorder semantics on mac.
      webPreferences: {
        preload: path.join(__dirname, "preload-minicpm-onboarding.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.setMenuBarVisibility(false);
    win.loadFile(path.join(__dirname, "minicpm-onboarding.html"));
    win.once("ready-to-show", () => {
      win.show();
      win.focus();
    });
    // User-initiated close (red traffic light, Cmd+W, Cmd+Q) reaches us
    // through "closed" with `internalClose === false`. In that case the
    // sidecar / llama-server children we may have spawned during the
    // download / warmup phases would be orphaned (no pet window or tray
    // yet, so window-all-closed has nothing to anchor onto). Bubble up
    // a cancel so main.js can drive a clean app shutdown.
    win.on("closed", () => {
      const wasInternal = internalClose;
      internalClose = false;
      win = null;
      if (!wasInternal && ctx && typeof ctx.onCancel === "function") {
        try { ctx.onCancel(); } catch (err) {
          log(`[onboarding] onCancel callback failed: ${err && err.message}`);
        }
      }
    });
    return win;
  }

  function open() {
    if (win && !win.isDestroyed()) {
      win.show();
      win.focus();
      return;
    }
    createWindow();
  }

  function close() {
    if (win && !win.isDestroyed()) {
      internalClose = true;
      try { win.close(); } catch {}
    }
    win = null;
  }

  function progress(event, payload) {
    if (win && !win.isDestroyed()) {
      try { win.webContents.send("onboarding:progress", { event, ...payload }); }
      catch {}
    }
  }

  // ── IPC handlers ───────────────────────────────────────────────────────
  const handlers = {
    "onboarding:get-state": async () => {
      const chat = ctx.getChat();
      const url = ctx.getSidecarUrl();
      // /api/onboarding is best-effort: if the sidecar isn't up yet
      // (typical for first launch) we synthesize a reasonable default.
      let snapshot = null;
      try {
        const r = await httpJson("GET", `${url}/api/onboarding`, null, 1500);
        snapshot = r.json;
      } catch {}
      const modelDir = chat && chat.getModelDir ? chat.getModelDir() : null;
      const defaultModelDir = chat && chat.getDefaultModelDir ? chat.getDefaultModelDir() : null;
      const modelPresent = chat && chat.isModelPresent ? chat.isModelPresent() : false;
      return {
        sidecarUrl: url,
        sidecarReachable: !!snapshot,
        modelDir,
        defaultModelDir,
        modelPresent,
        device: snapshot ? snapshot.device : null,
        platform: process.platform,
        appVersion: app.getVersion(),
      };
    },

    "onboarding:check-disk": async () => {
      // Cheap proxy: try to write a tiny file to userData, then unlink.
      // We don't need exact free-bytes for MVP — just confirm writability.
      try {
        const probe = userDataPath(".onboarding-probe");
        fs.writeFileSync(probe, "ok");
        fs.unlinkSync(probe);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err && err.message || err) };
      }
    },

    // Real free-space probe + 5 GB threshold for the model + caches.
    // Uses fs.statfs (Node 18.15+) — Electron 41 ships Node 22 so it's
    // always available. Probes the userData directory because that's
    // where the model lands by default.
    "onboarding:disk-info": async () => {
      const REQUIRED_BYTES = 5 * 1024 * 1024 * 1024;
      let freeBytes = null;
      let totalBytes = null;
      let probedPath = null;
      try {
        probedPath = userDataPath(".");
        fs.mkdirSync(probedPath, { recursive: true });
        if (typeof fs.statfs === "function") {
          const stats = await new Promise((resolve, reject) => {
            fs.statfs(probedPath, (err, s) => err ? reject(err) : resolve(s));
          });
          // bavail × bsize is "free space available to a non-root user",
          // which is what we actually care about for the download.
          freeBytes = Number(stats.bavail) * Number(stats.bsize);
          totalBytes = Number(stats.blocks) * Number(stats.bsize);
        }
      } catch (err) {
        return {
          ok: false,
          error: String(err && err.message || err),
          freeBytes: null,
          totalBytes: null,
          requiredBytes: REQUIRED_BYTES,
          probedPath,
        };
      }
      return {
        ok: freeBytes != null && freeBytes >= REQUIRED_BYTES,
        freeBytes,
        totalBytes,
        requiredBytes: REQUIRED_BYTES,
        probedPath,
      };
    },

    // Real-time chip / platform info. On darwin we ask sysctl for the
    // full brand string ("Apple M3 Pro" / "Intel(R) Core(TM) ...") since
    // os.cpus()[0].model sometimes truncates Apple Silicon variants.
    // Falls back to os.cpus on win/linux.
    "onboarding:platform-info": async () => {
      let chip = null;
      if (process.platform === "darwin") {
        try {
          const { execFileSync } = require("child_process");
          const out = execFileSync("/usr/sbin/sysctl", ["-n", "machdep.cpu.brand_string"], {
            timeout: 1500,
            encoding: "utf-8",
          });
          chip = (out || "").trim() || null;
        } catch {}
      }
      if (!chip) {
        try {
          const cpus = os.cpus();
          chip = (cpus && cpus[0] && cpus[0].model) ? String(cpus[0].model).trim() : null;
        } catch {}
      }
      const supported = process.platform === "darwin"
        || process.platform === "linux"
        || process.platform === "win32";
      return {
        platform: process.platform,
        arch: process.arch,
        chip: chip || null,
        supported,
      };
    },

    "onboarding:list-devices": async () => {
      try {
        const r = await httpJson("GET", `${ctx.getSidecarUrl()}/api/devices`, null, 2000);
        return r.json || { available: ["cpu"], recommended: "cpu" };
      } catch (err) {
        // Sidecar isn't up yet — synthesize from platform.
        if (isMac && process.arch === "arm64") {
          return {
            available: ["mps", "cpu"],
            recommended: "mps",
            current: null,
            reasons: { mps: "Apple Silicon GPU (Metal)", cpu: "纯 CPU 推理" },
            offline: true,
          };
        }
        return {
          available: ["cpu"],
          recommended: "cpu",
          current: null,
          reasons: { cpu: "纯 CPU 推理" },
          offline: true,
        };
      }
    },

    "onboarding:select-device": async (_evt, { device } = {}) => {
      // Persist for next sidecar start; if sidecar is already up, ask it
      // to record the env var too (no-op when not running).
      process.env.MINICPM_DEVICE = device || "";
      try {
        await httpJson("POST", `${ctx.getSidecarUrl()}/api/set-device`, { device }, 1500);
      } catch {}
      return { ok: true, device };
    },

    "onboarding:pick-local-model": async () => {
      // The llama.cpp backend takes a single .gguf file, but for back-
      // compat with users who pre-staged HF directories we accept a
      // directory too (the gateway picks the first .gguf inside).
      const ret = await dialog.showOpenDialog({
        title: "选择本地 MiniCPM 模型 (.gguf 文件或包含 .gguf 的目录)",
        properties: ["openFile", "openDirectory"],
        filters: [{ name: "GGUF model", extensions: ["gguf"] }],
        message: "可以是单个 .gguf 文件，或包含 .gguf 的目录",
      });
      if (ret.canceled || !ret.filePaths.length) return { ok: false, canceled: true };
      const picked = ret.filePaths[0];
      let target = picked;
      try {
        const st = fs.statSync(picked);
        if (st.isDirectory()) {
          const entries = fs.readdirSync(picked)
            .filter((n) => n.toLowerCase().endsWith(".gguf"));
          if (!entries.length) {
            return { ok: false, error: `所选目录不包含 .gguf：\n${picked}` };
          }
          target = path.join(picked, entries[0]);
        } else if (!picked.toLowerCase().endsWith(".gguf")) {
          return { ok: false, error: `请选择 .gguf 文件：\n${picked}` };
        }
      } catch (err) {
        return { ok: false, error: String(err && err.message || err) };
      }
      const chat = ctx.getChat();
      if (chat && chat.setModelDir) chat.setModelDir(target);
      return { ok: true, modelDir: target };
    },

    "onboarding:start-model-download": async () => {
      // Make sure the sidecar is running before kicking off the SSE.
      // We need /api/update-apply to be reachable.
      const r = await ctx.ensureSidecarRunning();
      if (!r || r.ok === false) {
        const msg = (r && r.error) || "sidecar 启动失败";
        progress("error", { phase: "sidecar-start", message: msg });
        return { ok: false, error: msg };
      }
      const url = `${ctx.getSidecarUrl()}/api/update-apply`;
      progress("start", { phase: "download" });
      const result = await postSSE(url, (ev) => progress("download", ev));
      progress("done", { phase: "download", ok: result.ok });
      return result;
    },

    "onboarding:warmup": async () => {
      // Sidecar may need to load weights for the first time — give it
      // generous timeout (matches Sidecar._spawnAndWait deadline).
      progress("start", { phase: "warmup" });
      const ready = await ctx.ensureSidecarRunning();
      if (!ready || ready.ok === false) {
        const msg = (ready && ready.error) || "sidecar 未就绪";
        progress("error", { phase: "sidecar-start", message: msg });
        return { ok: false, error: msg };
      }
      try {
        const r = await httpJson("POST", `${ctx.getSidecarUrl()}/api/warmup`, {}, 120_000);
        progress("done", { phase: "warmup", elapsed_ms: r.json && r.json.elapsed_ms });
        return { ok: true, ...(r.json || {}) };
      } catch (err) {
        progress("error", { phase: "warmup", message: String(err && err.message || err) });
        return { ok: false, error: String(err && err.message || err) };
      }
    },

    "onboarding:complete": async () => {
      // device is intentionally pinned to "auto" since v0.8.1 — the
      // wizard no longer exposes accelerator selection. The Settings
      // tab can still override later via MINICPM_DEVICE.
      writeSentinel({ device: "auto" });
      try { ctx.onComplete && ctx.onComplete(); } catch (err) {
        log(`[onboarding] onComplete callback failed: ${err && err.message}`);
      }
      close();
      return { ok: true };
    },

    "onboarding:reset": async () => {
      reset();
      return { ok: true };
    },

    // Triggered when the user switches model source mid-wizard (download
    // ↔ local). We stop and re-spawn the sidecar so it picks up the new
    // effective model path; otherwise warmup would no-op against the
    // previously-loaded weights.
    "onboarding:restart-sidecar": async () => {
      try {
        const chat = ctx.getChat();
        if (chat && typeof chat.restartSidecar === "function") {
          const r = await chat.restartSidecar();
          return { ok: true, status: r && r.status };
        }
        return { ok: false, error: "chat.restartSidecar unavailable" };
      } catch (err) {
        return { ok: false, error: String(err && err.message || err) };
      }
    },
  };

  for (const [ch, fn] of Object.entries(handlers)) {
    try { ipcMain.removeHandler(ch); } catch {}
    ipcMain.handle(ch, fn);
  }

  return {
    shouldShow,
    open,
    close,
    reset,
    isOpen: () => !!(win && !win.isDestroyed()),
  };
};
