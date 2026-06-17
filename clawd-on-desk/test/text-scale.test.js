"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const {
  TEXT_SCALE_MIN,
  TEXT_SCALE_MAX,
  TEXT_SCALE_DEFAULT,
  TEXT_SCALE_STEP,
  TEXT_SCALE_MAX_DISPLAY_ENTRIES,
  isValidTextScale,
  clampTextScale,
  scaleWidth,
  scaleHeight,
  applyZoomToWindow,
  resolveTextScaleForKey,
  normalizeTextScaleByDisplay,
  textScaleToUiPercent,
  uiPercentToTextScale,
} = require("../src/text-scale");

describe("text-scale clamp and validation", () => {
  it("accepts the full supported range", () => {
    assert.strictEqual(isValidTextScale(0.8), true);
    assert.strictEqual(isValidTextScale(1), true);
    assert.strictEqual(isValidTextScale(1.6), true);
  });

  it("rejects out-of-range and non-numeric values", () => {
    assert.strictEqual(isValidTextScale(0.79), false);
    assert.strictEqual(isValidTextScale(1.61), false);
    assert.strictEqual(isValidTextScale(NaN), false);
    assert.strictEqual(isValidTextScale("1.2"), false);
    assert.strictEqual(isValidTextScale(null), false);
  });

  it("clamps to bounds and falls back to default on garbage", () => {
    assert.strictEqual(clampTextScale(0.5), TEXT_SCALE_MIN);
    assert.strictEqual(clampTextScale(3), TEXT_SCALE_MAX);
    assert.strictEqual(clampTextScale(1.25), 1.25);
    assert.strictEqual(clampTextScale(NaN), TEXT_SCALE_DEFAULT);
    assert.strictEqual(clampTextScale(undefined), TEXT_SCALE_DEFAULT);
    assert.strictEqual(clampTextScale("not a number"), TEXT_SCALE_DEFAULT);
  });
});

describe("text-scale DIP conversion", () => {
  it("is the identity at 100%", () => {
    assert.strictEqual(scaleWidth(340, 1), 340);
    assert.strictEqual(scaleHeight(212, 1), 212);
  });

  it("keeps the 340 bubble base width integral at every 5% step", () => {
    // CSS viewport width must stay exactly 340 at every slider stop so cached
    // renderer-side measurements survive scale changes without re-measuring.
    for (let pct = 80; pct <= 160; pct += 5) {
      const scale = pct / 100;
      const exact = (340 * pct) / 100;
      // 340 × pct is divisible by 100 at every 5% stop, so the rounded DIP
      // width is mathematically exact (IEEE754 noise stays far below 1e-6).
      assert.ok(
        Math.abs(340 * scale - exact) < 1e-6,
        `340 × ${pct}% must be integral up to float noise`,
      );
      assert.strictEqual(scaleWidth(340, scale), exact);
    }
  });

  it("ceils heights so scaled content is never clipped", () => {
    assert.strictEqual(scaleHeight(201, 1.05), Math.ceil(201 * 1.05));
    assert.strictEqual(scaleHeight(333, 0.85), Math.ceil(333 * 0.85));
  });

  it("clamps the scale before converting", () => {
    assert.strictEqual(scaleWidth(340, 99), 340 * TEXT_SCALE_MAX);
    assert.strictEqual(scaleHeight(100, NaN), 100);
  });
});

describe("text-scale slider mapping", () => {
  it("round-trips every slider stop", () => {
    for (let pct = 80; pct <= 160; pct += 5) {
      assert.strictEqual(textScaleToUiPercent(uiPercentToTextScale(pct)), pct);
    }
  });

  it("normalizes invalid percent input to the default", () => {
    assert.strictEqual(uiPercentToTextScale("abc"), TEXT_SCALE_DEFAULT);
    assert.strictEqual(uiPercentToTextScale(NaN), TEXT_SCALE_DEFAULT);
  });

  it("exposes the step constant", () => {
    assert.strictEqual(TEXT_SCALE_STEP, 0.05);
  });
});

describe("per-display resolution", () => {
  it("prefers the display entry and falls back to the legacy global", () => {
    const map = { "1": 1.35, "2": 0.9 };
    assert.strictEqual(resolveTextScaleForKey(map, 1.1, "1"), 1.35);
    assert.strictEqual(resolveTextScaleForKey(map, 1.1, "2"), 0.9);
    assert.strictEqual(resolveTextScaleForKey(map, 1.1, "3"), 1.1);
    assert.strictEqual(resolveTextScaleForKey(map, 1.1, null), 1.1);
    assert.strictEqual(resolveTextScaleForKey(null, 1.1, "1"), 1.1);
  });

  it("clamps both entry and fallback values", () => {
    assert.strictEqual(resolveTextScaleForKey({ "1": 99 }, 1, "1"), TEXT_SCALE_MAX);
    assert.strictEqual(resolveTextScaleForKey({}, NaN, "1"), TEXT_SCALE_DEFAULT);
  });

  it("normalizes the map: drops invalid keys/values and caps entries", () => {
    const normalized = normalizeTextScaleByDisplay({
      "1": 1.35,
      "": 1.2,
      "2": 99,
      "3": "1.2",
      "4": 0.8,
    });
    assert.deepStrictEqual(normalized, { "1": 1.35, "4": 0.8 });

    const oversized = {};
    for (let i = 0; i < TEXT_SCALE_MAX_DISPLAY_ENTRIES + 5; i++) oversized[`d${i}`] = 1.2;
    assert.strictEqual(
      Object.keys(normalizeTextScaleByDisplay(oversized)).length,
      TEXT_SCALE_MAX_DISPLAY_ENTRIES,
    );

    assert.deepStrictEqual(normalizeTextScaleByDisplay(null), {});
    assert.deepStrictEqual(normalizeTextScaleByDisplay([1.2]), {});
  });
});

