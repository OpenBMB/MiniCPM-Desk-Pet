// src/mini.js — Mini mode (edge snap, crabwalk, peek, window animations)
// Extracted from main.js L315-331, L2700-2911

const { screen } = require("electron");

module.exports = function initMini(ctx) {

const PEEK_OFFSET = 25;
const SNAP_TOLERANCE = 30;
const JUMP_PEAK_HEIGHT = 40;
const JUMP_DURATION = 350;
const MINI_ENTER_FALLBACK_MS = 3200;
const MINI_ENTER_PRELOAD_MS = 300;
const CRABWALK_SPEED = 0.12;  // px/ms
const DISPLAY_EDGE_EPSILON = 2;
const MINI_SEAM_CROP_GUARD_PX = 3;
let MINI_OFFSET_RATIO = ctx.theme.miniMode.offsetRatio;

let miniMode = false;
let miniEdge = "right";  // "left" | "right"
let miniTransitioning = false;
let miniSleepPeeked = false;
let miniPeeked = false;
let preMiniX = 0, preMiniY = 0;
let currentMiniX = 0;
let miniSnap = null;  // { y, width, height } — canonical rect to prevent DPI drift
let lastMiniWorkArea = null;  // workArea of the display the mini pet is on
let miniTransitionTimer = null;
let peekAnimTimer = null;
let isAnimating = false;
let miniRenderCrop = null;

function syncSessionHudVisibility() {
  if (typeof ctx.syncSessionHudVisibility === "function") ctx.syncSessionHudVisibility();
}

function repositionSessionHud() {
  if (typeof ctx.repositionSessionHud === "function") ctx.repositionSessionHud();
}

function refreshTheme() {
  MINI_OFFSET_RATIO = ctx.theme.miniMode.offsetRatio;
  if (miniMode && lastMiniWorkArea) {
    updateMiniRenderCrop(lastMiniWorkArea, _getSize());
    sendMiniModeChange(true, miniEdge);
  }
}

function themeSupportsMini() {
  return !!(ctx.theme && ctx.theme.miniMode && ctx.theme.miniMode.supported !== false);
}

function shouldPreventCrossDisplayCrop() {
  return !!(ctx.theme && ctx.theme.miniMode && ctx.theme.miniMode.preventCrossDisplayCrop);
}

function rangesOverlap(a1, a2, b1, b2) {
  return a1 < b2 && b1 < a2;
}

function sameRect(a, b) {
  return !!(a && b
    && a.x === b.x
    && a.y === b.y
    && a.width === b.width
    && a.height === b.height);
}

function isFiniteRect(rect) {
  return !!(rect
    && Number.isFinite(rect.x)
    && Number.isFinite(rect.y)
    && Number.isFinite(rect.width)
    && Number.isFinite(rect.height)
    && rect.width > 0
    && rect.height > 0);
}

function cropRectsEqual(a, b) {
  if (!a && !b) return true;
  return sameRect(a, b);
}

function hasDisplayAcrossMiniEdge(wa) {
  if (!shouldPreventCrossDisplayCrop() || !isFiniteRect(wa)) return false;
  const displays = screen.getAllDisplays();
  if (!Array.isArray(displays) || displays.length <= 1) return false;

  const edgeX = miniEdge === "left" ? wa.x : wa.x + wa.width;
  const probeX = miniEdge === "left" ? edgeX - 1 : edgeX + 1;
  const waTop = wa.y;
  const waBottom = wa.y + wa.height;

  return displays.some((display) => {
    const other = display && display.workArea;
    if (!isFiniteRect(other) || sameRect(other, wa)) return false;
    if (!rangesOverlap(waTop, waBottom, other.y, other.y + other.height)) return false;
    const edgeGap = miniEdge === "left"
      ? Math.abs((other.x + other.width) - edgeX)
      : Math.abs(other.x - edgeX);
    const probeInsideOther = probeX >= other.x && probeX <= other.x + other.width;
    return edgeGap <= DISPLAY_EDGE_EPSILON || probeInsideOther;
  });
}

function getCropBounds(size, bounds) {
  const fullWidth = Math.max(1, Math.round(size.width));
  const fullHeight = Math.max(1, Math.round(size.height));
  if (isFiniteRect(bounds)) {
    return {
      x: bounds.x,
      y: bounds.y,
      width: Math.max(1, Math.round(bounds.width)),
      height: Math.max(1, Math.round(bounds.height)),
    };
  }
  const winBounds = ctx.win && typeof ctx.win.getBounds === "function" ? ctx.win.getBounds() : null;
  if (isFiniteRect(winBounds)) return winBounds;
  return {
    x: currentMiniX,
    y: miniSnap ? miniSnap.y : 0,
    width: fullWidth,
    height: fullHeight,
  };
}

function buildMiniRenderCrop(wa, size, bounds) {
  if (!hasDisplayAcrossMiniEdge(wa) || !size) return null;
  const fullWidth = Math.max(1, Math.round(size.width));
  const fullHeight = Math.max(1, Math.round(size.height));
  const renderBounds = getCropBounds(size, bounds);
  const edgeX = miniEdge === "left" ? wa.x : wa.x + wa.width;

  if (miniEdge === "left") {
    const hiddenWidth = Math.round(edgeX - renderBounds.x);
    if (hiddenWidth <= 0) return null;
    const x = Math.max(0, Math.min(fullWidth - 1, hiddenWidth + MINI_SEAM_CROP_GUARD_PX));
    return {
      x,
      y: 0,
      width: fullWidth - x,
      height: fullHeight,
    };
  }

  const visibleWidth = Math.round(edgeX - renderBounds.x) - MINI_SEAM_CROP_GUARD_PX;
  if (visibleWidth >= fullWidth) return null;
  return {
    x: 0,
    y: 0,
    width: Math.max(1, Math.min(fullWidth, visibleWidth)),
    height: fullHeight,
  };
}

function applyMiniRenderCropShape() {
  const win = ctx.win;
  if (!win || (typeof win.isDestroyed === "function" && win.isDestroyed())) return;
  if (typeof win.setShape !== "function" || typeof win.getBounds !== "function") return;
  const bounds = win.getBounds();
  const shape = miniRenderCrop
    ? [{
        x: miniRenderCrop.x,
        y: miniRenderCrop.y,
        width: miniRenderCrop.width,
        height: miniRenderCrop.height,
      }]
    : [{ x: 0, y: 0, width: bounds.width, height: bounds.height }];
  try {
    win.setShape(shape);
  } catch {}
}

function updateMiniRenderCrop(wa, size, bounds) {
  const nextCrop = buildMiniRenderCrop(wa, size, bounds);
  const changed = !cropRectsEqual(miniRenderCrop, nextCrop);
  miniRenderCrop = nextCrop;
  applyMiniRenderCropShape();
  return changed;
}

function syncMiniRenderCropForBounds(bounds) {
  if (!miniMode || !lastMiniWorkArea || !bounds) return false;
  const changed = updateMiniRenderCrop(lastMiniWorkArea, {
    width: bounds.width,
    height: bounds.height,
  }, bounds);
  if (changed) sendMiniModeChange(true, miniEdge);
  return changed;
}

function getMiniModeChangeOptions(extra = {}) {
  const options = { ...extra };
  if (miniRenderCrop) options.crop = { ...miniRenderCrop };
  return Object.keys(options).length > 0 ? options : undefined;
}

function sendMiniModeChange(enabled, edge, extra) {
  if (!enabled) {
    ctx.sendToRenderer("mini-mode-change", false);
    return;
  }
  const options = getMiniModeChangeOptions(extra);
  if (options) ctx.sendToRenderer("mini-mode-change", true, edge, options);
  else ctx.sendToRenderer("mini-mode-change", true, edge);
}

// ── Window animation ──
// Mini animations run on **real** Electron bounds (not virtual). enterMiniMode
// calls ctx.setViewportOffsetY(0) before starting animation, so real === virtual
// throughout the mini lifecycle. Skipping applyPetWindowBounds here avoids the
// per-frame materialize → IPC → renderer CSS re-apply round-trip that was
// stalling the main thread during mini entry.
function animateWindowX(targetX, durationMs, onDone) {
  if (peekAnimTimer) { clearTimeout(peekAnimTimer); peekAnimTimer = null; }
  const bounds = ctx.win.getBounds();
  const startX = bounds.x;
  if (startX === targetX) {
    isAnimating = false;
    if (onDone) onDone();
    return;
  }
  isAnimating = true;
  const startTime = Date.now();
  const snapY = miniSnap ? miniSnap.y : bounds.y;
  const snapW = miniSnap ? miniSnap.width : bounds.width;
  const snapH = miniSnap ? miniSnap.height : bounds.height;
  let frameCount = 0;
  const step = () => {
    if (!ctx.win || ctx.win.isDestroyed()) {
      peekAnimTimer = null;
      isAnimating = false;
      if (onDone) onDone();
      return;
    }
    const t = Math.min(1, (Date.now() - startTime) / durationMs);
    const eased = t * (2 - t);
    const x = Math.round(startX + (targetX - startX) * eased);
    if (!Number.isFinite(x) || !Number.isFinite(snapY)) {
      peekAnimTimer = null;
      isAnimating = false;
      if (onDone) onDone();
      return;
    }
    try {
      const nextBounds = { x, y: snapY, width: snapW, height: snapH };
      ctx.win.setBounds(nextBounds);
      syncMiniRenderCropForBounds(nextBounds);
    } catch {
      peekAnimTimer = null;
      isAnimating = false;
      if (onDone) onDone();
      return;
    }
    ctx.syncHitWin();
    repositionSessionHud();
    // Throttle bubble reposition to every 3rd frame (~20fps) — visually identical, less overhead
    if (ctx.bubbleFollowPet && ctx.pendingPermissions.length && (++frameCount % 3 === 0 || t >= 1)) ctx.repositionBubbles();
    if (t < 1) {
      peekAnimTimer = setTimeout(step, 16);
    } else {
      peekAnimTimer = null;
      isAnimating = false;
      if (onDone) onDone();
    }
  };
  step();
}

function animateWindowParabola(targetX, targetY, durationMs, onDone) {
  if (peekAnimTimer) { clearTimeout(peekAnimTimer); peekAnimTimer = null; }
  const bounds = ctx.win.getBounds();
  const startX = bounds.x, startY = bounds.y;
  if (startX === targetX && startY === targetY) {
    isAnimating = false;
    if (onDone) onDone();
    return;
  }
  isAnimating = true;
  const startTime = Date.now();
  let frameCount = 0;
  const step = () => {
    if (!ctx.win || ctx.win.isDestroyed()) {
      peekAnimTimer = null;
      isAnimating = false;
      if (onDone) onDone();
      return;
    }
    const t = Math.min(1, (Date.now() - startTime) / durationMs);
    const eased = t * (2 - t);
    const x = Math.round(startX + (targetX - startX) * eased);
    const arc = -4 * JUMP_PEAK_HEIGHT * t * (t - 1);
    const y = Math.round(startY + (targetY - startY) * eased - arc);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      peekAnimTimer = null;
      isAnimating = false;
      if (onDone) onDone();
      return;
    }
    try {
      ctx.win.setPosition(x, y);
    } catch {
      peekAnimTimer = null;
      isAnimating = false;
      if (onDone) onDone();
      return;
    }
    ctx.syncHitWin();
    repositionSessionHud();
    // Throttle bubble reposition to every 3rd frame (~20fps) — visually identical, less overhead
    if (ctx.bubbleFollowPet && ctx.pendingPermissions.length && (++frameCount % 3 === 0 || t >= 1)) ctx.repositionBubbles();
    if (t < 1) {
      peekAnimTimer = setTimeout(step, 16);
    } else {
      peekAnimTimer = null;
      isAnimating = false;
      if (onDone) onDone();
    }
  };
  step();
}

