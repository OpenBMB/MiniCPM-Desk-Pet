"use strict";
//
// MiniCPM Chat — a single bubble window that lives next to the pet and acts
// like a speech / thought balloon. Click pet → input bubble pops up; press
// Enter → bubble vanishes while the pet does its thinking animation; once the
// model starts replying, the bubble reappears with the streamed text and
// fades out a few seconds after the reply finishes.
//
// The window is created lazily on first open and then *hidden* on dismiss —
// the renderer keeps the in-memory conversation history across opens.
//
// Layout assumption:
//   <repo-root>/clawd-on-desk        ← this Electron app
//   <repo-root>/minicpm-sidecar      ← OpenVINO sidecar (gateway/ FastAPI,
//                                       inference in-process, no child server)
//   <userData>/models/<ir-dir>/      ← OpenVINO IR the user picked
//
// Override locations via env:
//   MINICPM_SIDECAR_BIN  — point at a prebuilt gateway binary
//   MINICPM_SIDECAR_DIR  — point at the minicpm-sidecar source tree (dev)
//   MINICPM_PYTHON       — explicit Python interpreter (dev fallback)

const { BrowserWindow, ipcMain, screen, shell, Menu, app } = require("electron");
const { spawn, execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";
const isLinux = process.platform === "linux";
const WIN_TOPMOST_LEVEL = "pop-up-menu";
const LINUX_WINDOW_TYPE = "splash";

// Port chosen to dodge common collisions on dev machines: 8765 is used
// by Apache CouchDB tests, Bitcoin Cash testnet, and a few other tools.
// 18765 ("1" prefix on the old default) is unassigned by IANA and easy
// to remember. Override via MINICPM_PORT env if you need something else.
const DEFAULT_PORT = 18765;
const DEFAULT_HOST = "127.0.0.1";
const BUBBLE_GAP = 8;   // pixels between visible pet sprite and bubble
const EDGE_MARGIN = 8;

const ASK_WIDTH = 120;       // initial empty-input width — tiny pill
const ASK_HEIGHT = 44;
const SPEAK_MAX_WIDTH = 360;
const SPEAK_MAX_HEIGHT = 360;
const MIN_WIDTH = 100;
const MIN_HEIGHT = 40;

// ── locate sidecar binary / dev sources / Python interpreter ───────────────
//
// Two runtime modes, in priority order:
//   A. Packaged app   → bundled binary at <resourcesPath>/sidecar-bin/
//                         minicpm-sidecar(.exe)   ← PyInstaller gateway,
//                                                   OpenVINO runtime frozen in
//                       (the only path real users ever hit)
//   B. Dev with venv  → minicpm-sidecar/.venv/bin/python -m gateway
//                       (created by `uv sync` inside minicpm-sidecar/)
//
// MINICPM_SIDECAR_BIN / MINICPM_SIDECAR_DIR / MINICPM_PYTHON env vars
// override every mode for local debugging.

function locateSidecarBinary(appRoot) {
  const override = process.env.MINICPM_SIDECAR_BIN;
  if (override && fs.existsSync(override)) return path.resolve(override);
  const ext = process.platform === "win32" ? ".exe" : "";
  if (app && app.isPackaged) {
    // electron-builder puts the binary under
    //   <Contents>/Resources/sidecar-bin/         (macOS .app bundle)
    //   <install>/resources/sidecar-bin/          (Windows / Linux)
    const candidates = [
      path.join(process.resourcesPath, "sidecar-bin", "minicpm-sidecar" + ext),
      path.join(process.resourcesPath, "sidecar-bin", "minicpm-sidecar", "minicpm-sidecar" + ext),
    ];
    for (const c of candidates) {
      try { if (fs.statSync(c).isFile()) return c; } catch {}
    }
  }
  // Dev convenience: scripts/build-gateway.* emits a onedir bundle under
  // <repo>/minicpm-sidecar/bin/<os>-<arch>/. The flat path is checked too so
  // an older onefile build still resolves.
  const triple = triplet();
  const devRoot = path.join(appRoot, "..", "minicpm-sidecar", "bin", triple);
  for (const c of [
    path.join(devRoot, "minicpm-sidecar", "minicpm-sidecar" + ext),
    path.join(devRoot, "minicpm-sidecar" + ext),
  ]) {
    try { if (fs.statSync(c).isFile()) return c; } catch {}
  }
  return null;
}

function locateSidecarSourceDir(appRoot) {
  const override = process.env.MINICPM_SIDECAR_DIR;
  if (override) {
    try {
      if (fs.statSync(path.join(override, "gateway", "__main__.py")).isFile()) {
        return path.resolve(override);
      }
    } catch {}
  }
  const candidates = [];
  if (app && app.isPackaged) {
    // Packaged builds ship the source next to the binary so a dev
    // override at MINICPM_PYTHON still has somewhere to point at.
    candidates.push(path.join(process.resourcesPath, "minicpm-sidecar"));
  }
  candidates.push(path.join(appRoot, "..", "minicpm-sidecar"));
  for (const c of candidates) {
    try {
      if (fs.statSync(path.join(c, "gateway", "__main__.py")).isFile()) {
        return path.resolve(c);
      }
    } catch {}
  }
  return null;
}

function locatePython(sidecarDir) {
  // 1. Explicit override always wins.
  const explicit = process.env.MINICPM_PYTHON;
  if (explicit && fs.existsSync(explicit)) return explicit;

  if (!sidecarDir) return null;
  const venvCandidates = [
    path.join(sidecarDir, ".venv", "bin", "python"),
    path.join(sidecarDir, ".venv", "bin", "python3"),
    path.join(sidecarDir, ".venv", "Scripts", "python.exe"),
  ];
  for (const p of venvCandidates) {
    try { if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}

function triplet() {
  // Matches electron-builder's `${os}-${arch}` expansion so extraResources
  // paths and our dev bin/<triple>/ layout line up.
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : process.arch;
  if (process.platform === "darwin") return "mac-"   + arch;
  if (process.platform === "win32")  return "win-"   + arch;
  if (process.platform === "linux")  return "linux-" + arch;
  return process.platform + "-" + arch;
}

// ── OpenVINO IR detection ──────────────────────────────────────────────
//
// A model is a directory holding openvino_model.xml, not a single file.
// Module scope so tests can reach these without mocking Electron.

const OPENVINO_IR_MARKER = "openvino_model.xml";

function openvinoIrsIn(dir) {
  try {
    if (fs.statSync(path.join(dir, OPENVINO_IR_MARKER)).isFile()) return [dir];
  } catch {}
  const out = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sub = path.join(dir, entry.name);
      try {
        if (fs.statSync(path.join(sub, OPENVINO_IR_MARKER)).isFile()) out.push(sub);
      } catch {}
    }
  } catch {}
  return out;
}

function firstOpenvinoIrIn(dir) {
  try {
    if (fs.statSync(path.join(dir, OPENVINO_IR_MARKER)).isFile()) return dir;
  } catch {}
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sub = path.join(dir, entry.name);
      try {
        if (fs.statSync(path.join(sub, OPENVINO_IR_MARKER)).isFile()) return sub;
      } catch {}
    }
  } catch {}
  return null;
}

// ── HTTP probe helpers ──────────────────────────────────────────────────────

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

// ── Sidecar manager ─────────────────────────────────────────────────────────

class Sidecar {
  constructor({ sidecarDir, sidecarBin, appRoot, port, host, log, logFile, modelPresent }) {
    // Source tree of minicpm-sidecar; used only in dev when no prebuilt
    // binary is present. Packaged builds ignore it entirely.
    this.sidecarDir = sidecarDir || null;
    // Optional prebuilt gateway binary. When set we skip Python lookup.
    // Populated in packaged builds via electron-builder extraResources →
    // resources/sidecar-bin/minicpm-sidecar[.exe].
    this.sidecarBin = sidecarBin || null;
    this.appRoot = appRoot || null;
    this.port = port;
    this.host = host;
    this.log = log || (() => {});
    this.proc = null;
    this.starting = null;
    this.stderrTail = [];
    // Append-mode file stream where every stdout / stderr line from the
    // sidecar gets persisted to <userData>/logs/sidecar.log. Critical
    // for packaged builds where console.log goes nowhere.
    this.logFile = logFile || null;
    this._fileStream = null;
    this._fileSizeBudget = 2 * 1024 * 1024; // 2 MB before rotate
    this._fileBytesWritten = 0;
    this.modelPresent = typeof modelPresent === "function" ? modelPresent : (() => false);
  }

