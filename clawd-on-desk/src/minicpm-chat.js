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
//   <repo-root>/clawd-on-desk      ← this Electron app
//   <repo-root>/minicpm-pet-bridge ← Python server.py
//   <repo-root>/models/<name>/     ← HuggingFace model dirs
//
// Override locations via env:
//   MINICPM_BRIDGE_DIR / MINICPM_PYTHON / MINICPM_CONDA_ENV
//

const { BrowserWindow, ipcMain, screen, shell, Menu, app } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";
const isLinux = process.platform === "linux";
const WIN_TOPMOST_LEVEL = "pop-up-menu";
const LINUX_WINDOW_TYPE = "splash";

const DEFAULT_PORT = 8765;
const DEFAULT_HOST = "127.0.0.1";
const BUBBLE_GAP = 8;   // pixels between visible pet sprite and bubble
const EDGE_MARGIN = 8;

const ASK_WIDTH = 120;       // initial empty-input width — tiny pill
const ASK_HEIGHT = 44;
const SPEAK_MAX_WIDTH = 360;
// 440 (was 360): leaves headroom so the right-aligned "last user question"
// pill that sits above the streaming reply / continuous-chat pane never
// gets clipped from the top when both the question and the reply are long.
const SPEAK_MAX_HEIGHT = 440;
const MIN_WIDTH = 100;
const MIN_HEIGHT = 40;

// ── locate the Python bridge dir / Python interpreter ───────────────────────

function locateBridgeDir(appRoot) {
  const candidates = [
    process.env.MINICPM_BRIDGE_DIR,
    path.join(appRoot, "..", "minicpm-pet-bridge"),
    path.join(os.homedir(), "Downloads", "Minicpm", "minicpm-pet-bridge"),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.statSync(path.join(c, "server.py")).isFile()) return path.resolve(c);
    } catch {}
  }
  return null;
}

