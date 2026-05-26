"use strict";

const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const themeLoader = require("../src/theme-loader");
themeLoader.init(path.join(__dirname, "..", "src"));
const _defaultTheme = themeLoader.loadTheme("cybercat");

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
});
