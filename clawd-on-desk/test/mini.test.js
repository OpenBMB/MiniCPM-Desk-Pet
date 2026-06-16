"use strict";

const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const themeLoader = require("../src/theme-loader");
themeLoader.init(path.join(__dirname, "..", "src"));
const _defaultTheme = themeLoader.loadTheme("cybercat");
const SEAM_CROP_GUARD_PX = 3;

function cloneTheme(theme) {
  return JSON.parse(JSON.stringify(theme));
}

function loadMiniWithElectron(screenExports) {
  const electronPath = require.resolve("electron");
  const miniPath = require.resolve("../src/mini");
  const previousElectron = Object.prototype.hasOwnProperty.call(require.cache, electronPath)
    ? require.cache[electronPath]
    : null;
  const previousMini = Object.prototype.hasOwnProperty.call(require.cache, miniPath)
    ? require.cache[miniPath]
    : null;

  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: {
      screen: screenExports,
    },
  };
  delete require.cache[miniPath];

  return {
    initMini: require("../src/mini"),
    restore() {
      if (previousElectron) require.cache[electronPath] = previousElectron;
      else delete require.cache[electronPath];
      if (previousMini) require.cache[miniPath] = previousMini;
      else delete require.cache[miniPath];
    },
  };
}

function makeCtx(theme, stateLog, initialX = 160) {
  const bounds = { x: initialX, y: 180, width: 120, height: 120 };
  const shapeLog = [];
  return {
    theme,
    currentState: "idle",
    win: {
      getBounds() { return { ...bounds }; },
      setBounds(next) {
        bounds.x = next.x;
        bounds.y = next.y;
        bounds.width = next.width;
        bounds.height = next.height;
      },
      setPosition(x, y) {
        bounds.x = x;
        bounds.y = y;
      },
      setShape(shape) {
        shapeLog.push(JSON.parse(JSON.stringify(shape)));
      },
      isDestroyed() { return false; },
    },
    doNotDisturb: false,
    bubbleFollowPet: false,
    pendingPermissions: [],
    currentSize: "m",
    mouseOverPet: false,
    SIZES: { m: { width: 120, height: 120 } },
    getCurrentPixelSize() { return { width: 120, height: 120 }; },
    getPetWindowBounds() { return { ...bounds }; },
    getAnimationAssetCycleMs(file) {
      if (file && (file.includes("mini-enter") || file === "cybercat-mini-idle.gif")) return 1000;
      return null;
    },
    getBoundsSnapshot() { return { ...bounds }; },
    getShapeLog() { return [...shapeLog]; },
    setViewportOffsetY() {},
    stopWakePoll() {},
    sendToRenderer() {},
    sendToHitWin() {},
    buildContextMenu() {},
    buildTrayMenu() {},
    syncHitWin() {},
    repositionBubbles() {},
    getNearestWorkArea() { return { x: 0, y: 0, width: 800, height: 600 }; },
    clampToScreenVisual(x, y, width, height) { return { x, y, width, height }; },
    resolveDisplayState() { return "idle"; },
    getSvgOverride() { return null; },
    applyState(state) {
      this.currentState = state;
      stateLog.push(state);
    },
  };
}