// Shared X-position formula for mini mode (eliminates duplication across 4+ call sites)
function calcMiniX(wa, size) {
  if (miniEdge === "left") return wa.x - Math.round(size.width * MINI_OFFSET_RATIO);
  return wa.x + wa.width - Math.round(size.width * (1 - MINI_OFFSET_RATIO));
}

function miniPeekIn() {
  const offset = miniEdge === "left" ? PEEK_OFFSET : -PEEK_OFFSET;
  animateWindowX(currentMiniX + offset, 200);
}

function miniPeekOut() {
  animateWindowX(currentMiniX, 200);
}

function getMiniStateFile(state) {
  const miniStates = ctx.theme && ctx.theme.miniMode && ctx.theme.miniMode.states;
  if (!miniStates) return null;
  const files = miniStates[state];
  return Array.isArray(files) && files[0] ? files[0] : null;
}

function getMiniEnterDurationMs(state) {
  const file = getMiniStateFile(state);
  const cycleMs = typeof ctx.getAnimationAssetCycleMs === "function"
    ? ctx.getAnimationAssetCycleMs(file)
    : null;
  return Number.isFinite(cycleMs) && cycleMs > 0 ? cycleMs : MINI_ENTER_FALLBACK_MS;
}

function getMiniRestState() {
  return ctx.doNotDisturb ? "mini-sleep" : "mini-idle";
}