describe("applyZoomToWindow", () => {
  function makeWindow({ destroyed = false, throws = false, rejectInsert = () => false } = {}) {
    const factorCalls = [];
    const cssCalls = [];
    const removedKeys = [];
    const listeners = {};
    let nextKey = 1;
    const wc = {
      isDestroyed: () => false,
      on(event, handler) {
        listeners[event] = listeners[event] || [];
        listeners[event].push(handler);
      },
      setZoomFactor(factor) {
        if (throws) throw new Error("boom");
        factorCalls.push(factor);
      },
      insertCSS(css) {
        cssCalls.push(css);
        if (rejectInsert(css)) return Promise.reject(new Error("page not loaded"));
        return Promise.resolve(`key-${nextKey++}`);
      },
      removeInsertedCSS(key) {
        removedKeys.push(key);
        return Promise.resolve();
      },
    };
    return {
      factorCalls,
      cssCalls,
      removedKeys,
      listeners,
      isDestroyed: () => destroyed,
      webContents: wc,
    };
  }

  function settle() {
    return new Promise((resolve) => setImmediate(resolve));
  }

  it("neutralizes the shared zoom map and inserts a root zoom stylesheet (CSP-immune)", async () => {
    const win = makeWindow();
    assert.strictEqual(applyZoomToWindow(win, 1.25), true);
    await settle();
    assert.deepStrictEqual(win.factorCalls, [1]);
    assert.deepStrictEqual(win.cssCalls, [":root { zoom: 1.25 !important; --clawd-text-zoom: 1.25; }"]);
  });

  it("memoizes per webContents and swaps the stylesheet on a changed value", async () => {
    const win = makeWindow();
    applyZoomToWindow(win, 1.25);
    applyZoomToWindow(win, 1.25);
    await settle();
    assert.strictEqual(win.cssCalls.length, 1);
    applyZoomToWindow(win, 1.4);
    await settle();
    assert.strictEqual(win.cssCalls.length, 2);
    assert.strictEqual(win.cssCalls[1], ":root { zoom: 1.4 !important; --clawd-text-zoom: 1.4; }");
    assert.deepStrictEqual(win.removedKeys, ["key-1"], "previous sheet must be removed");
  });

  it("still injects explicitly at the default scale", async () => {
    const win = makeWindow();
    assert.strictEqual(applyZoomToWindow(win, 1), true);
    await settle();
    assert.deepStrictEqual(win.cssCalls, [":root { zoom: 1 !important; --clawd-text-zoom: 1; }"]);
  });

  it("is safe on destroyed/missing windows and swallows setter errors", () => {
    assert.strictEqual(applyZoomToWindow(null, 1.2), false);
    assert.strictEqual(applyZoomToWindow(makeWindow({ destroyed: true }), 1.2), false);
    assert.strictEqual(applyZoomToWindow({ isDestroyed: () => false }, 1.2), false);
    assert.strictEqual(applyZoomToWindow(makeWindow({ throws: true }), 1.2), false);
  });

  it("rolls the memo back on injection failure so the next call re-injects", async () => {
    // Regression: a rejected pre-load injection must not poison the memo, or
    // the did-finish-load re-apply gets skipped and a scaled window keeps
    // unzoomed content (HUD "very long" / clipped symptoms).
    let shouldReject = true;
    const win = makeWindow({ rejectInsert: () => shouldReject });

    assert.strictEqual(applyZoomToWindow(win, 1.35), true);
    await settle();
    shouldReject = false;
    assert.strictEqual(applyZoomToWindow(win, 1.35), true);
    await settle();
    assert.strictEqual(win.cssCalls.length, 2, "same value must re-inject after a failure");

    assert.strictEqual(applyZoomToWindow(win, 1.35), true);
    await settle();
    assert.strictEqual(win.cssCalls.length, 2, "successful injection memoizes again");
  });

  it("clears the memo on reload so the zoom is re-applied to the fresh document", async () => {
    const win = makeWindow();
    applyZoomToWindow(win, 1.35);
    await settle();
    assert.strictEqual(win.cssCalls.length, 1);

    for (const handler of win.listeners["did-finish-load"] || []) handler();
    assert.strictEqual(applyZoomToWindow(win, 1.35), true);
    await settle();
    assert.strictEqual(win.cssCalls.length, 2, "reload must trigger a fresh injection");
  });

  it("serializes rapid value changes and keeps exactly one live sheet", async () => {
    const win = makeWindow();
    applyZoomToWindow(win, 1.2);
    applyZoomToWindow(win, 1.3);
    applyZoomToWindow(win, 1.4);
    await settle();
    await settle();
    await settle();
    assert.deepStrictEqual(win.cssCalls, [
      ":root { zoom: 1.2 !important; --clawd-text-zoom: 1.2; }",
      ":root { zoom: 1.3 !important; --clawd-text-zoom: 1.3; }",
      ":root { zoom: 1.4 !important; --clawd-text-zoom: 1.4; }",
    ]);
    assert.deepStrictEqual(win.removedKeys, ["key-1", "key-2"], "only the newest sheet survives");
  });
});