describe("mini mode entry timing", () => {
  let loader;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
  });

  afterEach(() => {
    if (loader) loader.restore();
    mock.timers.reset();
    loader = null;
  });

  it("drag-snap entry slides to mini position first, then plays mini-enter", () => {
    loader = loadMiniWithElectron({
      getAllDisplays() {
        return [{ bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } }];
      },
    });
    const stateLog = [];
    const theme = cloneTheme(_defaultTheme);
    // Start away from the mini position so the 100ms slide is observable.
    const ctx = makeCtx(theme, stateLog, 600);
    const mini = loader.initMini(ctx);

    mini.enterMiniMode({ x: 0, y: 0, width: 800, height: 600 }, false, "right");

    // After the 100ms window slide: window is at mini position,
    // mini-enter has just been applied, enter animation is playing.
    mock.timers.tick(120);
    assert.deepStrictEqual(stateLog, ["mini-enter"]);
    assert.equal(ctx.getBoundsSnapshot().x, mini.getCurrentMiniX());
    assert.equal(mini.getMiniTransitioning(), true);

    // After the mini-enter animation settles (mocked to 1000ms).
    mock.timers.tick(1020);
    assert.deepStrictEqual(stateLog, ["mini-enter", "mini-idle"]);
    assert.equal(mini.getMiniTransitioning(), false);
    assert.equal(mini.getMiniMode(), true);
  });

  it("via-menu mini handoff preloads mini-enter offscreen before revealing the pet", () => {
    loader = loadMiniWithElectron({
      getAllDisplays() {
        return [{ bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } }];
      },
    });
    const stateLog = [];
    const theme = cloneTheme(_defaultTheme);
    const ctx = makeCtx(theme, stateLog, 710);
    const mini = loader.initMini(ctx);

    mini.enterMiniMode({ x: 0, y: 0, width: 800, height: 600 }, true, "right");
    mock.timers.tick(360);

    assert.deepStrictEqual(stateLog, ["mini-enter"]);
    assert.notEqual(ctx.getBoundsSnapshot().x, mini.getCurrentMiniX());
    assert.equal(mini.getMiniTransitioning(), true);

    mock.timers.tick(300);
    assert.equal(ctx.getBoundsSnapshot().x, mini.getCurrentMiniX());

    mock.timers.tick(1020);

    assert.deepStrictEqual(stateLog, ["mini-enter", "mini-idle"]);
    assert.equal(mini.getMiniTransitioning(), false);
    assert.equal(mini.getMiniMode(), true);
  });

  it("via-menu crabwalk tells renderer to flip edge without entering mini layout early", () => {
    loader = loadMiniWithElectron({
      getAllDisplays() {
        return [{ bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } }];
      },
    });
    const stateLog = [];
    const rendererEvents = [];
    const theme = cloneTheme(_defaultTheme);
    const ctx = makeCtx(theme, stateLog, 710);
    ctx.sendToRenderer = (...args) => rendererEvents.push(args);
    const mini = loader.initMini(ctx);

    mini.enterMiniViaMenu();

    assert.deepStrictEqual(stateLog, ["mini-crabwalk"]);
    assert.deepStrictEqual(rendererEvents[0], [
      "mini-mode-change",
      true,
      "right",
      { preEntry: true },
    ]);
    assert.equal(mini.getMiniMode(), false);
    assert.equal(mini.getMiniTransitioning(), true);
  });

  it("drag-snap still plays full mini-enter even when the cursor is over the pet", () => {
    loader = loadMiniWithElectron({
      getAllDisplays() {
        return [{ bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } }];
      },
    });
    const stateLog = [];
    const theme = cloneTheme(_defaultTheme);
    const rightMiniX = 800 - Math.round(120 * (1 - theme.miniMode.offsetRatio));
    const ctx = makeCtx(theme, stateLog, rightMiniX);
    ctx.mouseOverPet = true;
    const mini = loader.initMini(ctx);

    mini.enterMiniMode({ x: 0, y: 0, width: 800, height: 600 }, false, "right");
    mock.timers.tick(120);
    assert.deepStrictEqual(stateLog, ["mini-enter"]);

    mock.timers.tick(1020);
    assert.deepStrictEqual(stateLog, ["mini-enter", "mini-idle"]);
    assert.equal(mini.getMiniTransitioning(), false);
    assert.equal(mini.getMiniMode(), true);
  });

  it("clips right-edge mini rendering at an internal display seam when the theme opts in", () => {
    loader = loadMiniWithElectron({
      getAllDisplays() {
        return [
          { bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } },
          { bounds: { x: 800, y: 0, width: 800, height: 600 }, workArea: { x: 800, y: 0, width: 800, height: 600 } },
        ];
      },
    });
    const stateLog = [];
    const theme = cloneTheme(_defaultTheme);
    theme.miniMode.preventCrossDisplayCrop = true;
    const ctx = makeCtx(theme, stateLog, 600);
    const mini = loader.initMini(ctx);

    mini.enterMiniMode({ x: 0, y: 0, width: 800, height: 600 }, false, "right");
    mock.timers.tick(120);

    const visibleWidth = Math.round(120 * (1 - theme.miniMode.offsetRatio)) - SEAM_CROP_GUARD_PX;
    assert.deepStrictEqual(mini.getMiniRenderCrop(), {
      x: 0,
      y: 0,
      width: visibleWidth,
      height: 120,
    });
    assert.deepStrictEqual(ctx.getShapeLog().at(-1), [{
      x: 0,
      y: 0,
      width: visibleWidth,
      height: 120,
    }]);
  });

  it("clips left-edge mini rendering at an internal display seam when the theme opts in", () => {
    loader = loadMiniWithElectron({
      getAllDisplays() {
        return [
          { bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } },
          { bounds: { x: 800, y: 0, width: 800, height: 600 }, workArea: { x: 800, y: 0, width: 800, height: 600 } },
        ];
      },
    });
    const stateLog = [];
    const theme = cloneTheme(_defaultTheme);
    theme.miniMode.preventCrossDisplayCrop = true;
    const ctx = makeCtx(theme, stateLog, 900);
    const mini = loader.initMini(ctx);

    mini.enterMiniMode({ x: 800, y: 0, width: 800, height: 600 }, false, "left");
    mock.timers.tick(120);

    const hiddenWidth = Math.round(120 * theme.miniMode.offsetRatio) + SEAM_CROP_GUARD_PX;
    assert.deepStrictEqual(mini.getMiniRenderCrop(), {
      x: hiddenWidth,
      y: 0,
      width: 120 - hiddenWidth,
      height: 120,
    });
    assert.deepStrictEqual(ctx.getShapeLog().at(-1), [{
      x: hiddenWidth,
      y: 0,
      width: 120 - hiddenWidth,
      height: 120,
    }]);
  });

  it("does not crop mini rendering at an outer display edge", () => {
    loader = loadMiniWithElectron({
      getAllDisplays() {
        return [{ bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } }];
      },
    });
    const stateLog = [];
    const theme = cloneTheme(_defaultTheme);
    theme.miniMode.preventCrossDisplayCrop = true;
    const ctx = makeCtx(theme, stateLog, 600);
    const mini = loader.initMini(ctx);

    mini.enterMiniMode({ x: 0, y: 0, width: 800, height: 600 }, false, "right");
    mock.timers.tick(120);

    assert.equal(mini.getMiniRenderCrop(), null);
    assert.deepStrictEqual(ctx.getShapeLog().at(-1), [{ x: 0, y: 0, width: 120, height: 120 }]);
  });

  it("keeps legacy cross-display mini placement for themes that do not opt in", () => {
    loader = loadMiniWithElectron({
      getAllDisplays() {
        return [
          { bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } },
          { bounds: { x: 800, y: 0, width: 800, height: 600 }, workArea: { x: 800, y: 0, width: 800, height: 600 } },
        ];
      },
    });
    const stateLog = [];
    const theme = cloneTheme(_defaultTheme);
    const ctx = makeCtx(theme, stateLog, 600);
    const mini = loader.initMini(ctx);

    mini.enterMiniMode({ x: 0, y: 0, width: 800, height: 600 }, false, "right");
    mock.timers.tick(120);

    assert.equal(mini.getMiniRenderCrop(), null);
    assert.deepStrictEqual(ctx.getShapeLog().at(-1), [{ x: 0, y: 0, width: 120, height: 120 }]);
  });

  it("moves the right-edge render crop as hover peek pushes the mini window inward", () => {
    loader = loadMiniWithElectron({
      getAllDisplays() {
        return [
          { bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } },
          { bounds: { x: 800, y: 0, width: 800, height: 600 }, workArea: { x: 800, y: 0, width: 800, height: 600 } },
        ];
      },
    });
    const stateLog = [];
    const rendererEvents = [];
    const theme = cloneTheme(_defaultTheme);
    theme.miniMode.preventCrossDisplayCrop = true;
    const ctx = makeCtx(theme, stateLog, 600);
    ctx.sendToRenderer = (...args) => rendererEvents.push(args);
    const mini = loader.initMini(ctx);

    mini.enterMiniMode({ x: 0, y: 0, width: 800, height: 600 }, false, "right");
    mock.timers.tick(120);
    mini.miniPeekIn();
    mock.timers.tick(220);

    const visibleWidth = Math.round(120 * (1 - theme.miniMode.offsetRatio)) - SEAM_CROP_GUARD_PX;
    assert.deepStrictEqual(mini.getMiniRenderCrop(), {
      x: 0,
      y: 0,
      width: visibleWidth + mini.PEEK_OFFSET,
      height: 120,
    });
    assert.deepStrictEqual(rendererEvents.at(-1), [
      "mini-mode-change",
      true,
      "right",
      {
        crop: {
          x: 0,
          y: 0,
          width: visibleWidth + mini.PEEK_OFFSET,
          height: 120,
        },
      },
    ]);
  });

  it("moves the left-edge render crop as hover peek pushes the mini window inward", () => {
    loader = loadMiniWithElectron({
      getAllDisplays() {
        return [
          { bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } },
          { bounds: { x: 800, y: 0, width: 800, height: 600 }, workArea: { x: 800, y: 0, width: 800, height: 600 } },
        ];
      },
    });
    const stateLog = [];
    const rendererEvents = [];
    const theme = cloneTheme(_defaultTheme);
    theme.miniMode.preventCrossDisplayCrop = true;
    const ctx = makeCtx(theme, stateLog, 900);
    ctx.sendToRenderer = (...args) => rendererEvents.push(args);
    const mini = loader.initMini(ctx);

    mini.enterMiniMode({ x: 800, y: 0, width: 800, height: 600 }, false, "left");
    mock.timers.tick(120);
    mini.miniPeekIn();
    mock.timers.tick(220);

    const hiddenWidth = Math.round(120 * theme.miniMode.offsetRatio) + SEAM_CROP_GUARD_PX;
    assert.deepStrictEqual(mini.getMiniRenderCrop(), {
      x: hiddenWidth - mini.PEEK_OFFSET,
      y: 0,
      width: 120 - hiddenWidth + mini.PEEK_OFFSET,
      height: 120,
    });
    assert.deepStrictEqual(rendererEvents.at(-1), [
      "mini-mode-change",
      true,
      "left",
      {
        crop: {
          x: hiddenWidth - mini.PEEK_OFFSET,
          y: 0,
          width: 120 - hiddenWidth + mini.PEEK_OFFSET,
          height: 120,
        },
      },
    ]);
  });
});