function finishMiniEntry(delayMs) {
  if (miniTransitionTimer) { clearTimeout(miniTransitionTimer); miniTransitionTimer = null; }
  const settleMs = Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : MINI_ENTER_FALLBACK_MS;
  miniTransitionTimer = setTimeout(() => {
    miniTransitionTimer = null;
    miniTransitioning = false;
    ctx.applyState(getMiniRestState());
  }, settleMs);
}

function cancelMiniTransition() {
  miniTransitioning = false;
  if (miniTransitionTimer) { clearTimeout(miniTransitionTimer); miniTransitionTimer = null; }
  if (peekAnimTimer) { clearTimeout(peekAnimTimer); peekAnimTimer = null; }
  isAnimating = false;
}

function _getSize() {
  if (typeof ctx.getEffectiveCurrentPixelSize === "function") {
    return ctx.getEffectiveCurrentPixelSize();
  }
  return ctx.getCurrentPixelSize ? ctx.getCurrentPixelSize() : ctx.SIZES[ctx.currentSize];
}

function checkMiniModeSnap() {
  if (!themeSupportsMini()) return;
  if (miniMode) return;
  const bounds = ctx.getPetWindowBounds();
  const size = _getSize();
  const mEdge = Math.round(size.width * 0.25);
  const centerX = bounds.x + size.width / 2;
  const displays = screen.getAllDisplays();
  for (const d of displays) {
    const wa = d.workArea;
    const centerY = bounds.y + size.height / 2;
    if (centerX < wa.x || centerX > wa.x + wa.width) continue;
    if (centerY < wa.y || centerY > wa.y + wa.height) continue;
    // Right edge snap
    const rightLimit = wa.x + wa.width - size.width + mEdge;
    if (bounds.x >= rightLimit - SNAP_TOLERANCE) {
      enterMiniMode(wa, false, "right");
      return;
    }
    // Left edge snap
    const leftLimit = wa.x - mEdge;
    if (bounds.x <= leftLimit + SNAP_TOLERANCE) {
      enterMiniMode(wa, false, "left");
      return;
    }
  }
}

