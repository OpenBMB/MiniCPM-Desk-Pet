const assert = require("node:assert");
const Module = require("node:module");
const { describe, it } = require("node:test");

const MENU_MODULE_PATH = require.resolve("../src/menu");

function loadMenuWithElectron(fakeElectron, fakeTaskbar = null) {
  delete require.cache[MENU_MODULE_PATH];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") return fakeElectron;
    if (fakeTaskbar && request === "./taskbar") return fakeTaskbar;
    return originalLoad.apply(this, arguments);
  };
  try {
    return require("../src/menu");
  } finally {
    Module._load = originalLoad;
  }
}

function fakeElectron() {
  return {
    app: { quit: () => {}, setActivationPolicy: () => {}, dock: { show: () => {}, hide: () => {} } },
    BrowserWindow: function BrowserWindow() {},
    Menu: {
      buildFromTemplate(template) {
        return { template };
      },
    },
    Tray: function Tray() {},
    nativeImage: {
      createFromPath() {
        return {
          resize() { return this; },
          setTemplateImage() {},
        };
      },
    },
    screen: {
      getAllDisplays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }],
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getDisplayNearestPoint: () => ({ id: 1 }),
    },
  };
}

function buildBaseCtx(overrides = {}) {
  return {
    win: { isDestroyed: () => false },
    sessions: new Map(),
    currentSize: "P:15",
    doNotDisturb: false,
    lang: "en",
    showTray: true,
    showDock: true,
    openAtLogin: false,
    bubbleFollowPet: false,
    hideBubbles: false,
    soundMuted: false,
    menuOpen: false,
    tray: null,
    contextMenuOwner: null,
    contextMenu: null,
    isQuitting: false,
    petHidden: false,
    getMiniMode: () => false,
    getMiniTransitioning: () => false,
    getDisableMiniMode: () => false,
    getActiveThemeCapabilities: () => ({ miniMode: true }),
    openDashboard: () => {},
    openSettingsWindow: () => {},
    togglePetVisibility: () => {},
    bringPetToPrimaryDisplay: () => {},
    enableDoNotDisturb: () => {},
    disableDoNotDisturb: () => {},
    enterMiniViaMenu: () => {},
    exitMiniMode: () => {},
    miniHandleResize: () => false,
    getPetWindowBounds: () => ({ x: 10, y: 20, width: 120, height: 120 }),
    applyPetWindowBounds: () => {},
    getCurrentPixelSize: () => ({ width: 200, height: 200 }),
    isProportionalMode: () => true,
    repositionBubbles: () => {},
    syncHitWin: () => {},
    flushRuntimeStateToPrefs: () => {},
    reapplyMacVisibility: () => {},
    clampToScreenVisual: (x, y) => ({ x, y }),
    ...overrides,
  };
}

describe("context menu hide pet action (#460)", () => {
  it("exposes a Hide Pet item right before Quit that toggles visibility", () => {
    const initMenu = loadMenuWithElectron(fakeElectron());
    let toggles = 0;
    const ctx = buildBaseCtx({
      togglePetVisibility: () => { toggles += 1; },
    });

    const menu = initMenu(ctx);
    menu.buildContextMenu();

    const labels = ctx.contextMenu.template.map((item) => item.label);
    const hideIdx = labels.indexOf("Hide Pet");
    const quitIdx = labels.indexOf("Quit");
    assert.ok(hideIdx !== -1, "context menu should expose Hide Pet");
    assert.strictEqual(quitIdx, labels.length - 1, "Quit should stay the last item");
    assert.strictEqual(hideIdx, quitIdx - 2, "Hide Pet should sit just above Quit");
    assert.strictEqual(ctx.contextMenu.template[hideIdx + 1].type, "separator");

    ctx.contextMenu.template[hideIdx].click();
    assert.strictEqual(toggles, 1);
  });

  it("labels the item Show Pet while the pet is hidden", () => {
    const initMenu = loadMenuWithElectron(fakeElectron());
    const ctx = buildBaseCtx({ petHidden: true });

    const menu = initMenu(ctx);
    menu.buildContextMenu();

    const labels = ctx.contextMenu.template.map((item) => item.label);
    assert.ok(labels.includes("Show Pet"), "hidden pet should flip the label to Show Pet");
    assert.ok(!labels.includes("Hide Pet"));
  });

  it("popup close callback does not resurrect a pet the menu just hid", () => {
    let ownerWindow = null;
    const electron = fakeElectron();
    electron.BrowserWindow = function BrowserWindow() {
      ownerWindow = {
        isDestroyed: () => false,
        loadURL: () => {},
        on: () => {},
        setBounds: () => {},
        show: () => {},
        focus: () => {},
        hide: () => {},
      };
      return ownerWindow;
    };
    const keepCalls = [];
    const initMenu = loadMenuWithElectron(electron, {
      keepOutOfTaskbar: (win) => keepCalls.push(win),
    });

    let restoredPet = false;
    const ctx = buildBaseCtx({
      win: {
        isDestroyed: () => false,
        showInactive: () => { restoredPet = true; },
        setAlwaysOnTop: () => {},
      },
    });

    initMenu(ctx).popupMenuAt({
      popup({ callback }) {
        // Simulate the Hide Pet click landing before the close callback.
        ctx.petHidden = true;
        callback();
      },
    });

    assert.strictEqual(restoredPet, false, "hidden pet must stay hidden after the menu closes");
    assert.deepStrictEqual(keepCalls, [ownerWindow], "only the owner window should be re-asserted");
  });
});
