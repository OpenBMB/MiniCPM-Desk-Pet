const { describe, it } = require("node:test");
const assert = require("node:assert");

const hitGeometry = require("../src/hit-geometry");
const {
  getThemeMarginBox,
  computeThemeAnchorRect,
  collectThemeEnvelopeFiles,
  computeStableVisibleContentMargins,
  getLooseDragMargins,
  getRestClampMargins,
} = require("../src/visible-margins");

function makeLayoutTheme(overrides = {}) {
  return {
    viewBox: { x: -15, y: -25, width: 45, height: 45 },
    layout: {
      contentBox: { x: -4, y: -3, width: 23, height: 20 },
      marginBox: { x: -8, y: -7, width: 30, height: 24 },
      centerX: 7.5,
      baselineY: 17,
      visibleHeightRatio: 0.58,
      baselineBottomRatio: 0.05,
    },
    states: {
      idle: ["theme-idle.svg"],
      thinking: ["theme-thinking.svg"],
      notification: ["theme-notification.svg"],
    },
    reactions: { drag: { file: "theme-react-drag.svg" } },
    objectScale: { widthRatio: 1.9, heightRatio: 1.3, offsetX: -0.45, offsetY: -0.25 },
    eyeTracking: { enabled: true, states: ["idle"] },
    hitBoxes: {
      default: { x: -1, y: 5, w: 17, h: 12 },
      wide: { x: -2, y: 4, w: 19, h: 14 },
    },
    wideHitboxFiles: ["theme-notification.svg"],
    ...overrides,
  };
}

describe("visible margin envelopes", () => {
  const bounds = { x: 0, y: 0, width: 280, height: 280 };

  it("prefers layout.marginBox over contentBox when present", () => {
    const theme = makeLayoutTheme();
    assert.deepStrictEqual(getThemeMarginBox(theme), theme.layout.marginBox);

    const idleFile = theme.states.idle[0];
    const contentRect = hitGeometry.getContentRectScreen(theme, bounds, "idle", idleFile, {
      box: theme.layout.contentBox,
    });
    const marginRect = hitGeometry.getContentRectScreen(theme, bounds, "idle", idleFile, {
      box: theme.layout.marginBox,
    });

    assert.ok(marginRect.top < contentRect.top);
    assert.strictEqual(
      Math.round(bounds.y + bounds.height - marginRect.bottom),
      Math.round(bounds.y + bounds.height - contentRect.bottom)
    );
  });

  it("collects a non-mini envelope file set", () => {
    const theme = makeLayoutTheme();
    const files = collectThemeEnvelopeFiles(theme);

    assert.ok(files.includes("theme-thinking.svg"));
    assert.ok(files.includes("theme-react-drag.svg"));
    assert.ok(!files.includes("theme-mini-idle.svg"));
    assert.ok(!files.some((file) => file.startsWith("mini-")));
  });

  it("uses the minimum top and bottom margins across a theme envelope", () => {
    const theme = makeLayoutTheme();
    const stable = computeStableVisibleContentMargins(theme, bounds);
    const again = computeStableVisibleContentMargins(theme, bounds);

    assert.deepStrictEqual(stable, again);
    assert.ok(stable.top >= 0);
    assert.ok(stable.bottom >= 0);
  });

  it("builds the update anchor from marginBox and the idle file", () => {
    const theme = makeLayoutTheme();
    const expected = hitGeometry.getContentRectScreen(theme, bounds, "idle", theme.states.idle[0], {
      box: theme.layout.marginBox,
    });

    assert.deepStrictEqual(computeThemeAnchorRect(theme, bounds), expected);
  });

  it("prefers updateBubbleAnchorBox over layout-derived boxes when present", () => {
    const theme = structuredClone(makeLayoutTheme());
    theme.updateBubbleAnchorBox = { x: -2, y: -1, width: 12, height: 11 };

    assert.deepStrictEqual(
      computeThemeAnchorRect(theme, bounds),
      hitGeometry.getContentRectScreen(theme, bounds, "idle", theme.states.idle[0], {
        box: theme.updateBubbleAnchorBox,
      })
    );
  });

  it("keeps a stable update anchor even though per-state hit bottoms differ", () => {
    const theme = makeLayoutTheme({
      hitBoxes: {
        default: { x: -1, y: 5, w: 17, h: 12 },
        wide: { x: -1, y: 2, w: 17, h: 18 },
      },
      wideHitboxFiles: ["theme-notification.svg"],
    });
    const anchor = computeThemeAnchorRect(theme, bounds);
    const thinkingHit = hitGeometry.getHitRectScreen(
      theme,
      bounds,
      "thinking",
      "theme-thinking.svg",
      theme.hitBoxes.default
    );
    const notificationHit = hitGeometry.getHitRectScreen(
      theme,
      bounds,
      "notification",
      "theme-notification.svg",
      theme.hitBoxes.wide
    );

    assert.ok(Number.isFinite(thinkingHit.bottom));
    assert.ok(Number.isFinite(notificationHit.bottom));
    assert.notStrictEqual(Math.round(thinkingHit.bottom), Math.round(notificationHit.bottom));
    assert.deepStrictEqual(
      anchor,
      hitGeometry.getContentRectScreen(theme, bounds, "idle", theme.states.idle[0], {
        box: theme.layout.marginBox,
      })
    );
  });

  it("returns null for the update anchor when the theme has no layout", () => {
    const theme = structuredClone(makeLayoutTheme());
    delete theme.layout;
    assert.strictEqual(computeThemeAnchorRect(theme, bounds), null);
  });

  it("still returns an anchor without layout when updateBubbleAnchorBox is present", () => {
    const theme = structuredClone(makeLayoutTheme());
    delete theme.layout;
    theme.updateBubbleAnchorBox = { x: 0, y: 0, width: 20, height: 10 };

    assert.deepStrictEqual(
      computeThemeAnchorRect(theme, bounds),
      hitGeometry.getContentRectScreen(theme, bounds, "idle", theme.states.idle[0], {
        box: theme.updateBubbleAnchorBox,
      })
    );
  });
});