function enterMiniMode(wa, viaMenu, edge) {
  if (!themeSupportsMini()) return;
  if (miniMode && !viaMenu) return;
  // preMini 存 virtual — 退出 mini 时能复原贴顶位置
  const virtualBounds = ctx.getPetWindowBounds();
  if (!viaMenu) {
    preMiniX = virtualBounds.x;
    preMiniY = virtualBounds.y;
  }
  // 清零 viewport offset — mini 全程用 real 坐标,避免每帧 materialize + IPC 风暴
  if (typeof ctx.setViewportOffsetY === "function") ctx.setViewportOffsetY(0);
  // 之后 real === virtual,用 real API 读取当前 y 作为 mini 起点
  const bounds = ctx.win.getBounds();
  miniMode = true;
  miniSleepPeeked = false;
  miniPeeked = false;
  if (edge) miniEdge = edge;
  const size = _getSize();
  currentMiniX = calcMiniX(wa, size);
  lastMiniWorkArea = wa;
  miniSnap = { y: bounds.y, width: size.width, height: size.height };
  updateMiniRenderCrop(wa, size, bounds);

  ctx.stopWakePoll();

  sendMiniModeChange(true, miniEdge);
  ctx.sendToHitWin("hit-state-sync", { miniMode: true });
  miniTransitioning = true;
  ctx.buildContextMenu();
  ctx.buildTrayMenu();
  syncSessionHudVisibility();

  const enterSvgState = ctx.doNotDisturb ? "mini-enter-sleep" : "mini-enter";

  if (viaMenu) {
    const displays = screen.getAllDisplays();
    let jumpTarget;
    if (miniEdge === "right") {
      let maxRight = 0;
      for (const d of displays) maxRight = Math.max(maxRight, d.bounds.x + d.bounds.width);
      jumpTarget = maxRight;
    } else {
      let minLeft = Infinity;
      for (const d of displays) minLeft = Math.min(minLeft, d.bounds.x);
      jumpTarget = minLeft - size.width;
    }
    animateWindowParabola(jumpTarget, bounds.y, JUMP_DURATION, () => {
      const enterDurationMs = getMiniEnterDurationMs(enterSvgState);
      ctx.applyState(enterSvgState);
      if (MINI_ENTER_PRELOAD_MS <= 0) {
        miniSnap = { y: bounds.y, width: size.width, height: size.height };
        const nextBounds = { x: currentMiniX, y: miniSnap.y, width: miniSnap.width, height: miniSnap.height };
        ctx.win.setBounds(nextBounds);
        updateMiniRenderCrop(wa, size, nextBounds);
        sendMiniModeChange(true, miniEdge);
        ctx.syncHitWin();
        syncSessionHudVisibility();
        finishMiniEntry(enterDurationMs);
        return;
      }
      miniTransitionTimer = setTimeout(() => {
        miniSnap = { y: bounds.y, width: size.width, height: size.height };
        const nextBounds = { x: currentMiniX, y: miniSnap.y, width: miniSnap.width, height: miniSnap.height };
        ctx.win.setBounds(nextBounds);
        updateMiniRenderCrop(wa, size, nextBounds);
        sendMiniModeChange(true, miniEdge);
        miniTransitionTimer = null;
        ctx.syncHitWin();
        syncSessionHudVisibility();
        finishMiniEntry(enterDurationMs);
      }, MINI_ENTER_PRELOAD_MS);
    });
  } else {
    // Drag path: slide the window into place first, then play mini-enter.
    // Running the 100ms window slide concurrently with the ~960ms in-SVG
    // body-slide used to cancel them out visually (opposite directions, 10×
    // speed difference) — the body-slide became invisible and the pet
    // looked frozen for ~1s before the arm wave. Sequencing them matches
    // the via-menu path: window settles, then the full entry animation
    // plays in place and reads clearly.
    animateWindowX(currentMiniX, 100, () => {
      ctx.applyState(enterSvgState);
      finishMiniEntry(getMiniEnterDurationMs(enterSvgState));
    });
  }
}