  _openLogStream() {
    if (!this.logFile) return null;
    if (this._fileStream) return this._fileStream;
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      // Pre-rotate if the existing file is already over budget so we
      // start clean each app launch (or restart of the sidecar).
      try {
        const st = fs.statSync(this.logFile);
        if (st.size > this._fileSizeBudget) {
          fs.renameSync(this.logFile, this.logFile + ".1");
        }
      } catch {}
      this._fileStream = fs.createWriteStream(this.logFile, { flags: "a" });
      this._fileBytesWritten = 0;
      const ts = new Date().toISOString();
      this._fileStream.write(`\n===== sidecar session ${ts} (host=${this.host} port=${this.port}) =====\n`);
    } catch (err) {
      this.log(`[minicpm-chat] open log file failed: ${err && err.message}`);
    }
    return this._fileStream;
  }

  _appendLog(line) {
    const stream = this._openLogStream();
    if (!stream) return;
    try {
      const chunk = line.endsWith("\n") ? line : line + "\n";
      stream.write(chunk);
      this._fileBytesWritten += Buffer.byteLength(chunk);
      // Soft rotate: when the stream grows past budget, roll over once.
      // We do this lazily so we don't fsync on every line.
      if (this._fileBytesWritten > this._fileSizeBudget) {
        try {
          stream.end();
          fs.renameSync(this.logFile, this.logFile + ".1");
        } catch {}
        this._fileStream = null;
        this._fileBytesWritten = 0;
      }
    } catch {}
  }

  // Pull last N stderr chunks (raw) for inclusion in error toasts /
  // crash dumps.
  _stderrTailString(maxChars = 1500) {
    return (this.stderrTail.join("").trim().slice(-maxChars)) || "(no stderr)";
  }

  baseUrl() { return `http://${this.host}:${this.port}`; }

  async ensureRunning(initialModelDir) {
    if (await this.isHealthy(initialModelDir)) return { status: "already-running" };

    // Gateway may be running but without a loaded model (alive=false).
    // Hot-load via /api/load-model instead of spawning a second process
    // which would fail with EADDRINUSE on the same port.
    if (this.proc && this.modelPresent(initialModelDir)) {
      const ir = this._resolveModelPath(initialModelDir);
      if (ir) {
        const loaded = await this.loadModel(ir);
        if (loaded && loaded.ok) return { status: "model-loaded" };
      }
    }

    if (this.starting) return this.starting;
    this.starting = this._spawnAndWait(initialModelDir).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  _resolveModelPath(dirOrFile) {
    try {
      if (!fs.statSync(dirOrFile).isDirectory()) return null;
    } catch { return null; }
    return firstOpenvinoIrIn(dirOrFile);
  }

  async isHealthy(initialModelDir) {
    try {
      const r = await httpJson("GET", `${this.baseUrl()}/api/health`, null, 1500);
      if (!(r.status === 200 && r.json && r.json.ok === true)) return false;
      if (this.modelPresent(initialModelDir)) {
        return r.json.alive === true
          || !!(r.json.engine && r.json.engine.status === "ok");
      }
      return true;
    } catch {
      return false;
    }
  }

  async listModels() {
    try {
      const r = await httpJson("GET", `${this.baseUrl()}/api/models`, null, 2000);
      return r.json || null;
    } catch { return null; }
  }

  async loadModel(p) {
    try {
      const r = await httpJson("POST", `${this.baseUrl()}/api/load-model`, { path: p }, 90000);
      return r.json || null;
    } catch (err) { return { error: String(err && err.message || err) }; }
  }

  async _spawnAndWait(initialModelDir) {
    // We need either the prebuilt gateway binary or the source tree
    // (with a Python venv) to spawn.
    if (!this.sidecarBin && !this.sidecarDir) {
      const err = new Error("sidecar binary not found");
      err.minicpmI18nKey = "chatSidecarMissingBin";
      throw err;
    }

    // Both the binary and `python -m gateway` accept the same flags;
    // we treat them uniformly here.
    const argsCommon = [
      "--host", this.host,
      "--port", String(this.port),
    ];
    if (initialModelDir) argsCommon.push("--model", initialModelDir);

    const env = {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      // Mirror our sidecar.log directory into the gateway so its
      // RotatingFileHandler drops sidecar-internal.log next to what
      // Electron captures — easy to grab via Settings → "打开日志目录".
      MINICPM_LOG_DIR: this.logFile ? path.dirname(this.logFile) : (process.env.MINICPM_LOG_DIR || ""),
      // Pin the parent-watchdog inside the gateway to OUR pid (Electron
      // main), not to whatever ppid the PyInstaller bootloader's Python
      // re-exec hop ends up with. If Electron crashes or is `kill -9`'d,
      // the watchdog notices our pid is gone and releases :18765 and the
      // compiled model within ~2s instead of leaking both.
      MINICPM_PARENT_PID: String(process.pid),
    };

    // Strip proxy environment variables to avoid socksio dependency issues.
    // The sidecar makes no outbound calls at all.
    const proxyVars = [
      "http_proxy", "https_proxy", "ftp_proxy", "socks_proxy",
      "HTTP_PROXY", "HTTPS_PROXY", "FTP_PROXY", "SOCKS_PROXY",
      "all_proxy", "ALL_PROXY",
    ];
    for (const v of proxyVars) {
      delete env[v];
    }

    let proc;
    if (this.sidecarBin) {
      // Production path: a self-contained gateway binary with the
      // OpenVINO runtime frozen in. No Python interpreter on the host.
      this.log(`[minicpm-chat] spawn binary ${this.sidecarBin} --port ${this.port}`);
      proc = spawn(this.sidecarBin, argsCommon, {
        cwd: path.dirname(this.sidecarBin),
        env,
      });
    } else {
      const python = locatePython(this.sidecarDir);
      if (!python) {
        const err = new Error("Python interpreter not found");
        err.minicpmI18nKey = "chatSidecarMissingPython";
        throw err;
      }
      this.log(`[minicpm-chat] spawn ${python} -m gateway --port ${this.port}`);
      proc = spawn(python, ["-m", "gateway", ...argsCommon], {
        cwd: this.sidecarDir,
        env,
      });
    }

    this.proc = proc;
    this.stderrTail.length = 0;

    // Make sure the log file is open for the new session.
    this._openLogStream();
    this._appendLog(`[spawn] ${this.sidecarBin || "python"} (pid=${proc.pid})`);

    proc.stdout.on("data", (b) => {
      const s = b.toString();
      this.log(`[sidecar] ${s.trimEnd()}`);
      this._appendLog(`[stdout] ${s.trimEnd()}`);
    });
    proc.stderr.on("data", (b) => {
      const s = b.toString();
      this.log(`[sidecar! ] ${s.trimEnd()}`);
      this._appendLog(`[stderr] ${s.trimEnd()}`);
      this.stderrTail.push(s);
      if (this.stderrTail.length > 40) this.stderrTail.shift();
    });
    proc.on("exit", (code, signal) => {
      this.log(`[minicpm-chat] sidecar exited code=${code} signal=${signal}`);
      this._appendLog(`[exit] code=${code} signal=${signal}`);
      // If the process died with a non-zero exit (and wasn't a clean
      // SIGTERM from our own stop()), archive the recent stderr tail as
      // a standalone crash dump so we can investigate after restart.
      const crashed = (typeof code === "number" && code !== 0) ||
                       (signal && signal !== "SIGTERM");
      if (crashed && this.logFile) {
        try {
          const dir = path.dirname(this.logFile);
          const ts = new Date().toISOString().replace(/[:.]/g, "-");
          const dump = path.join(dir, `sidecar-crash-${ts}.log`);
          const header =
            `# sidecar crash dump\n` +
            `# at:    ${new Date().toISOString()}\n` +
            `# code:  ${code}\n` +
            `# sig:   ${signal}\n` +
            `# pid:   ${proc.pid}\n` +
            `# bin:   ${this.sidecarBin || "python"}\n` +
            `# port:  ${this.port}\n` +
            `\n----- stderr tail -----\n`;
          fs.writeFileSync(dump, header + this._stderrTailString(8000), "utf-8");
          // Prune to the 5 most recent crash dumps.
          try {
            const files = fs.readdirSync(dir)
              .filter((f) => f.startsWith("sidecar-crash-"))
              .sort()
              .reverse();
            for (const old of files.slice(5)) {
              try { fs.unlinkSync(path.join(dir, old)); } catch {}
            }
          } catch {}
          this.log(`[minicpm-chat] crash dump → ${dump}`);
        } catch (err) {
          this.log(`[minicpm-chat] failed to write crash dump: ${err && err.message}`);
        }
      }
      if (this.proc === proc) this.proc = null;
    });

    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (!this.proc) {
        const err = new Error(`Python process exited prematurely. stderr tail:\n${this._stderrTailString(1500)}`);
        err.minicpmI18nKey = "chatSidecarPyExited";
        err.minicpmI18nParams = { tail: this._stderrTailString(1500) };
        throw err;
      }
      const health = await httpJson("GET", `${this.baseUrl()}/api/health`, null, 1500).catch(() => null);
      if (health && health.status === 200 && health.json && health.json.ok === true) {
        if (this.modelPresent(initialModelDir)) {
          if (health.json.startup_error) {
            this.stop();
            throw new Error(`engine failed to start: ${health.json.startup_error}`);
          }
          if (
            health.json.alive === true ||
            (health.json.engine && health.json.engine.status === "ok")
          ) {
            return { status: "started" };
          }
        } else {
          return { status: "started" };
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    this.stop();
    const err = new Error("Timed out waiting for Python service (90s)");
    err.minicpmI18nKey = "chatSidecarTimeout";
    throw err;
  }

  stop() {
    if (!this.proc) return;
    const proc = this.proc;
    const pid = proc.pid;

    if (process.platform === "win32" && pid) {
      // Windows doesn't deliver SIGTERM, and a polite exit deadlocks if the
      // sidecar is mid-`generate()` (see lifecycle.hard_exit). /T also
      // catches anything it spawned that would keep holding :18765.
      try {
        execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
      } catch {
        try { proc.kill("SIGKILL"); } catch {}
      }
      return;
    }

    try { proc.kill("SIGTERM"); } catch {}
    setTimeout(() => {
      if (this.proc === proc) { try { proc.kill("SIGKILL"); } catch {} }
    }, 2000).unref();
  }

  async stopAndWait(timeoutMs = 5000) {
    const proc = this.proc;
    this.stop();

    const waitForProcExit = async () => {
      if (!proc || proc.exitCode != null || proc.signalCode != null) return true;
      return new Promise((resolve) => {
        let done = false;
        let timer = null;
        const finish = (exited) => {
          if (done) return;
          done = true;
          try { proc.removeListener("exit", onExit); } catch {}
          if (timer) clearTimeout(timer);
          resolve(exited);
        };
        const onExit = () => finish(true);
        proc.once("exit", onExit);
        timer = setTimeout(() => finish(false), timeoutMs);
        if (timer && typeof timer.unref === "function") timer.unref();
      });
    };

    const waitForHealthDown = async (deadline) => {
      let misses = 0;
      while (Date.now() < deadline) {
        const r = await httpJson("GET", `${this.baseUrl()}/api/health`, null, 300).catch(() => null);
        if (r && r.status === 200 && r.json && r.json.ok === true) {
          misses = 0;
        } else {
          misses += 1;
          if (misses >= 2) return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      return false;
    };

    if (!(await waitForProcExit())) {
      throw new Error("Timed out waiting for sidecar process to exit");
    }
    if (!(await waitForHealthDown(Date.now() + timeoutMs))) {
      throw new Error("Timed out waiting for sidecar port to close");
    }
  }
}

// ── Bubble positioning ──────────────────────────────────────────────────────

function pickSide(petBounds, workArea, width, height, preferred = "auto") {
  const wb = workArea.x + workArea.width;
  const hb = workArea.y + workArea.height;
  const fitsRight = (petBounds.x + petBounds.width + BUBBLE_GAP + width) <= (wb - EDGE_MARGIN);
  const fitsLeft = (petBounds.x - BUBBLE_GAP - width) >= (workArea.x + EDGE_MARGIN);
  const fitsBelow = (petBounds.y + petBounds.height + BUBBLE_GAP + height) <= (hb - EDGE_MARGIN);
  const fitsAbove = (petBounds.y - BUBBLE_GAP - height) >= (workArea.y + EDGE_MARGIN);
  // Honor the user's preferred side when it fits; fall back to the
  // opposite if there's no room there. "auto" preserves the original
  // right-first ordering for backward compatibility.
  if (preferred === "left") {
    if (fitsLeft) return "left";
    if (fitsRight) return "right";
  } else if (preferred === "right") {
    if (fitsRight) return "right";
    if (fitsLeft) return "left";
  } else {
    if (fitsRight) return "right";
    if (fitsLeft) return "left";
  }
  if (fitsBelow) return "below";
  if (fitsAbove) return "above";
  return preferred === "left" ? "left" : "right";
}

function computeBubbleBoundsForSide(side, petBounds, workArea, width, height, opts = {}) {
  const cx = petBounds.x + petBounds.width / 2;
  const cy = petBounds.y + petBounds.height / 2;
  const wb = workArea.x + workArea.width;
  const hb = workArea.y + workArea.height;
  // verticalAnchor: "center" (default) — bubble grows from middle; "bottom" —
  // bubble's bottom edge stays put as it grows (used during continuous-chat
  // typing so the textarea position stays stable under the cursor).
  const vAnchor = opts.verticalAnchor || "center";
  const anchorBottomY = opts.anchorBottomY;
  // User-saved offsets (from drag-to-position in Settings). dx is signed
  // "further from pet"; dy is signed "downward from pet vertical center".
  const offsetDx = Number.isFinite(opts.offsetDx) ? opts.offsetDx : 0;
  const offsetDy = Number.isFinite(opts.offsetDy) ? opts.offsetDy : 0;

  let x, y;
  if (side === "left" || side === "right") {
    if (side === "left") x = petBounds.x - BUBBLE_GAP - width - offsetDx;
    else                 x = petBounds.x + petBounds.width + BUBBLE_GAP + offsetDx;
    if (vAnchor === "bottom" && Number.isFinite(anchorBottomY)) {
      y = anchorBottomY - height;
    } else {
      y = cy - height / 2 + offsetDy;
    }
  } else if (side === "above") {
    x = cx - width / 2 + offsetDx;
    y = petBounds.y - BUBBLE_GAP - height - offsetDy;
  } else { // below
    x = cx - width / 2 + offsetDx;
    y = petBounds.y + petBounds.height + BUBBLE_GAP + offsetDy;
  }
  x = Math.round(Math.max(workArea.x + EDGE_MARGIN, Math.min(x, wb - EDGE_MARGIN - width)));
  y = Math.round(Math.max(workArea.y + EDGE_MARGIN, Math.min(y, hb - EDGE_MARGIN - height)));
  return { x, y, width: Math.round(width), height: Math.round(height) };
}

// ── Window manager ──────────────────────────────────────────────────────────

module.exports = function initMinicpmChat(ctx) {
  const appRoot = path.resolve(__dirname, "..");
  const sidecarDir = locateSidecarSourceDir(appRoot);
  const sidecarBin = locateSidecarBinary(appRoot);
  const port = Number(process.env.MINICPM_PORT || DEFAULT_PORT);
  const host = process.env.MINICPM_HOST || DEFAULT_HOST;
  const log = (msg) => { try { console.log(msg); } catch {} };

  // ── i18n bridge ──────────────────────────────────────────────────────
  // ctx.getLang() returns the *effective* UI language. Used to translate
  // sidecar errors (raised with a `minicpmI18nKey` annotation) and to
  // provide the chat renderer with its initial dictionary + classifier
  // few-shots over IPC.
  const minicpmI18n = require("./minicpm-i18n");
  const getLang = () => {
    try {
      if (ctx && typeof ctx.getLang === "function") {
        const v = ctx.getLang();
        if (typeof v === "string" && v) return v;
      }
    } catch {}
    return "en";
  };
  const tr = minicpmI18n.makeTranslator(getLang);
  function localizeError(err) {
    if (!err) return "";
    if (err.minicpmI18nKey) {
      return tr(err.minicpmI18nKey, err.minicpmI18nParams || {});
    }
    return err.message || String(err);
  }

  if (sidecarBin) log(`[minicpm-chat] using packaged sidecar binary: ${sidecarBin}`);

  // Resolve <userData>/logs/ once so every consumer can point at the
  // same directory (sidecar stream + crash dumps + Settings "open log
  // folder" button).
  function getLogsDir() {
    try { return path.join(app.getPath("userData"), "logs"); }
    catch { return path.join(os.tmpdir(), "minicpm-logs"); }
  }
  const logsDir = getLogsDir();
  try { fs.mkdirSync(logsDir, { recursive: true }); } catch {}
  const sidecarLogPath = path.join(logsDir, "sidecar.log");

  // Shared MiniCPM prefs path. This must be initialized before any boot-time
  // model helpers call readMinicpmPrefsRaw().
  const PARAMS_PATH = (() => {
    try { return path.join(app.getPath("userData"), "minicpm-prefs.json"); }
    catch { return path.join(os.tmpdir(), "minicpm-prefs.json"); }
  })();

  const sidecar = new Sidecar({
    sidecarDir, sidecarBin, appRoot, port, host, log,
    logFile: sidecarLogPath,
    modelPresent: (dir) => isModelPresent(dir),
  });

  let bubble = null;
  let activeSide = "right";
  // Tracked "is the bubble currently shown to the user" flag. We can't rely
  // on bubble.isVisible() with macOS panel windows because showInactive() +
  // panel quirks make it return true even after a hide().
  let bubbleShown = false;
  // When set, bubble resizes pin their bottom edge to this Y so the
  // textarea stays put while the bubble grows upward. Cleared on
  // open/transition. Renderer sets this via the "resize" IPC.
  let chatAnchorBottomY = null;

  // ── Chat generation parameters ────────────────────────────────────────
  // Persisted to <userData>/minicpm-prefs.json so they survive restart.
  // Values are validated/clamped on every set; the chat bubble fetches
  // them on each submit, the Settings tab reads/writes via IPC.
  //
  // Several unrelated settings share this file (chat params, `model_dir`,
  // `narration_enabled`, ...). Every writer MUST go through
  // `mergeMinicpmPrefs()` — a naive `JSON.stringify(chatParams)` would erase
  // `model_dir` the next time the user toggled "thinking", etc.
  const DEFAULT_CHAT_PARAMS = {
    max_new_tokens: 768,
    temperature: 0.6,
    top_p: 0.95,
    top_k: 0,                  // 0 = disabled
    repetition_penalty: 1.05,
    thinking: false,           // default off (LoRA usually wasn't trained on <think>)
  };
  const CHAT_PARAM_KEYS = Object.keys(DEFAULT_CHAT_PARAMS);

  function readMinicpmPrefsRaw() {
    try {
      if (!fs.existsSync(PARAMS_PATH)) return {};
      const parsed = JSON.parse(fs.readFileSync(PARAMS_PATH, "utf-8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (err) {
      log(`[minicpm] prefs read failed: ${err && err.message}`);
      return {};
    }
  }

  function writeMinicpmPrefsRaw(raw) {
    try {
      fs.writeFileSync(PARAMS_PATH, JSON.stringify(raw, null, 2), "utf-8");
      return true;
    } catch (err) {
      log(`[minicpm] prefs save failed: ${err && err.message}`);
      return false;
    }
  }

  // Read-modify-write merge so each setting only touches its own keys.
  // Passing `undefined` for a key removes it from the persisted file.
  function mergeMinicpmPrefs(partial) {
    if (!partial || typeof partial !== "object") return false;
    const current = readMinicpmPrefsRaw();
    for (const key of Object.keys(partial)) {
      const next = partial[key];
      if (next === undefined) delete current[key];
      else current[key] = next;
    }
    return writeMinicpmPrefsRaw(current);
  }

  // Bootstrap chatParams restricted to known keys so unrelated sibling
  // fields (model_dir / narration_enabled / ...) can't leak into the in-
  // memory chatParams and accidentally get echoed back on the next save.
  let chatParams = { ...DEFAULT_CHAT_PARAMS };
  {
    const raw = readMinicpmPrefsRaw();
    for (const key of CHAT_PARAM_KEYS) {
      if (Object.prototype.hasOwnProperty.call(raw, key)) chatParams[key] = raw[key];
    }
  }
  function clampChatParams(input) {
    const out = { ...chatParams };
    if (!input || typeof input !== "object") return out;
    if (Number.isFinite(input.max_new_tokens))
      out.max_new_tokens = Math.max(16, Math.min(4096, Math.floor(input.max_new_tokens)));
    if (Number.isFinite(input.temperature))
      out.temperature = Math.max(0, Math.min(2, Number(input.temperature)));
    if (Number.isFinite(input.top_p))
      out.top_p = Math.max(0.05, Math.min(1, Number(input.top_p)));
    if (Number.isFinite(input.top_k))
      out.top_k = Math.max(0, Math.min(200, Math.floor(input.top_k)));
    if (Number.isFinite(input.repetition_penalty))
      out.repetition_penalty = Math.max(1, Math.min(2, Number(input.repetition_penalty)));
    if (typeof input.thinking === "boolean") out.thinking = input.thinking;
    return out;
  }
  // Re-clamp bootstrap so a corrupt persisted value (e.g. max_new_tokens
  // outside range) doesn't ride along into runtime.
  chatParams = clampChatParams(chatParams);
  function setChatParams(input) {
    chatParams = clampChatParams(input);
    mergeMinicpmPrefs(chatParams);
    return chatParams;
  }
  function getChatParams() { return { ...chatParams }; }

  // ── Model path resolution ─────────────────────────────────────────────
  // Production: <userData>/models/<ir-dir>/ (picked during onboarding).
  // Dev: <repo>/models/ (developer convenience).
  // Users can override via Settings → MiniCPM → 本地模型路径 (writes
  // minicpm-prefs.json model_dir field), or MINICPM_MODEL_DIR env at launch.
  //
  // The configured path may be the IR directory itself or a parent holding
  // one, so both forms resolve through firstOpenvinoIrIn.
  const MODELS_SUBDIR = "models";
  function getUserDataDir() {
    try { return app.getPath("userData"); } catch { return os.tmpdir(); }
  }
  function getDefaultModelDir() {
    if (app && app.isPackaged) {
      return path.join(getUserDataDir(), MODELS_SUBDIR);
    }
    return path.resolve(appRoot, "..", MODELS_SUBDIR);
  }
  function getEffectiveModelDir() {
    if (process.env.MINICPM_MODEL_DIR) return process.env.MINICPM_MODEL_DIR;
    const raw = readMinicpmPrefsRaw();
    if (typeof raw.model_dir === "string" && raw.model_dir.trim()) {
      return raw.model_dir.trim();
    }
    return getDefaultModelDir();
  }
  function setEffectiveModelDir(dir) {
    const next = (typeof dir === "string" && dir.trim()) ? dir.trim() : undefined;
    mergeMinicpmPrefs({ model_dir: next });
    return getEffectiveModelDir();
  }

  function isModelPresent(dir) {
    const target = dir || getEffectiveModelDir();
    try {
      if (!fs.statSync(target).isDirectory()) return false;
    } catch { return false; }
    return firstOpenvinoIrIn(target) !== null;
  }

  // Absolute path of the IR currently loaded, for "reveal in folder".
  function resolveCurrentModelPath(healthJson) {
    const candidates = [];
    if (healthJson && healthJson.model_dir) candidates.push(healthJson.model_dir);
    candidates.push(getEffectiveModelDir());
    for (const candidate of candidates) {
      if (!candidate) continue;
      try {
        if (!fs.statSync(candidate).isDirectory()) continue;
      } catch { continue; }
      const ir = firstOpenvinoIrIn(candidate);
      if (ir) return ir;
    }
    return null;
  }

  // ── Process tree RSS (Settings → 资源占用) ───────────────────────────
  async function listAllProcesses() {
    if (isWin) {
      const ps =
        "$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::UTF8; " +
        "Get-CimInstance Win32_Process | " +
        "Select-Object ProcessId,ParentProcessId,WorkingSetSize,Name,CommandLine | " +
        "ConvertTo-Json -Compress";
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-Command", ps],
        { maxBuffer: 12 * 1024 * 1024, windowsHide: true },
      );
      const parsed = JSON.parse(stdout || "[]");
      const arr = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
      return arr.map((p) => ({
        pid: Number(p.ProcessId),
        ppid: Number(p.ParentProcessId),
        rss: Math.round(Number(p.WorkingSetSize || 0) / 1024),
        cpu: 0,
        cmd: String(p.CommandLine || p.Name || ""),
      })).filter((p) => Number.isFinite(p.pid) && p.pid > 0);
    }
    const { stdout } = await execFileAsync(
      "ps",
      ["-axo", "pid=,ppid=,rss=,pcpu=,command="],
      { maxBuffer: 12 * 1024 * 1024 },
    );
    return stdout.trim().split("\n").map((line) => {
      const trimmed = line.trim();
      const m = trimmed.match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/);
      if (!m) return null;
      return {
        pid: Number(m[1]),
        ppid: Number(m[2]),
        rss: Number(m[3]),
        cpu: parseFloat(m[4]) || 0,
        cmd: m[5] || "",
      };
    }).filter(Boolean);
  }
  function collectProcessTree(rootPid, allProcs) {
    const byPpid = new Map();
    for (const proc of allProcs) {
      if (!byPpid.has(proc.ppid)) byPpid.set(proc.ppid, []);
      byPpid.get(proc.ppid).push(proc);
    }
    const tree = [];
    const queue = [rootPid];
    const seen = new Set();
    while (queue.length) {
      const pid = queue.shift();
      if (seen.has(pid)) continue;
      seen.add(pid);
      const proc = allProcs.find((p) => p.pid === pid);
      if (proc) tree.push(proc);
      for (const child of byPpid.get(pid) || []) queue.push(child.pid);
    }
    return tree;
  }

  // ── Bubble position (side preference + drag offset) ───────────────────
  // Persisted alongside chat params in the same JSON file. The Settings
  // panel can switch the user into "edit mode" — the bubble becomes
  // window-draggable and shows sample text — and on save we capture the
  // (dx, dy) offset relative to the default placement for the chosen side.
  //
  // Schema:
  //   side: "left" | "right" | "auto"
  //   dx:   signed pixels, positive = further from the pet
  //   dy:   signed pixels, positive = downward from pet center
  //
  const BUBBLE_POS_PATH = (() => {
    try { return path.join(app.getPath("userData"), "minicpm-bubble-pos.json"); }
    catch { return path.join(os.tmpdir(), "minicpm-bubble-pos.json"); }
  })();
  // Default tuned by hand-positioning next to the actual pet sprite —
  // sits a touch closer to the body and slightly below the head so the
  // tail points at the cat's mouth instead of forehead.
  const DEFAULT_BUBBLE_POS = { side: "left", dx: -45, dy: 45 };
  let bubblePos = { ...DEFAULT_BUBBLE_POS };
  try {
    if (fs.existsSync(BUBBLE_POS_PATH)) {
      const raw = JSON.parse(fs.readFileSync(BUBBLE_POS_PATH, "utf-8"));
      if (raw && typeof raw === "object") bubblePos = { ...DEFAULT_BUBBLE_POS, ...raw };
    }
  } catch (err) { log(`[minicpm] bubble-pos load failed: ${err && err.message}`); }
  function clampBubblePos(input) {
    const out = { ...bubblePos };
    if (!input || typeof input !== "object") return out;
    if (input.side === "left" || input.side === "right" || input.side === "auto") out.side = input.side;
    if (Number.isFinite(input.dx)) out.dx = Math.max(-2000, Math.min(2000, Math.floor(input.dx)));
    if (Number.isFinite(input.dy)) out.dy = Math.max(-2000, Math.min(2000, Math.floor(input.dy)));
    return out;
  }
  function setBubblePos(input) {
    bubblePos = clampBubblePos(input);
    try { fs.writeFileSync(BUBBLE_POS_PATH, JSON.stringify(bubblePos, null, 2), "utf-8"); }
    catch (err) { log(`[minicpm] bubble-pos save failed: ${err && err.message}`); }
    return bubblePos;
  }
  function getBubblePos() { return { ...bubblePos }; }
  // True while the Settings panel has the bubble in "drag-to-position"
  // mode. Position writes (and the auto-hide / dwell logic) are paused
  // while this is true.
  let bubbleEditing = false;

  // ── Narration (model reacts to coding-agent events) ──────────────────────
  // Persisted under `narration_enabled` in minicpm-prefs.json so the user's
  // choice survives restart. Default true keeps the previous dev behaviour
  // when the key is missing (first launch after upgrade, fresh install).
  let narrationEnabled = (() => {
    const raw = readMinicpmPrefsRaw();
    return typeof raw.narration_enabled === "boolean" ? raw.narration_enabled : true;
  })();
  const NARRATE_THROTTLE_MS = 10_000;     // gap between any two narrations
  const SESSION_DEDUP_MS = 5_000;         // ignore repeats for the same session
  const QUEUED_EVENT_MAX_AGE_MS = 60_000; // drop stale queued events after chat ends
  // Events worth narrating. Anything else is dropped.
  const NARRATE_EVENTS = new Set(["Stop", "StopFailure", "Notification"]);
  // Skip when the event came from us (the chat sidecar pushes states too).
  const NARRATE_IGNORE_SESSION_PREFIX = "minicpm-";

  let lastNarrateAt = 0;
  let lastSessionAt = new Map(); // session_id -> timestamp
  // FIFO queue of events to narrate sequentially. Multiple windows
  // (different sessions) finishing close together each get their turn
  // instead of being deduplicated away. Max length keeps us from
  // chaining narrations forever if user steps away.
  const QUEUE_MAX = 5;
  let queuedEvents = [];        // [{ data, queuedAt }, ...]
  let narrating = false;

  function getPetBoundsSafe() {
    // Prefer the hit-rect (visible sprite) over the pet window — the
    // window has large transparent margins, anchoring to it makes the
    // bubble float far from the actual character.
    try {
      const hit = ctx.getPetHitRect && ctx.getPetHitRect();
      if (hit && Number.isFinite(hit.width) && hit.width > 0) {
        return { x: Math.round(hit.x), y: Math.round(hit.y), width: Math.round(hit.width), height: Math.round(hit.height) };
      }
    } catch {}
    try { return ctx.getPetWindowBounds && ctx.getPetWindowBounds(); } catch { return null; }
  }

  function getWorkAreaForPet(pb) {
    if (typeof ctx.getNearestWorkArea === "function" && pb) {
      try { return ctx.getNearestWorkArea(pb.x + pb.width / 2, pb.y + pb.height / 2); } catch {}
    }
    return screen.getPrimaryDisplay().workArea;
  }

  function chooseAndApplyBounds(width, height, { keepSide = false } = {}) {
    if (!bubble || bubble.isDestroyed()) return;
    const pb = getPetBoundsSafe();
    const wa = pb ? getWorkAreaForPet(pb) : screen.getPrimaryDisplay().workArea;
    if (pb) {
      // When the pet has moved (drag end / repos call) we re-pick the
      // best side so the bubble doesn't end up clamped over the pet's
      // sprite. `keepSide` is used during the same logical "show" so
      // size changes (e.g. ask → speak) don't flip sides mid-conversation.
      if (!keepSide || !activeSide) activeSide = pickSide(pb, wa, width, height, bubblePos.side);
      const opts = chatAnchorBottomY !== null
        ? { verticalAnchor: "bottom", anchorBottomY: chatAnchorBottomY }
        : {};
      opts.offsetDx = bubblePos.dx;
      opts.offsetDy = bubblePos.dy;
      const bounds = computeBubbleBoundsForSide(activeSide, pb, wa, width, height, opts);
      bubble.setBounds(bounds);
    } else {
      bubble.setBounds({
        x: Math.round((wa.width - width) / 2),
        y: Math.round((wa.height - height) / 2),
        width, height,
      });
    }
  }

  function reposition() {
    if (!bubble || bubble.isDestroyed() || !bubble.isVisible()) return;
    const { width, height } = bubble.getBounds();
    // During pet drag we keep recomputing on every move tick; let the
    // bubble re-pick side as the pet crosses regions so it never overlaps.
    chooseAndApplyBounds(width, height, { keepSide: false });
  }

  // Pet-drag awareness: hide the bubble while user is dragging the pet
  // (continuous reposition during drag is jittery and visually noisy);
  // restore it cleanly after the drop with a fresh side pick.
  let petDragging = false;
  let bubbleHiddenForDrag = false;
  function setPetDragging(v) {
    const wasDragging = petDragging;
    petDragging = !!v;
    if (!bubble || bubble.isDestroyed()) return;
    if (petDragging && !wasDragging && bubble.isVisible()) {
      // Drag started → fade away, remember to restore on drop.
      bubbleHiddenForDrag = true;
      try { bubble.hide(); } catch {}
    } else if (!petDragging && wasDragging && bubbleHiddenForDrag) {
      // Drag ended → re-show on the now-best side.
      bubbleHiddenForDrag = false;
      const { width, height } = bubble.getBounds();
      chooseAndApplyBounds(width, height, { keepSide: false });
      try { bubble.showInactive(); } catch {}
    }
  }

  function createBubble() {
    const pb = getPetBoundsSafe() || { x: 200, y: 200, width: 280, height: 280 };
    const wa = getWorkAreaForPet(pb);
    activeSide = pickSide(pb, wa, ASK_WIDTH, ASK_HEIGHT, bubblePos.side);
    const initial = computeBubbleBoundsForSide(activeSide, pb, wa, ASK_WIDTH, ASK_HEIGHT, {
      offsetDx: bubblePos.dx, offsetDy: bubblePos.dy,
    });

    bubble = new BrowserWindow({
      ...initial,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: true,
      ...(isLinux ? { type: LINUX_WINDOW_TYPE } : {}),
      ...(isMac ? { type: "panel" } : {}),
      webPreferences: {
        preload: path.join(__dirname, "preload-minicpm-chat.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    if (isWin) bubble.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
    if (isMac) {
      try { bubble.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch {}
    }
    bubble.setMenuBarVisibility(false);
    // Bypass any cached HTML so code changes always take effect.
    bubble.webContents.session.clearCache();
    bubble.loadFile(path.join(__dirname, "minicpm-chat.html"));

    bubble.webContents.on("before-input-event", (event, input) => {
      if (input.type === "keyDown" && input.key === "Escape") {
        // Renderer treats Esc itself; this is just a safety net.
        try { bubble.hide(); } catch {}
        event.preventDefault();
      }
    });
    bubble.on("closed", () => { bubble = null; });

    return bubble;
  }

  function ensureBubble() {
    if (!bubble || bubble.isDestroyed()) createBubble();
    return bubble;
  }

  async function open() {
    ensureBubble();
    // Re-pick the side based on the current pet position each time we open.
    const pb = getPetBoundsSafe();
    const wa = pb ? getWorkAreaForPet(pb) : screen.getPrimaryDisplay().workArea;
    activeSide = pb ? pickSide(pb, wa, ASK_WIDTH, ASK_HEIGHT, bubblePos.side) : (bubblePos.side === "left" ? "left" : "right");
    if (pb) {
      bubble.setBounds(computeBubbleBoundsForSide(activeSide, pb, wa, ASK_WIDTH, ASK_HEIGHT, {
        offsetDx: bubblePos.dx, offsetDy: bubblePos.dy,
      }));
    }
    if (!bubble.isVisible()) bubble.show();
    bubble.focus();
    bubbleShown = true;
    bubble.webContents.send("minicpm:cmd-open", { side: activeSide });
    // Fire a 1-token warmup so the model weights are paged back into RAM
    // by the time the user finishes typing. Throttled — repeated opens
    // within 30s don't re-warm (model is still hot).
    void maybeWarmup();
  }

  // ── Warmup ping ────────────────────────────────────────────────────────
  // macOS pages out the model's memory after the sidecar has been idle
  // for a few minutes; the first request then takes 1-3s instead of
  // 0.1s. We fire `/api/warmup` on every bubble open. The endpoint runs
  // a 1-token greedy forward (~50-200ms hot, ~1-2s cold) which faults
  // the weights back in so the user's actual chat call is fast.
  let lastWarmupAt = 0;
  const WARMUP_GAP_MS = 30_000;  // 30s — covers fast re-opens / multi-turn chat
  async function maybeWarmup() {
    const now = Date.now();
    if (now - lastWarmupAt < WARMUP_GAP_MS) return;
    lastWarmupAt = now;
    try {
      // 5s timeout — plenty for cold start, won't pile up if sidecar is slow.
      await httpJson("POST", `${sidecar.baseUrl()}/api/warmup`, {}, 5000);
    } catch (err) {
      log(`[minicpm] warmup ping failed: ${err && err.message || err}`);
    }
  }

  function toggle() {
    if (bubble && !bubble.isDestroyed() && bubble.isVisible()) {
      bubble.webContents.send("minicpm:cmd-dismiss");
      return;
    }
    open();
  }

  function dismiss() {
    if (bubble && !bubble.isDestroyed()) bubble.webContents.send("minicpm:cmd-dismiss");
  }

  function toggleThinking() {
    // The renderer owns the flag; we just nudge it to flip and toast.
    // If the bubble doesn't exist yet, ensure it does so the listener attaches.
    ensureBubble();
    bubble.webContents.send("minicpm:cmd-toggle-thinking");
  }

  function shutdown() {
    sidecar.stop();
    if (bubble && !bubble.isDestroyed()) bubble.destroy();
    bubble = null;
  }

  // ── Narration logic ─────────────────────────────────────────────────────
  // Score how "rich" an event is for narration. Higher is better.
  // We use this to pick the best of multiple events that fire for the
  // same logical conversation (Cursor + Claude Code hooks both fire on
  // Cursor's stop, but only the cursor-agent variant has session_title
  // and last_summary populated by the hook's transcript parser).
  function eventRichness(data) {
    let s = 0;
    if (typeof data.session_title === "string" && data.session_title.trim()) s += 10;
    if (typeof data.last_summary === "string" && data.last_summary.trim()) s += 10;
    if (typeof data.assistant_last_output === "string" && data.assistant_last_output.trim()) s += 10;
    if (data.agent_id === "cursor-agent") s += 1;  // tie-breaker
    return s;
  }

  // Per-session merge buffer: when an event arrives, hold it for
  // EVENT_MERGE_MS waiting for a sibling event for the same session
  // (e.g., Cursor's claude-code companion). Whichever has the richer
  // context wins. Without this, the claude-code event arrives ~ms
  // earlier and gets dispatched with empty title/summary, giving us
  // generic "主人刚写完一轮代码" prompts.
  const EVENT_MERGE_MS = 700;
  const eventBuffers = new Map();  // sessionId → { data, score, timer }

  function onStateEvent(data) {
    if (!narrationEnabled) return;
    if (bubbleEditing) return;  // Don't intrude while the user is positioning the bubble.
    if (!data || typeof data !== "object") return;
    const event = String(data.event || "");
    const sessionId = String(data.session_id || "");
    if (!NARRATE_EVENTS.has(event)) return;
    if (sessionId.startsWith(NARRATE_IGNORE_SESSION_PREFIX)) return;

    const now = Date.now();
    // Per-session "already dispatched" gate (5s after final commit).
    const last = lastSessionAt.get(sessionId);
    if (last && (now - last) < SESSION_DEDUP_MS) {
      log(`[narrator] drop: session ${sessionId.slice(0,8)} dedup ${now - last}ms`);
      return;
    }

    const score = eventRichness(data);
    const buf = eventBuffers.get(sessionId);
    if (buf) {
      // Already buffered — keep whichever has more context.
      if (score > buf.score) {
        log(`[narrator] merge: session ${sessionId.slice(0,8)} replace agent=${buf.data.agent_id}→${data.agent_id} (score ${buf.score}→${score})`);
        buf.data = data;
        buf.score = score;
      } else {
        log(`[narrator] merge: session ${sessionId.slice(0,8)} keep agent=${buf.data.agent_id} (score ${buf.score} ≥ ${score})`);
      }
      return;
    }

    // First event for this session — start the merge window.
    log(`[narrator] buffer: event=${event} session=${sessionId.slice(0,8)} agent=${data.agent_id} score=${score} (waiting ${EVENT_MERGE_MS}ms for siblings)`);
    eventBuffers.set(sessionId, {
      data,
      score,
      timer: setTimeout(() => commitBufferedEvent(sessionId), EVENT_MERGE_MS),
    });
  }

  function commitBufferedEvent(sessionId) {
    const buf = eventBuffers.get(sessionId);
    if (!buf) return;
    eventBuffers.delete(sessionId);
    const data = buf.data;
    const event = String(data.event || "");
    const now = Date.now();
    lastSessionAt.set(sessionId, now);

    if (bubbleShown) {
      enqueueEvent(data, now, "bubble-visible");
      return;
    }
    if ((now - lastNarrateAt) < NARRATE_THROTTLE_MS) {
      enqueueEvent(data, now, "throttled");
      return;
    }
    if (narrating) {
      enqueueEvent(data, now, "narrating");
      return;
    }
    log(`[narrator] accept event=${event} session=${sessionId.slice(0,8)} agent=${data.agent_id} score=${buf.score}`);
    void dispatchNarration(data);
  }

  function enqueueEvent(data, now, reason) {
    // De-dupe against anything already in the queue with the same session.
    queuedEvents = queuedEvents.filter(q => String(q.data.session_id || "") !== String(data.session_id || ""));
    queuedEvents.push({ data, queuedAt: now });
    while (queuedEvents.length > QUEUE_MAX) queuedEvents.shift();  // drop oldest
    log(`[narrator] enqueue (${reason}): event=${data.event} session=${String(data.session_id||"").slice(0,8)} queue=${queuedEvents.length}/${QUEUE_MAX}`);
  }

  function buildNarrationPrompt(data) {
    const cwdName = (() => {
      const c = String(data.cwd || "");
      const parts = c.split("/").filter(Boolean);
      return parts.length ? parts[parts.length - 1] : "";
    })();
    const niceCwd = cwdName && !cwdName.startsWith("tmp.") ? cwdName : "";
    const isCursor = data.agent_id === "cursor-agent";
    // Two pieces of context populated by the hook script:
    //   title       : conversation topic (first user message)
    //   summary     : what AI did/said in the last reply (truncated)
    const title = typeof data.session_title === "string" && data.session_title.trim()
      ? data.session_title.trim()
      : "";
    const rawSummary = typeof data.last_summary === "string" && data.last_summary.trim()
      ? data.last_summary.trim()
      : (typeof data.assistant_last_output === "string" && data.assistant_last_output.trim()
          ? data.assistant_last_output.trim()
          : "");
    // Cap the summary so system prompt + user prompt + generation stay
    // within the model's 4096-token context window.  System prompt ≈ 700
    // tokens, event template ≈ 75, max_new_tokens = 50 → budget for
    // summary text ≈ 3200 tokens.  At ~1.5 tokens/CJK char (worst case)
    // that's ~2100 chars; use 800 to leave a comfortable margin.
    const SUMMARY_CHAR_LIMIT = 800;
    const summary = rawSummary.length > SUMMARY_CHAR_LIMIT
      ? rawSummary.slice(0, SUMMARY_CHAR_LIMIT) + "…"
      : rawSummary;

    // Build the event description in the user's UI language. The
    // narration system prompt + situation templates live in
    // `minicpm-i18n.js` so non-Chinese users get prompts the model can
    // actually narrate in.
    const lang = getLang();
    const narration = minicpmI18n.getNarration(lang);
    const subject = title
      ? minicpmI18n.makeTranslator(() => lang, minicpmI18n.NARRATION)("subjectQuoted", { title })
      : (niceCwd
          ? minicpmI18n.makeTranslator(() => lang, minicpmI18n.NARRATION)("subjectFromCwd", { cwd: niceCwd })
          : "");
    const tnar = minicpmI18n.makeTranslator(() => lang, minicpmI18n.NARRATION);
    let situation;
    if (data.event === "StopFailure") {
      situation = subject
        ? tnar("eventStopFailureWithSubject", { subject })
        : tnar("eventStopFailureNoSubject");
    } else if (data.event === "Notification") {
      situation = subject
        ? tnar("eventNotificationWithSubject", { subject })
        : tnar("eventNotificationNoSubject");
    } else {
      situation = subject
        ? tnar("eventStopWithSubject", { subject })
        : tnar("eventStopNoSubject");
    }
    if (summary) {
      situation += tnar("eventLastSaid", { summary });
    }

    return {
      system: narration.systemPrompt,
      user: `事件:${situation}\n回复:`,
    };
  }

  async function dispatchNarration(data) {
    narrating = true;
    lastNarrateAt = Date.now();
    try {
      const prompt = buildNarrationPrompt(data);
      log(`[narrator] dispatch event=${data.event} agent=${data.agent_id} prompt=${JSON.stringify(prompt.user)}`);
      const body = JSON.stringify({
        messages: [{ role: "user", content: prompt.user }],
        system: prompt.system,
        stream: false,
        max_new_tokens: 50,
        thinking: false,
        temperature: 0.7,
        top_p: 0.9,
        repetition_penalty: 1.15,
        silent: true,            // don't push pet animation states for narrator
      });
      const r = await httpJson("POST", `${sidecar.baseUrl()}/api/chat`, JSON.parse(body), 30000);
      let text = (r.json && (r.json.content || "")).trim();
      // Strip "回复：" prefix the few-shot format may leak.
      text = text.replace(/^(回复[:：]\s*)/, "");
      // First line only — multi-line responses become "thoughts" we don't
      // want to drop into a small bubble.
      text = text.split(/\r?\n/)[0].trim();
      // Strip surrounding quote characters (some models love quoting the reply).
      text = text.replace(/^[「『"']+|[」』"']+$/g, "").trim();
      // Cap to first sentence + ≤50 chars total. Rich enough to convey a
      // concrete result, short enough to fit the bubble at one glance.
      const firstStop = text.search(/[。！？!?]/);
      if (firstStop > 0 && firstStop < text.length - 1) text = text.slice(0, firstStop + 1);
      if (text.length > 50) text = text.slice(0, 49) + "…";
      if (!text) {
        log("[narrator] empty reply, skipping");
        return;
      }
      log(`[narrator] reply: ${text}`);
      ensureBubble();
      reposition();
      bubble.webContents.send("minicpm:narrate", { text, kind: data.event, agent: data.agent_id });
      bubble.showInactive();
      bubbleShown = true;
      // Drive the dwell + hide from the main process so it doesn't rely on
      // the renderer's setTimeout (Chromium can throttle timers in hidden
      // panel windows on macOS, which leaves the bubble pinned).
      const dwellMs = Math.max(4000, Math.min(9000, 2400 + text.length * 130));
      setTimeout(() => {
        if (!bubble || bubble.isDestroyed()) return;
        try { bubble.hide(); } catch {}
        bubbleShown = false;
        log(`[narrator] hidden after dwell=${dwellMs}ms`);
        // Replay any queued event that arrived while we were narrating.
        flushQueuedEventIfStale();
      }, dwellMs + 220);
    } catch (err) {
      log(`[narrator] failed: ${err && err.message || err}`);
    } finally {
      narrating = false;
      // Fire next queued event after a short breather (still respects
      // throttle/bubble-visible checks via onStateEvent → eventBuffers).
      // Drop stale entries while we're at it.
      pruneStaleQueue();
      const q = queuedEvents.shift();
      if (q) {
        setTimeout(() => onStateEvent(q.data), 1500);
      }
    }
  }

  function setNarrationEnabled(value) {
    const next = !!value;
    if (narrationEnabled !== next) {
      narrationEnabled = next;
      mergeMinicpmPrefs({ narration_enabled: narrationEnabled });
    }
    return narrationEnabled;
  }
  function isNarrationEnabled() { return narrationEnabled; }

  function pruneStaleQueue() {
    const now = Date.now();
    queuedEvents = queuedEvents.filter(q => (now - q.queuedAt) < QUEUED_EVENT_MAX_AGE_MS);
  }

  // When the user closes the chat bubble, drain the queue (oldest first,
  // staggered) so the conversations they missed each get a turn.
  function flushQueuedEventIfStale() {
    pruneStaleQueue();
    const q = queuedEvents.shift();
    if (!q) return;
    onStateEvent(q.data);
  }

  // Eagerly start the Python sidecar in the background so the model and
  // MPS kernels are ready by the time the user clicks the pet. Also probes
  // for a newer model revision once the sidecar is healthy.
  async function warmup() {
    try {
      log("[minicpm-chat] warming up sidecar in background…");
      // Pass the user-effective model dir so the sidecar's `--model` flag
      // tracks Settings changes / Onboarding downloads without restart.
      const r = await sidecar.ensureRunning(getEffectiveModelDir());
      log(`[minicpm-chat] sidecar warmup ${r.status}`);
    } catch (err) {
      log(`[minicpm-chat] sidecar warmup failed: ${err && err.message || err}`);
    }
  }

  // ── Context menu (right-click on bubble) ───────────────────────────────

  async function openContextMenu() {
    const m = await sidecar.listModels();
    const items = [];
    if (m && Array.isArray(m.items) && m.items.length) {
      for (const item of m.items) {
        items.push({
          label: item.name,
          type: "checkbox",
          checked: item.path === m.current,
          click: async () => {
            if (item.path === m.current) return;
            bubble.webContents.send("minicpm:cmd-dismiss");
            await sidecar.loadModel(item.path);
            // Re-open in ask mode after model swap so the user can ask the
            // newly loaded model right away.
            await open();
          },
        });
      }
    } else {
      items.push({ label: "(未发现模型)", enabled: false });
    }
    items.push({ type: "separator" });

    items.push({ type: "separator" });
    items.push({
      label: `桌宠旁白 (Stop / 错误时吐槽)`,
      type: "checkbox",
      checked: narrationEnabled,
      click: (it) => { setNarrationEnabled(!!it.checked); },
    });
    items.push({ type: "separator" });
    items.push({
      label: "清空对话历史",
      click: () => { if (bubble && !bubble.isDestroyed()) bubble.webContents.send("minicpm:cmd-reset"); },
    });
    items.push({
      label: "关闭气泡",
      click: () => dismiss(),
    });

    const menu = Menu.buildFromTemplate(items);
    if (bubble && !bubble.isDestroyed()) menu.popup({ window: bubble });
  }

  // ── IPC ───────────────────────────────────────────────────────────────

  const handlers = {
    "minicpm:status": async () => ({
      url: sidecar.baseUrl(),
      healthy: await sidecar.isHealthy(getEffectiveModelDir()),
    }),
    "minicpm:start": async (_evt, opts = {}) => {
      try {
        // Default to the user-effective dir; opts.modelDir still wins
        // when callers want a one-off override.
        const r = await sidecar.ensureRunning(opts.modelDir || getEffectiveModelDir());
        return { ok: true, status: r.status, url: sidecar.baseUrl() };
      } catch (err) {
        return { ok: false, error: localizeError(err) };
      }
    },
    "minicpm:get-i18n": async () => {
      const lang = getLang();
      return minicpmI18n.getMinicpmI18nPayload(lang);
    },
    "minicpm:resize": (_evt, { width, height } = {}) => {
      width = Math.max(MIN_WIDTH, Math.min(SPEAK_MAX_WIDTH, Math.round(Number(width) || ASK_WIDTH)));
      height = Math.max(MIN_HEIGHT, Math.min(SPEAK_MAX_HEIGHT, Math.round(Number(height) || ASK_HEIGHT)));
      chooseAndApplyBounds(width, height);
      return { ok: true, width, height };
    },
    "minicpm:set-chat-anchor": (_evt, { bottomY } = {}) => {
      // Renderer enters/exits "anchor-bottom while typing" mode. Pass null
      // to clear and go back to default center anchor.
      chatAnchorBottomY = (typeof bottomY === "number" && Number.isFinite(bottomY)) ? bottomY : null;
      return { ok: true };
    },
    "minicpm:hide-window": () => {
      if (bubble && !bubble.isDestroyed() && bubble.isVisible()) bubble.hide();
      bubbleShown = false;
      // Bubble closed → if a coding-agent event was queued during chat,
      // replay it now (subject to the 60s freshness window).
      setTimeout(() => flushQueuedEventIfStale(), 600);
      return { ok: true };
    },
    "minicpm:focus-window": () => {
      // Bring bubble to the front AND give it keyboard focus. Used when
      // we transition back to ask mode after a reply so the user can
      // type immediately without re-clicking the pet.
      if (bubble && !bubble.isDestroyed()) {
        try {
          if (!bubble.isVisible()) bubble.show();
          else bubble.show(); // also raises macOS panel to key window
          bubble.focus();
          bubbleShown = true;
        } catch (err) { log(`[minicpm-chat] focus failed: ${err.message}`); }
      }
      return { ok: true };
    },
    "minicpm:show-window": () => {
      bubbleShown = true;
      if (bubble && !bubble.isDestroyed() && !bubble.isVisible()) {
        // Re-pick the side based on current pet position before showing,
        // so the bubble pops back next to the pet even if it moved while
        // the bubble was hidden. Must go through chooseAndApplyBounds —
        // this runs after the resize that already positioned the bubble.
        const { width, height } = bubble.getBounds();
        chooseAndApplyBounds(width, height);
        bubble.showInactive();
      }
      return { ok: true };
    },
  };
  for (const [ch, fn] of Object.entries(handlers)) {
    try { ipcMain.removeHandler(ch); } catch {}
    ipcMain.handle(ch, fn);
  }

  ipcMain.removeAllListeners("minicpm:open-context-menu");
  ipcMain.on("minicpm:open-context-menu", () => { void openContextMenu(); });

  try { ipcMain.removeHandler("minicpm:get-chat-params"); } catch {}
  ipcMain.handle("minicpm:get-chat-params", async () => getChatParams());

  // ── Settings-window facing IPC ────────────────────────────────────────
  // Surface the MiniCPM panel state to the main Settings window.
  const settingsHandlers = {
    "minicpm-settings:get-status": async () => {
      // 5s, not less: a model swap recompiles the pipeline and would
      // otherwise make a live sidecar look offline.
      const health = await httpJson("GET", `${sidecar.baseUrl()}/api/health`, null, 5000).catch(() => null);
      const engineReady = !!(health && health.json && (
        health.json.alive === true ||
        (health.json.engine && health.json.engine.status === "ok")
      ));
      const requireEngine = isModelPresent();
      const sidecarReady = !!(health && health.json && health.json.ok);
      return {
        sidecarUrl: sidecar.baseUrl(),
        healthy: !!(sidecarReady && (!requireEngine || engineReady)),
        sidecarReady,
        engineReady,
        health: health ? health.json : null,
        narration: narrationEnabled,
      };
    },
    "minicpm-settings:set-narration": async (_evt, payload) => {
      setNarrationEnabled(!!(payload && payload.enabled));
      return { ok: true, enabled: narrationEnabled };
    },

    // ── Accelerator / device manual override ────────────────────────────
    "minicpm-settings:list-devices": async () => {
      const r = await httpJson("GET", `${sidecar.baseUrl()}/api/devices`, null, 2000).catch(() => null);
      return r ? r.json : null;
    },
    "minicpm-settings:set-device": async (_evt, payload) => {
      const device = (payload && payload.device) || "";
      if (device === "vulkan" && process.platform !== "win32") {
        return { ok: false, device, error: "Vulkan backend is only configurable on Windows" };
      }
      // Persist for the next sidecar spawn even if /api/set-device is
      // unreachable (sidecar may have crashed). MINICPM_DEVICE is the
      // single source of truth our server.py reads at start.
      process.env.MINICPM_DEVICE = device;
      try {
        await httpJson("POST", `${sidecar.baseUrl()}/api/set-device`, { device }, 1500);
      } catch {}
      return { ok: true, device, note: "下次 sidecar 重启时生效" };
    },
    "minicpm-settings:set-device-and-restart": async (_evt, payload) => {
      const device = (payload && payload.device) || "";
      if (device === "vulkan" && process.platform !== "win32") {
        return { ok: false, device, error: "Vulkan backend is only configurable on Windows" };
      }
      const previousDevice = process.env.MINICPM_DEVICE || "";
      process.env.MINICPM_DEVICE = device;
      try {
        await sidecar.stopAndWait();
      } catch (stopErr) {
        process.env.MINICPM_DEVICE = previousDevice;
        return { ok: false, device, phase: "stop", error: localizeError(stopErr) };
      }
      try {
        const r = await sidecar.ensureRunning(getEffectiveModelDir());
        return { ok: true, device, status: r && r.status };
      } catch (err) {
        if (process.platform === "win32" && device === "vulkan") {
          const originalError = localizeError(err);
          process.env.MINICPM_DEVICE = "cpu";
          try {
            await sidecar.stopAndWait();
          } catch (fallbackStopErr) {
            return {
              ok: false,
              device,
              phase: "fallback-stop",
              error: `${originalError}; CPU fallback cleanup failed: ${localizeError(fallbackStopErr)}`,
            };
          }
          try {
            const r = await sidecar.ensureRunning(getEffectiveModelDir());
            log(`[minicpm-chat] Vulkan backend failed; fell back to CPU: ${originalError}`);
            return { ok: false, fallback: "cpu", device: "cpu", status: r && r.status, error: originalError };
          } catch (fallbackErr) {
            return { ok: false, fallback: "cpu", device: "cpu", error: localizeError(fallbackErr) };
          }
        }
        return { ok: false, device, error: localizeError(err) };
      }
    },
    "minicpm-settings:restart-sidecar": async () => {
      try {
        await sidecar.stopAndWait();
        const r = await sidecar.ensureRunning(getEffectiveModelDir());
        return { ok: true, status: r && r.status };
      } catch (err) {
        return { ok: false, error: String(err && err.message || err) };
      }
    },

    // ── Local model directory override ──────────────────────────────────
    "minicpm-settings:get-model-dir": async () => ({
      current: getEffectiveModelDir(),
      default: getDefaultModelDir(),
      present: isModelPresent(),
    }),
    "minicpm-settings:pick-model-dir": async () => {
      const { dialog } = require("electron");
      const ret = await dialog.showOpenDialog({
        title: "选择 OpenVINO 模型目录 (含 openvino_model.xml)",
        properties: ["openDirectory"],
        message: "OpenVINO 模型是一个目录，请选中它本身或它的上一层",
      });
      if (ret.canceled || !ret.filePaths.length) return { ok: false, canceled: true };
      const picked = ret.filePaths[0];

      // Accept the IR directory itself, or a parent holding exactly one.
      const irs = openvinoIrsIn(picked);
      if (irs.length > 1) {
        return {
          ok: false,
          error: `该目录有 ${irs.length} 个 OpenVINO 模型，请直接选中要加载的那一个：\n${irs.map((d) => path.basename(d)).join("\n")}`,
        };
      }
      const target = irs[0];
      if (!target) {
        return {
          ok: false,
          error: `所选目录不是 OpenVINO 模型（缺 openvino_model.xml）：\n${picked}`,
        };
      }

      setEffectiveModelDir(target);
      // Prefs only take effect on the next spawn, so hot-swap too.
      let reloadError = null;
      try {
        const r = await sidecar.loadModel(target);
        if (r && r.error) reloadError = String(r.error);
      } catch (err) {
        reloadError = String(err && err.message || err);
      }
      return { ok: true, modelDir: target, reloaded: !reloadError, reloadError };
    },
    "minicpm-settings:open-model-dir": async () => {
      const health = await httpJson("GET", `${sidecar.baseUrl()}/api/health`, null, 1500).catch(() => null);
      const ir = resolveCurrentModelPath(health ? health.json : null);
      if (ir) {
        try {
          shell.showItemInFolder(ir);
          return { ok: true, path: ir, highlighted: true };
        } catch (err) {
          return { ok: false, error: String(err && err.message || err) };
        }
      }
      const dir = getEffectiveModelDir();
      try {
        fs.mkdirSync(dir, { recursive: true });
        const err = await shell.openPath(dir);
        if (err) return { ok: false, error: err };
        return { ok: true, dir, highlighted: false };
      } catch (err) {
        return { ok: false, error: String(err && err.message || err) };
      }
    },

    "minicpm-settings:get-resources": async () => {
      const root = sidecar.proc && sidecar.proc.pid;
      if (!root) return { ok: false, reason: "no-sidecar" };
      try {
        const all = await listAllProcesses();
        const tree = collectProcessTree(root, all);
        const total_rss_kb = tree.reduce((sum, p) => sum + (p.rss || 0), 0);
        const total_cpu = tree.reduce((sum, p) => sum + (p.cpu || 0), 0);
        const health = await httpJson("GET", `${sidecar.baseUrl()}/api/health`, null, 1500).catch(() => null);
        const h = health && health.json ? health.json : {};
        const model_path = resolveCurrentModelPath(h);
        // An IR is a directory, so its footprint is the sum of its files.
        let model_size = null;
        if (model_path) {
          try {
            model_size = fs.readdirSync(model_path, { withFileTypes: true })
              .filter((e) => e.isFile())
              .reduce((sum, e) => {
                try { return sum + fs.statSync(path.join(model_path, e.name)).size; }
                catch { return sum; }
              }, 0);
          } catch {}
        }
        const ctx_size = Number(process.env.MINICPM_CTX) || 4096;
        // The engine mmaps the IR, so that share of RSS isn't private.
        const mmap_kb = model_size ? Math.round(model_size / 1024) : null;
        const private_kb = mmap_kb != null
          ? Math.max(0, total_rss_kb - mmap_kb)
          : total_rss_kb;
        return {
          ok: true,
          total_rss_kb,
          total_cpu,
          private_kb,
          mmap_kb,
          model_size,
          model_path,
          ctx_size,
          accel: h.accel || h.device || null,
          backend: h.backend || null,
          engine_alive: !!(h.alive || (h.engine && h.engine.status === "ok")),
          processes: tree.map((p) => ({
            pid: p.pid,
            rss: p.rss,
            cpu: p.cpu,
            cmd: p.cmd.slice(0, 160),
          })),
        };
      } catch (err) {
        return { ok: false, error: String(err && err.message || err) };
      }
    },
    "minicpm-settings:reset-model-dir": async () => {
      setEffectiveModelDir(null);
      return { ok: true, modelDir: getDefaultModelDir() };
    },

    // ── Onboarding rerun (dev / recovery) ───────────────────────────────
    "minicpm-settings:rerun-onboarding": async () => {
      // Delete the sentinel and tell main.js to relaunch. main.js will
      // see shouldShow()===true on next boot and open the wizard.
      try {
        const sentinelPath = path.join(app.getPath("userData"), "minicpm-onboarding.json");
        if (fs.existsSync(sentinelPath)) fs.unlinkSync(sentinelPath);
      } catch (err) {
        return { ok: false, error: String(err && err.message || err) };
      }
      // Don't call app.relaunch() here directly — the renderer expects an
      // explicit "yes I want to restart" confirmation. The handler just
      // marks the file; the Settings UI shows a "重启应用" button afterwards.
      return { ok: true };
    },
    "minicpm-settings:relaunch-app": async () => {
      // Hard-restart so the new sentinel state takes effect cleanly.
      setTimeout(() => {
        app.relaunch();
        app.quit();
      }, 100);
      return { ok: true };
    },

    // ── Logs (sidecar.log + crash dumps) ────────────────────────────────
    "minicpm-settings:get-logs-info": async () => {
      const entries = [];
      try {
        for (const name of fs.readdirSync(logsDir)) {
          try {
            const st = fs.statSync(path.join(logsDir, name));
            entries.push({
              name,
              size: st.size,
              mtime: st.mtime.toISOString(),
            });
          } catch {}
        }
      } catch {}
      entries.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
      return {
        dir: logsDir,
        sidecarLog: sidecarLogPath,
        entries,
      };
    },
    "minicpm-settings:open-logs-dir": async () => {
      const { shell } = require("electron");
      try { fs.mkdirSync(logsDir, { recursive: true }); } catch {}
      try {
        const err = await shell.openPath(logsDir);
        if (err) return { ok: false, error: err };
        return { ok: true, dir: logsDir };
      } catch (err) {
        return { ok: false, error: String(err && err.message || err) };
      }
    },

    "minicpm-settings:get-chat-params": async () => ({
      params: getChatParams(),
      defaults: { ...DEFAULT_CHAT_PARAMS },
    }),
    "minicpm-settings:set-chat-params": async (_evt, payload) => ({
      ok: true,
      params: setChatParams(payload && payload.params),
    }),
    "minicpm-settings:reset-chat-params": async () => ({
      ok: true,
      params: setChatParams(DEFAULT_CHAT_PARAMS),
    }),

    "minicpm-settings:get-bubble-pos": async () => ({
      pos: getBubblePos(),
      defaults: { ...DEFAULT_BUBBLE_POS },
      editing: bubbleEditing,
    }),
    "minicpm-settings:set-bubble-pos": async (_evt, payload) => {
      const next = setBubblePos(payload && payload.pos);
      // Reposition immediately if the bubble is currently open so the
      // change is visible without forcing the user to reopen it.
      try { reposition(); } catch {}
      return { ok: true, pos: next };
    },
    "minicpm-settings:reset-bubble-pos": async () => {
      const next = setBubblePos(DEFAULT_BUBBLE_POS);
      try { reposition(); } catch {}
      return { ok: true, pos: next };
    },
    // Drag-to-position flow:
    //   1. Settings calls "enter-bubble-edit". We open the bubble next
    //      to the pet, swap it into a draggable sample, and pause any
    //      narration / auto-hide while the user fiddles with it.
    //   2. User drags the OS window around (the renderer applies
    //      -webkit-app-region: drag to the whole body in edit mode).
    //   3. Settings calls "exit-bubble-edit" with `save: true` to
    //      capture the final offset, or `save: false` to discard.
    "minicpm-settings:enter-bubble-edit": async () => {
      try {
        ensureBubble();
        bubbleEditing = true;
        // Apply the saved side preference so what the user is editing
        // matches what they'll see at runtime.
        const pb = getPetBoundsSafe();
        const wa = pb ? getWorkAreaForPet(pb) : screen.getPrimaryDisplay().workArea;
        if (pb) {
          activeSide = pickSide(pb, wa, ASK_WIDTH, ASK_HEIGHT, bubblePos.side);
          bubble.setBounds(computeBubbleBoundsForSide(activeSide, pb, wa, ASK_WIDTH, ASK_HEIGHT, {
            offsetDx: bubblePos.dx, offsetDy: bubblePos.dy,
          }));
        }
        if (!bubble.isVisible()) bubble.showInactive();
        bubbleShown = true;
        bubble.webContents.send("minicpm:edit-mode", { enabled: true, side: activeSide });
        return { ok: true, side: activeSide };
      } catch (err) {
        bubbleEditing = false;
        return { ok: false, error: String(err && err.message || err) };
      }
    },
    "minicpm-settings:exit-bubble-edit": async (_evt, payload) => {
      const save = !!(payload && payload.save);
      let savedPos = getBubblePos();
      try {
        if (save && bubble && !bubble.isDestroyed()) {
          const pb = getPetBoundsSafe();
          const wa = pb ? getWorkAreaForPet(pb) : screen.getPrimaryDisplay().workArea;
          const actual = bubble.getBounds();
          if (pb && wa) {
            // Compute defaults at offset 0 to derive the user's drag delta.
            const def = computeBubbleBoundsForSide(activeSide, pb, wa, actual.width, actual.height, {
              offsetDx: 0, offsetDy: 0,
            });
            let dx = 0;
            if (activeSide === "left") dx = def.x - actual.x;
            else if (activeSide === "right") dx = actual.x - def.x;
            else dx = actual.x - def.x;
            const dy = actual.y - def.y;
            savedPos = setBubblePos({ ...bubblePos, dx, dy });
          }
        }
      } finally {
        bubbleEditing = false;
        try {
          if (bubble && !bubble.isDestroyed()) {
            bubble.webContents.send("minicpm:edit-mode", { enabled: false });
            bubble.hide();
            bubbleShown = false;
          }
        } catch {}
      }
      return { ok: true, saved: save, pos: savedPos };
    },
  };
  for (const [ch, fn] of Object.entries(settingsHandlers)) {
    try { ipcMain.removeHandler(ch); } catch {}
    ipcMain.handle(ch, fn);
  }

  // Stop the running sidecar (if any) and immediately restart it. Used
  // after settings changes that the engine reads at construction time
  // only — accelerator (MINICPM_DEVICE) and the active model directory.
  async function restartSidecar() {
    await sidecar.stopAndWait();
    return sidecar.ensureRunning(getEffectiveModelDir());
  }

  // Boot or attach to the sidecar and wait until /api/health returns
  // ok. Unlike `warmup()`, this surface bubbles failures upwards — the
  // Onboarding wizard needs to *know* if spawn failed so it can show a
  // proper error message instead of hitting ECONNREFUSED later on.
  async function ensureSidecarReady() {
    return sidecar.ensureRunning(getEffectiveModelDir());
  }

  function sendI18n() {
    if (!bubble || bubble.isDestroyed()) return;
    try {
      bubble.webContents.send(
        "minicpm:lang-change",
        minicpmI18n.getMinicpmI18nPayload(getLang())
      );
    } catch {}
  }

  return {
    open,
    toggle,
    dismiss,
    toggleThinking,
    warmup,
    onStateEvent,
    setNarrationEnabled,
    isNarrationEnabled,
    setPetDragging,
    isOpen: () => bubbleShown && !!(bubble && !bubble.isDestroyed()),
    reposition,
    shutdown,
    restartSidecar,
    ensureSidecarReady,
    sendI18n,
    getSidecarUrl: () => sidecar.baseUrl(),
    getSidecarBinary: () => sidecarBin,
    getLogsDir: () => logsDir,
    getSidecarLogPath: () => sidecarLogPath,
    // Model directory introspection — consumed by Onboarding + Settings.
    getModelDir: () => getEffectiveModelDir(),
    getDefaultModelDir,
    setModelDir: (dir) => setEffectiveModelDir(dir),
    isModelPresent: () => isModelPresent(),
    // So onboarding can validate a picked IR without re-implementing it.
    firstOpenvinoIrIn: (dir) => firstOpenvinoIrIn(dir),
  };
};