describe("edge pinning margin policy", () => {
  it("keeps OFF drag bottom rubber band but caps total top overflow at half the window", () => {
    const margins = getLooseDragMargins({
      width: 200,
      height: 280,
      visibleMargins: { top: 100, bottom: 50 },
      allowEdgePinning: false,
    });

    assert.deepStrictEqual(margins, {
      marginX: 50,
      marginTop: 140, // capped to round(280 * 0.5)
      marginBottom: 70, // round(280 * 0.25), bottom drag OFF ignores visibleMargins.bottom
    });
  });

  it("OFF drag keeps the full 0.25h top overshoot when headroom is modest", () => {
    const margins = getLooseDragMargins({
      width: 200,
      height: 280,
      visibleMargins: { top: 40, bottom: 50 },
      allowEdgePinning: false,
    });

    assert.deepStrictEqual(margins, {
      marginX: 50,
      marginTop: 110, // 40 + round(280 * 0.25)
      marginBottom: 70,
    });
  });

  it("OFF drag stops adding extra top overshoot once rest headroom already exceeds half the window", () => {
    const margins = getLooseDragMargins({
      width: 200,
      height: 280,
      visibleMargins: { top: 170, bottom: 50 },
      allowEdgePinning: false,
    });

    assert.deepStrictEqual(margins, {
      marginX: 50,
      marginTop: 170,
      marginBottom: 70,
    });
  });

  it("ON drag uses height ratios 0.6/0.25 (Peter hitRect parity) regardless of visibleMargins", () => {
    const margins = getLooseDragMargins({
      width: 200,
      height: 280,
      visibleMargins: { top: 100, bottom: 50 }, // should be ignored when ON
      allowEdgePinning: true,
    });

    assert.deepStrictEqual(margins, {
      marginX: 50,
      marginTop: 168, // round(280 * 0.6)
      marginBottom: 70, // round(280 * 0.25)
    });
  });

  it("ON drag caps bottom slack by display inset", () => {
    const margins = getLooseDragMargins({
      width: 200,
      height: 280,
      visibleMargins: { top: 100, bottom: 50 },
      allowEdgePinning: true,
      bottomInset: 48,
    });

    assert.deepStrictEqual(margins, {
      marginX: 50,
      marginTop: 168,
      marginBottom: 48,
    });
  });

  it("OFF rest clamp keeps the visibleMargins verbatim", () => {
    assert.deepStrictEqual(
      getRestClampMargins({
        height: 280,
        visibleMargins: { top: 22, bottom: 14 },
        allowEdgePinning: false,
      }),
      { top: 22, bottom: 14 }
    );
  });

  it("ON rest clamp matches ON drag (no rubber-band bounce-back)", () => {
    const height = 280;
    const drag = getLooseDragMargins({
      width: 200,
      height,
      visibleMargins: { top: 22, bottom: 14 },
      allowEdgePinning: true,
    });
    const rest = getRestClampMargins({
      height,
      visibleMargins: { top: 22, bottom: 14 },
      allowEdgePinning: true,
    });

    assert.strictEqual(rest.top, drag.marginTop);
    assert.strictEqual(rest.bottom, drag.marginBottom);
    assert.deepStrictEqual(rest, { top: 168, bottom: 70 });
  });

  it("ON rest clamp caps bottom slack by display inset", () => {
    assert.deepStrictEqual(
      getRestClampMargins({
        height: 280,
        visibleMargins: { top: 500, bottom: 500 },
        allowEdgePinning: true,
        bottomInset: 48,
      }),
      { top: 168, bottom: 48 }
    );
  });

  it("ON cap uses the smaller of ratio and inset", () => {
    assert.deepStrictEqual(
      getRestClampMargins({
        height: 280,
        visibleMargins: { top: 500, bottom: 500 },
        allowEdgePinning: true,
        bottomInset: 120,
      }),
      { top: 168, bottom: 70 }
    );
  });

  it("ON bottom can clamp fully to zero when no physical inset is available", () => {
    const drag = getLooseDragMargins({
      width: 200,
      height: 280,
      visibleMargins: { top: 22, bottom: 14 },
      allowEdgePinning: true,
      bottomInset: 0,
    });
    const rest = getRestClampMargins({
      height: 280,
      visibleMargins: { top: 22, bottom: 14 },
      allowEdgePinning: true,
      bottomInset: 0,
    });

    assert.strictEqual(drag.marginBottom, 0);
    assert.strictEqual(rest.bottom, 0);
  });

  it("ON rest clamp ignores visibleMargins and uses height ratios", () => {
    assert.deepStrictEqual(
      getRestClampMargins({
        height: 280,
        visibleMargins: { top: 500, bottom: 500 }, // should be ignored
        allowEdgePinning: true,
      }),
      { top: 168, bottom: 70 }
    );
  });
});