function exitMiniMode() {
  if (!miniMode) return;
  cancelMiniTransition();
  // Keep miniMode = true and miniTransitioning = true during exit parabola.
  // This blocks ALL paths that check miniMode (always-on-top-changed,
  // display-metrics-changed, move-window-by, checkMiniModeSnap, etc.)
  // from interfering with the animation. Both flags clear in onDone.
  miniTransitioning = true;
  miniSnap = null;
  miniSleepPeeked = false;
  miniPeeked = false;
  miniRenderCrop = null;
  applyMiniRenderCropShape();
  sendMiniModeChange(true, miniEdge);

  const size = _getSize();
  const visualState = ctx.doNotDisturb ? "idle" : ctx.resolveDisplayState();
  const visualFile = visualState ? ctx.getSvgOverride(visualState) : null;
  const clamped = ctx.clampToScreenVisual(preMiniX, preMiniY, size.width, size.height, {
    state: visualState,
    file: visualFile,
  });
  const wa = ctx.getNearestWorkArea(clamped.x + size.width / 2, clamped.y + size.height / 2);
  const mEdge = Math.round(size.width * 0.25);
  // Prevent right-edge re-snap
  if (clamped.x >= wa.x + wa.width - size.width + mEdge - SNAP_TOLERANCE) {
    clamped.x = wa.x + wa.width - size.width + mEdge - 100;
  }
  // Prevent left-edge re-snap
  if (clamped.x <= wa.x - mEdge + SNAP_TOLERANCE) {
    clamped.x = wa.x - mEdge + SNAP_TOLERANCE + 100;
  }

  animateWindowParabola(clamped.x, clamped.y, JUMP_DURATION, () => {
    miniMode = false;
    miniTransitioning = false;
    sendMiniModeChange(false);
    ctx.sendToHitWin("hit-state-sync", { miniMode: false });
    ctx.buildContextMenu();
    ctx.buildTrayMenu();
    syncSessionHudVisibility();
    if (ctx.doNotDisturb) {
      ctx.doNotDisturb = false;
      ctx.sendToRenderer("dnd-change", false);
      ctx.sendToHitWin("hit-state-sync", { dndEnabled: false });
      ctx.buildContextMenu();
      ctx.buildTrayMenu();
      ctx.applyState("waking");
    } else {
      const resolved = ctx.resolveDisplayState();
      ctx.applyState(resolved, ctx.getSvgOverride(resolved));
    }
  });
}