function locatePython() {
  const explicit = process.env.MINICPM_PYTHON;
  if (explicit && fs.existsSync(explicit)) return { python: explicit, viaShell: false };

  const envName = process.env.MINICPM_CONDA_ENV || "minicpm-pet";
  const condaCandidates = [
    path.join(os.homedir(), "miniconda3", "envs", envName, "bin", "python"),
    path.join(os.homedir(), "anaconda3", "envs", envName, "bin", "python"),
    path.join("/opt", "miniconda3", "envs", envName, "bin", "python"),
    path.join("/opt", "anaconda3", "envs", envName, "bin", "python"),
    path.join("/opt", "homebrew", "Caskroom", "miniconda", "base", "envs", envName, "bin", "python"),
  ];
  for (const p of condaCandidates) {
    try {
      if (fs.statSync(p).isFile()) return { python: p, viaShell: false };
    } catch {}
  }
  return { python: null, viaShell: true, condaEnv: envName };
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
  constructor({ bridgeDir, port, host, log }) {
    this.bridgeDir = bridgeDir;
    this.port = port;
    this.host = host;
    this.log = log || (() => {});
    this.proc = null;
    this.starting = null;
    this.stderrTail = [];
  }

  baseUrl() { return `http://${this.host}:${this.port}`; }

  async ensureRunning(initialModelDir) {
    if (await this.isHealthy()) return { status: "already-running" };
    if (this.starting) return this.starting;
    this.starting = this._spawnAndWait(initialModelDir).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async isHealthy() {
    try {
      const r = await httpJson("GET", `${this.baseUrl()}/api/health`, null, 1500);
      return r.status === 200 && r.json && r.json.ok === true;
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

  async checkUpdate() {
    try {
      const r = await httpJson("GET", `${this.baseUrl()}/api/update-check`, null, 4000);
      return r.json || null;
    } catch { return null; }
  }

  async _spawnAndWait(initialModelDir) {
    if (!this.bridgeDir) {
      throw new Error("找不到 minicpm-pet-bridge 目录。请设置 MINICPM_BRIDGE_DIR 环境变量。");
    }

    const { python, viaShell, condaEnv } = locatePython();
    // NOTE: no --no-pet — we *want* the Python server to push states to the
    // local clawd-on-desk HTTP endpoint (port 23333) so the pet animates
    // along with the conversation.
    const args = [
      "server.py",
      "--host", this.host,
      "--port", String(this.port),
    ];
    if (initialModelDir) args.push("--model", initialModelDir);

    const env = {
      ...process.env,
      PYTHONUNBUFFERED: "1",
    };
    // Auto-discover a LoRA adapter if the user hasn't explicitly set one.
    // We look at <repo-root>/adapters/ for any directory containing an
    // adapter_config.json. Convention: that dir's name is exposed via
    // MINICPM_ADAPTER and used by the sidecar.
    if (!env.MINICPM_ADAPTER) {
      try {
        const adaptersRoot = path.resolve(this.bridgeDir, "..", "adapters");
        const stat = fs.statSync(adaptersRoot);
        if (stat.isDirectory()) {
          for (const name of fs.readdirSync(adaptersRoot)) {
            const cand = path.join(adaptersRoot, name);
            if (fs.existsSync(path.join(cand, "adapter_config.json"))) {
              env.MINICPM_ADAPTER = cand;
              this.log(`[minicpm-chat] auto-detected LoRA adapter: ${cand}`);
              break;
            }
          }
        }
      } catch {}
    }

    let proc;
    if (python) {
      this.log(`[minicpm-chat] spawn ${python} server.py --port ${this.port}`);
      proc = spawn(python, args, { cwd: this.bridgeDir, env });
    } else if (viaShell) {
      const cmd = [
        `eval "$(conda shell.bash hook)"`,
        `conda activate ${condaEnv}`,
        `exec python ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`,
      ].join(" && ");
      this.log(`[minicpm-chat] spawn via shell (conda env: ${condaEnv})`);
      proc = spawn("/bin/bash", ["-lc", cmd], { cwd: this.bridgeDir, env });
    } else {
      throw new Error("找不到 Python 解释器。请先 `conda create -n minicpm-pet python=3.11` 并 pip install requirements.txt。");
    }

    this.proc = proc;
    this.stderrTail.length = 0;

    proc.stdout.on("data", (b) => this.log(`[sidecar] ${b.toString().trimEnd()}`));
    proc.stderr.on("data", (b) => {
      const s = b.toString();
      this.log(`[sidecar! ] ${s.trimEnd()}`);
      this.stderrTail.push(s);
      if (this.stderrTail.length > 40) this.stderrTail.shift();
    });
    proc.on("exit", (code, signal) => {
      this.log(`[minicpm-chat] sidecar exited code=${code} signal=${signal}`);
      if (this.proc === proc) this.proc = null;
    });

    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (!this.proc) {
        const tail = this.stderrTail.join("").trim().slice(-1500) || "(no stderr)";
        throw new Error(`Python 进程提前退出。stderr 末尾：\n${tail}`);
      }
      if (await this.isHealthy()) return { status: "started" };
      await new Promise((r) => setTimeout(r, 500));
    }
    this.stop();
    throw new Error("等待 Python 服务就绪超时 (90s)。");
  }

  stop() {
    if (!this.proc) return;
    try { this.proc.kill("SIGTERM"); } catch {}
    setTimeout(() => {
      if (this.proc) { try { this.proc.kill("SIGKILL"); } catch {} }
    }, 2000).unref();
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
  const bridgeDir = locateBridgeDir(appRoot);
  const port = Number(process.env.MINICPM_PORT || DEFAULT_PORT);
  const host = process.env.MINICPM_HOST || DEFAULT_HOST;
  const log = (msg) => { try { console.log(msg); } catch {} };

  const sidecar = new Sidecar({ bridgeDir, port, host, log });

  let bubble = null;
  let activeSide = "right";
  // Updated from /api/health after the sidecar comes online — drives the
  // narrator's voice (default vs neko etc.).
  let activePersona = "default";
  // Tracked "is the bubble currently shown to the user" flag. We can't rely
  // on bubble.isVisible() with macOS panel windows because showInactive() +
  // panel quirks make it return true even after a hide().
  let bubbleShown = false;
  // When set, bubble resizes pin their bottom edge to this Y so the
  // textarea stays put while the bubble grows upward. Cleared on
  // open/transition. Renderer sets this via the "resize" IPC.
  let chatAnchorBottomY = null;
  // Cached "is there a new model on the remote?" status. Refreshed on
  // launch, after every apply, and whenever the user manually checks.
  let updateStatus = null; // { available, local_revision, remote_revision, ... }

  // ── Chat generation parameters ────────────────────────────────────────
  // Persisted to <userData>/minicpm-prefs.json so they survive restart.
  // Values are validated/clamped on every set; the chat bubble fetches
  // them on each submit, the Settings tab reads/writes via IPC.
  const PARAMS_PATH = (() => {
    try { return path.join(app.getPath("userData"), "minicpm-prefs.json"); }
    catch { return path.join(os.tmpdir(), "minicpm-prefs.json"); }
  })();
  const DEFAULT_CHAT_PARAMS = {
    max_new_tokens: 768,
    temperature: 0.6,
    top_p: 0.95,
    top_k: 0,                  // 0 = disabled
    repetition_penalty: 1.05,
    thinking: false,           // default off (LoRA usually wasn't trained on <think>)
  };
  let chatParams = { ...DEFAULT_CHAT_PARAMS };
  try {
    if (fs.existsSync(PARAMS_PATH)) {
      const raw = JSON.parse(fs.readFileSync(PARAMS_PATH, "utf-8"));
      chatParams = { ...DEFAULT_CHAT_PARAMS, ...(raw && typeof raw === "object" ? raw : {}) };
    }
  } catch (err) { log(`[minicpm] params load failed: ${err && err.message}`); }
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
  function setChatParams(input) {
    chatParams = clampChatParams(input);
    try { fs.writeFileSync(PARAMS_PATH, JSON.stringify(chatParams, null, 2), "utf-8"); }
    catch (err) { log(`[minicpm] params save failed: ${err && err.message}`); }
    return chatParams;
  }
  function getChatParams() { return { ...chatParams }; }

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
  // Default ON during dev so we can iterate; flip to false (or persist via
  // settings) before shipping.
  let narrationEnabled = true;
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
    const summary = typeof data.last_summary === "string" && data.last_summary.trim()
      ? data.last_summary.trim()
      : "";

    // Build the event description. When a `summary` is present we include it
    // so the model can react to *what AI just did* rather than just the topic.
    let situation;
    // Unified, agent-neutral framing. The old branches said "围绕X写完
    // 代码" for non-Cursor agents, which misframed casual chats as code
    // sessions and pushed the model into "继续帮主人" mode. Now everything
    // is "刚结束跟 AI 关于X的对话" regardless of agent — works for both
    // code and chat.
    const subject = title ? `「${title}」` : (niceCwd ? `${niceCwd} 项目` : "");
    if (data.event === "StopFailure") {
      situation = subject
        ? `主人和 AI 处理${subject}的时候出错了`
        : `主人那边的 AI 报错了`;
    } else if (data.event === "Notification") {
      situation = subject
        ? `主人在${subject}这事里卡在一个确认弹窗`
        : `主人卡在一个确认弹窗`;
    } else {
      situation = subject
        ? `主人刚结束跟 AI 关于${subject}的对话`
        : `主人那边的对话刚结束了`;
    }
    if (summary) {
      situation += `。AI 最后说：${summary}`;
    }

    // Narration always runs the base model (`disable_adapter: true`) so
    // the persona LoRA doesn't bias output toward cuteness over info
    // density. The few-shots now teach the **transcribe-don't-roleplay**
    // distinction: the pet is reporting AI's output to its owner, NOT
    // continuing the AI's reply.
    return {
      system:
        "你是主人电脑上的小桌宠。主人正在跟一个 AI 助手聊天 / 写代码,你看不到全程,只能看到事件描述和 AI 最后说的那句话。\n" +
        "你的任务:把 AI 那句话压缩成一句话,告诉主人「AI 刚才告诉你/做了什么」。" +
        "你是 旁观者,不是 AI 本身,不要替 AI 接话。\n\n" +
        "硬要求:\n" +
        "- 一句话,12-28 个汉字\n" +
        "- 必须复述 AI 那句话里的具体内容(火锅/拉面 / token 写反 / 缺什么环境变量 / ...)\n" +
        "- 视角是「向主人转述 AI」,不要冒充 AI 自己,不要说「我帮你...」「让我...」\n" +
        "- 不要给主人提建议,不要问主人问题,不要发表评论\n" +
        "- 不要提 AI 助手的具体产品名\n" +
        "- 只输出这一句话本身,无前缀、无引号、无 markdown\n\n" +
        "示例:\n\n" +
        "事件:主人刚结束跟 AI 关于「晚饭吃啥」的对话。AI 最后说:推荐火锅、拉面、烤肉、川菜小炒,看你想吃哪种。\n" +
        "回复:AI 推荐了火锅、拉面、烤肉和川菜\n\n" +
        "事件:主人刚结束跟 AI 关于「晚饭吃啥」的对话。AI 最后说:火锅好选择!\n" +
        "回复:AI 也觉得火锅是好选择\n\n" +
        "事件:主人刚结束跟 AI 关于「修登录 bug」的对话。AI 最后说:token 过期判断写反了,已修。\n" +
        "回复:登录 bug 修好了,是 token 判断写反\n\n" +
        "事件:主人刚结束跟 AI 关于「重构数据层」的对话。AI 最后说:把 user 表拆成 user 和 user_profile 两张。\n" +
        "回复:AI 把 user 表拆成 user 和 user_profile 了\n\n" +
        "事件:主人和 AI 处理「部署到 staging」的时候出错了。AI 最后说:部署失败,缺少 STAGING_API_KEY 环境变量。\n" +
        "回复:部署挂了,差一个 STAGING_API_KEY\n\n" +
        "事件:主人刚结束跟 AI 关于「雨天音乐」的对话。AI 最后说:推荐久石让《Summer》、坂本龙一《Merry Christmas Mr.Lawrence》。\n" +
        "回复:AI 推荐了久石让和坂本龙一两首钢琴曲\n\n" +
        "事件:主人刚结束跟 AI 关于「文档检索」的对话\n" +
        "回复:AI 那边的对话结束了",
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
        disable_adapter: true,   // bypass persona LoRA — narration must be functional/informative
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

  function setNarrationEnabled(value) { narrationEnabled = !!value; }
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
      const r = await sidecar.ensureRunning(null);
      log(`[minicpm-chat] sidecar warmup ${r.status}`);
      void refreshUpdateStatus();
      void refreshPersona();
    } catch (err) {
      log(`[minicpm-chat] sidecar warmup failed: ${err && err.message || err}`);
    }
  }

  async function refreshUpdateStatus() {
    const status = await sidecar.checkUpdate();
    if (!status) return null;
    updateStatus = status;
    log(`[minicpm-chat] update check: local=${status.local_revision || "?"} remote=${status.remote_revision || "?"} available=${status.available}`);
    if (status.available && bubble && !bubble.isDestroyed()) {
      bubble.webContents.send("minicpm:update-status", status);
    }
    return status;
  }

  async function refreshPersona() {
    try {
      const r = await httpJson("GET", `${sidecar.baseUrl()}/api/health`, null, 1500);
      if (r.json && r.json.persona) {
        if (r.json.persona !== activePersona) {
          activePersona = r.json.persona;
          log(`[minicpm-chat] persona = ${activePersona}${r.json.adapter ? " (adapter: " + r.json.adapter + ")" : ""}`);
        }
      }
    } catch {}
  }

  function getUpdateStatus() { return updateStatus; }

  async function applyUpdate(onProgress) {
    // Stream SSE progress back so callers can drive a UI.
    return new Promise((resolve) => {
      const u = new URL(`${sidecar.baseUrl()}/api/update-apply`);
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
              try { onProgress && onProgress(ev); } catch {}
            } catch {}
          }
        });
        res.on("end", () => resolve({ ok: true }));
      });
      req.on("error", (err) => resolve({ ok: false, error: err.message }));
      req.end();
    });
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

    const updLabel = updateStatus
      ? (updateStatus.available
          ? `● 新版本可用: ${updateStatus.remote_revision} → 立即更新`
          : `已是最新 (${updateStatus.local_revision || "?"})`)
      : "检查模型更新";
    items.push({
      label: updLabel,
      enabled: !(updateStatus && updateStatus.busy),
      click: async () => {
        if (updateStatus && updateStatus.available) {
          // Trigger apply with progress, surfacing through the bubble.
          if (bubble && !bubble.isDestroyed()) {
            bubble.webContents.send("minicpm:update-applying", { phase: "start" });
          }
          await applyUpdate((ev) => {
            if (bubble && !bubble.isDestroyed()) {
              bubble.webContents.send("minicpm:update-applying", ev);
            }
          });
          await refreshUpdateStatus();
        } else {
          await refreshUpdateStatus();
          if (bubble && !bubble.isDestroyed()) {
            bubble.webContents.send("minicpm:update-status", updateStatus);
          }
        }
      },
    });

    items.push({ type: "separator" });
    items.push({
      label: `桌宠旁白 (Stop / 错误时吐槽)`,
      type: "checkbox",
      checked: narrationEnabled,
      click: (it) => { narrationEnabled = !!it.checked; },
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
      bridgeDir,
      url: sidecar.baseUrl(),
      healthy: await sidecar.isHealthy(),
    }),
    "minicpm:start": async (_evt, opts = {}) => {
      try {
        const r = await sidecar.ensureRunning(opts.modelDir || null);
        return { ok: true, status: r.status, url: sidecar.baseUrl() };
      } catch (err) {
        return { ok: false, error: String(err && err.message || err) };
      }
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
    "minicpm:update-status": async () => {
      // Returns the cached status + triggers a fresh background refresh.
      void refreshUpdateStatus();
      return updateStatus || { available: false };
    },
    "minicpm:update-apply": async () => {
      // Stream progress events back to the renderer in real time so the UI
      // can paint the progress bar; resolve the invoke once the apply is
      // finished.
      const result = await applyUpdate((ev) => {
        if (bubble && !bubble.isDestroyed()) {
          bubble.webContents.send("minicpm:update-applying", ev);
        }
      });
      await refreshUpdateStatus();
      return { ...result, status: updateStatus };
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
        // the bubble was hidden.
        const pb = ctx.getPetWindowBounds && ctx.getPetWindowBounds();
        const wa = pb ? (ctx.getNearestWorkArea
          ? ctx.getNearestWorkArea(pb.x + pb.width / 2, pb.y + pb.height / 2)
          : screen.getPrimaryDisplay().workArea) : null;
        if (pb && wa) {
          const { width, height } = bubble.getBounds();
          activeSide = pickSide(pb, wa, width, height, bubblePos.side);
          bubble.setBounds(computeBubbleBoundsForSide(activeSide, pb, wa, width, height, {
            offsetDx: bubblePos.dx, offsetDy: bubblePos.dy,
          }));
        }
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
      const health = await httpJson("GET", `${sidecar.baseUrl()}/api/health`, null, 1500).catch(() => null);
      return {
        sidecarUrl: sidecar.baseUrl(),
        bridgeDir,
        healthy: !!(health && health.json && health.json.ok),
        health: health ? health.json : null,
        narration: narrationEnabled,
      };
    },
    "minicpm-settings:list-adapters": async () => {
      const r = await httpJson("GET", `${sidecar.baseUrl()}/api/adapters`, null, 2000).catch(() => null);
      return r ? r.json : null;
    },
    "minicpm-settings:load-adapter": async (_evt, payload) => {
      const requested = (payload && payload.path) || null;
      // Short-circuit when the requested adapter is already active —
      // skip the load-adapter call entirely (it's a few-hundred-ms op
      // even when no-op) and don't wipe chat history.
      const cur = await httpJson("GET", `${sidecar.baseUrl()}/api/health`, null, 1500).catch(() => null);
      const currentAdapter = cur && cur.json ? (cur.json.adapter || null) : undefined;
      const sameAdapter = currentAdapter !== undefined && (
        (requested === null && !currentAdapter) ||
        (requested && currentAdapter && requested === currentAdapter)
      );
      if (sameAdapter) {
        const personaName = cur.json.persona && cur.json.persona !== "default" ? cur.json.persona : null;
        const adapterName = (currentAdapter && String(currentAdapter).split("/").pop()) || null;
        let text;
        if (!currentAdapter) text = "已经是 base 模型了。";
        else if (personaName) text = `已经在 LoRA · ${personaName} 了。`;
        else text = `已经加载着 LoRA · ${adapterName || "?"} 了。`;
        try {
          ensureBubble();
          reposition();
          if (!bubble.isVisible()) bubble.showInactive();
          bubbleShown = true;
          bubble.webContents.send("minicpm:cmd-reply", { text, ok: true });
        } catch (err) {
          log(`[minicpm] adapter no-op notify failed: ${err && err.message}`);
        }
        return { ok: true, noop: true, adapter: currentAdapter, persona: cur.json.persona };
      }

      const r = await httpJson("POST", `${sidecar.baseUrl()}/api/load-adapter`, payload || {}, 90000).catch(() => null);
      const data = r ? r.json : null;
      if (data && data.ok) {
        // Mirror the in-chat command UX: pop a fade-out reply bubble next
        // to the pet announcing the swap, and tell the renderer to wipe
        // its conversation history so the new persona starts clean.
        const personaName = data.persona && data.persona !== "default" ? data.persona : null;
        const adapterName = (data.adapter && String(data.adapter).split("/").pop()) || null;
        let text;
        if (!data.adapter) text = "已切换回 base 模型，对话历史已清空。";
        else if (personaName) text = `已切换到 LoRA · ${personaName}，对话历史已清空。`;
        else text = `已加载 LoRA · ${adapterName || "?"}，对话历史已清空。`;
        try {
          ensureBubble();
          reposition();
          if (!bubble.isVisible()) bubble.showInactive();
          bubbleShown = true;
          bubble.webContents.send("minicpm:cmd-reply", { text, ok: true, resetHistory: true });
        } catch (err) {
          log(`[minicpm] adapter swap notify failed: ${err && err.message}`);
        }
      }
      return data;
    },
    "minicpm-settings:check-update": async () => {
      const r = await httpJson("GET", `${sidecar.baseUrl()}/api/update-check`, null, 5000).catch(() => null);
      return r ? r.json : null;
    },
    "minicpm-settings:apply-update": async () => {
      // Reuse the same update path the bubble menu uses; results in events
      // streamed via the chat bubble (if open).
      try {
        const result = await applyUpdate(() => {});
        await refreshUpdateStatus();
        return { ...result, status: updateStatus };
      } catch (err) {
        return { ok: false, error: String(err && err.message || err) };
      }
    },
    "minicpm-settings:set-narration": async (_evt, payload) => {
      narrationEnabled = !!(payload && payload.enabled);
      return { ok: true, enabled: narrationEnabled };
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
    getSidecarUrl: () => sidecar.baseUrl(),
    getBridgeDir: () => bridgeDir,
  };
};