function enterMiniViaMenu() {
  if (!themeSupportsMini()) return;
  // preMini 存 virtual — 退出 mini 时能复原贴顶位置
  const virtualBounds = ctx.getPetWindowBounds();
  preMiniX = virtualBounds.x;
  preMiniY = virtualBounds.y;
  // 清零 viewport offset — 和 enterMiniMode 对称
  if (typeof ctx.setViewportOffsetY === "function") ctx.setViewportOffsetY(0);
  const bounds = ctx.win.getBounds();
  const size = _getSize();
  const wa = ctx.getNearestWorkArea(bounds.x + size.width / 2, bounds.y + size.height / 2);

  // Auto-detect nearest edge
  const centerX = bounds.x + size.width / 2;
  const waMid = wa.x + wa.width / 2;
  const edge = centerX <= waMid ? "left" : "right";
  miniEdge = edge;

  miniTransitioning = true;
  syncSessionHudVisibility();

  // Pre-entry crabwalk still uses the normal-size render/layout path. Send the
  // edge for left-side flipping, but don't let the renderer enter mini layout
  // until enterMiniMode() starts the real mini handoff.
  ctx.sendToRenderer("mini-mode-change", true, edge, { preEntry: true });
  ctx.sendToHitWin("hit-state-sync", { miniMode: true });

  ctx.applyState("mini-crabwalk");

  let edgeX;
  if (edge === "right") {
    edgeX = wa.x + wa.width - size.width + Math.round(size.width * 0.25);
  } else {
    edgeX = wa.x - Math.round(size.width * 0.25);
  }
  const walkDist = Math.abs(bounds.x - edgeX);
  const walkDuration = walkDist / CRABWALK_SPEED;
  animateWindowX(edgeX, walkDuration);

  miniTransitionTimer = setTimeout(() => {
    enterMiniMode(wa, true, edge);
  }, walkDuration + 50);
}

function handleDisplayChange() {
  if (!ctx.win || ctx.win.isDestroyed()) return;
  if (!miniMode) return;
  const size = _getSize();
  // mini 期间 offset 恒为 0,real === virtual,直接读 real
  const bounds = ctx.win.getBounds();
  const snapY = miniSnap ? miniSnap.y : bounds.y;
  const wa = ctx.getNearestWorkArea(currentMiniX + size.width / 2, snapY + size.height / 2);
  lastMiniWorkArea = wa;
  currentMiniX = calcMiniX(wa, size);
  // mini 的 y 必须在工作区内(real 坐标),加回两端 clamp
  const clampedY = Math.max(wa.y, Math.min(snapY, wa.y + wa.height - size.height));
  miniSnap = { y: clampedY, width: size.width, height: size.height };
  const nextBounds = { x: currentMiniX, y: clampedY, width: size.width, height: size.height };
  ctx.win.setBounds(nextBounds);
  updateMiniRenderCrop(wa, size, nextBounds);
  sendMiniModeChange(true, miniEdge);
  syncSessionHudVisibility();
}

function handleResize(sizeKey) {
  if (!miniMode) return false;
  const { y: curY } = ctx.win.getBounds();
  const wa = lastMiniWorkArea || ctx.getNearestWorkArea(currentMiniX, curY);
  const size = (typeof ctx.getPixelSizeFor === "function")
    ? ctx.getPixelSizeFor(sizeKey, wa)
    : ctx.SIZES[sizeKey];
  currentMiniX = calcMiniX(wa, size);
  const clampedY = Math.max(wa.y, Math.min(curY, wa.y + wa.height - size.height));
  miniSnap = { y: clampedY, width: size.width, height: size.height };
  const nextBounds = { x: currentMiniX, y: clampedY, width: size.width, height: size.height };
  ctx.win.setBounds(nextBounds);
  updateMiniRenderCrop(wa, size, nextBounds);
  sendMiniModeChange(true, miniEdge);
  syncSessionHudVisibility();
  return true;
}

function restoreFromPrefs(prefs, size) {
  preMiniX = prefs.preMiniX || 0;
  preMiniY = prefs.preMiniY || 0;
  miniEdge = prefs.miniEdge || "right";
  const wa = ctx.getNearestWorkArea(prefs.x + size.width / 2, prefs.y + size.height / 2);
  lastMiniWorkArea = wa;
  currentMiniX = calcMiniX(wa, size);
  // 启动恢复 mini 时 y 必须在工作区内(保证 offset = 0,符合 mini 语义)
  const startY = Math.max(wa.y, Math.min(prefs.y, wa.y + wa.height - size.height));
  miniSnap = { y: startY, width: size.width, height: size.height };
  miniRenderCrop = buildMiniRenderCrop(wa, size, {
    x: currentMiniX,
    y: startY,
    width: size.width,
    height: size.height,
  });
  miniMode = true;
  miniTransitioning = false;
  miniSleepPeeked = false;
  miniPeeked = false;
  return { x: currentMiniX, y: startY, width: size.width, height: size.height };
}

function getMiniMode() { return miniMode; }
function getMiniEdge() { return miniEdge; }
function getMiniTransitioning() { return miniTransitioning; }
function getMiniSleepPeeked() { return miniSleepPeeked; }
function setMiniSleepPeeked(v) { miniSleepPeeked = v; }
function getMiniPeeked() { return miniPeeked; }
function setMiniPeeked(v) { miniPeeked = v; }
function getIsAnimating() { return isAnimating; }
function getPreMiniX() { return preMiniX; }
function getPreMiniY() { return preMiniY; }
function getCurrentMiniX() { return currentMiniX; }
function getMiniSnap() { return miniSnap; }
function getMiniRenderCrop() { return miniRenderCrop ? { ...miniRenderCrop } : null; }

function cleanup() {
  if (miniTransitionTimer) { clearTimeout(miniTransitionTimer); miniTransitionTimer = null; }
  if (peekAnimTimer) { clearTimeout(peekAnimTimer); peekAnimTimer = null; }
}

return {
  enterMiniMode, exitMiniMode, enterMiniViaMenu,
  miniPeekIn, miniPeekOut, checkMiniModeSnap, cancelMiniTransition,
  animateWindowX, animateWindowParabola,
  refreshTheme,
  handleDisplayChange, handleResize, restoreFromPrefs,
  getMiniMode, getMiniEdge, getMiniTransitioning, getMiniSleepPeeked, setMiniSleepPeeked, getMiniPeeked, setMiniPeeked,
  getIsAnimating, getPreMiniX, getPreMiniY, getCurrentMiniX, getMiniSnap, getMiniRenderCrop,
  applyMiniRenderCropShape, getMiniModeChangeOptions,
  get MINI_OFFSET_RATIO() { return MINI_OFFSET_RATIO; },
  PEEK_OFFSET,
  cleanup,
};

};
