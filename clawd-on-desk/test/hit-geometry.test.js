const { describe, it } = require("node:test");
const assert = require("node:assert");

const hitGeometry = require("../src/hit-geometry");

function approx(actual, expected, epsilon = 0.01) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`
  );
}

describe("hit geometry", () => {
  const bounds = { x: 0, y: 0, width: 200, height: 200 };

  it("resolves root, mini, and per-file viewBoxes in priority order", () => {
    const rootViewBox = { x: -32, y: -24, width: 88, height: 72 };
    const miniViewBox = { x: -12, y: -12, width: 48, height: 48 };
    const theme = {
      viewBox: rootViewBox,
      miniMode: { viewBox: miniViewBox },
      fileViewBoxes: {
        "cloudling-mini-crabwalk.svg": rootViewBox,
      },
    };

    assert.deepStrictEqual(
      hitGeometry.resolveViewBox(theme, "working", "cloudling-building.svg"),
      rootViewBox
    );
    assert.deepStrictEqual(
      hitGeometry.resolveViewBox(theme, "mini-idle", "cloudling-mini-idle.svg"),
      miniViewBox
    );
    assert.deepStrictEqual(
      hitGeometry.resolveViewBox(theme, "mini-crabwalk", "cloudling-mini-crabwalk.svg"),
      rootViewBox
    );
  });

  it("uses normal layout for mini-named files that explicitly override to the root viewBox", () => {
    const rootViewBox = { x: -32, y: -24, width: 88, height: 72 };
    const theme = {
      viewBox: rootViewBox,
      miniMode: { viewBox: { x: -12, y: -12, width: 48, height: 48 } },
      fileViewBoxes: {
        "cloudling-mini-crabwalk.svg": rootViewBox,
      },
      layout: {
        contentBox: { x: 0, y: 0, width: 24, height: 24 },
        centerX: 12,
        baselineY: 24,
        centerXRatio: 0.5,
        baselineBottomRatio: 0.05,
        visibleHeightRatio: 0.58,
      },
      objectScale: { widthRatio: 1, heightRatio: 1, offsetX: 0, offsetY: 0, objBottom: 0.05 },
      eyeTracking: { enabled: false, states: [] },
      trustedRuntime: { scriptedSvgFiles: ["cloudling-mini-crabwalk.svg"] },
      _builtin: true,
    };

    assert.strictEqual(
      hitGeometry.usesNormalizedLayout(theme, "mini-crabwalk", "cloudling-mini-crabwalk.svg"),
      true
    );
    assert.strictEqual(
      hitGeometry.usesNormalizedLayout(theme, "mini-idle", "cloudling-mini-idle.svg"),
      false
    );

    const rect = hitGeometry.getAssetRectScreen(
      theme,
      bounds,
      "mini-crabwalk",
      "cloudling-mini-crabwalk.svg"
    );

    approx(rect.w, 425.33);
    approx(rect.h, 348);
  });

  it("uses trusted built-in scripted SVGs as object-channel geometry without treating external data as trusted", () => {
    const trustedTheme = {
      _builtin: true,
      viewBox: { x: -32, y: -24, width: 88, height: 72 },
      miniMode: { viewBox: { x: -12, y: -12, width: 48, height: 48 } },
      fileViewBoxes: {},
      objectScale: { widthRatio: 1, heightRatio: 1, offsetX: 0, offsetY: 0, objBottom: 0 },
      eyeTracking: { enabled: false, states: [] },
      trustedRuntime: { scriptedSvgFiles: ["cloudling-building.svg"] },
    };
    const externalTheme = {
      ...trustedTheme,
      _builtin: false,
      trustedRuntime: { scriptedSvgFiles: ["cloudling-building.svg"] },
    };

    assert.strictEqual(
      hitGeometry.usesObjectChannel(trustedTheme, "working", "cloudling-building.svg"),
      true
    );
    assert.strictEqual(
      hitGeometry.usesObjectChannel(externalTheme, "working", "cloudling-building.svg"),
      false
    );

    const rect = hitGeometry.getAssetRectScreen(
      trustedTheme,
      bounds,
      "working",
      "cloudling-building.svg"
    );

    approx(rect.x, 0);
    approx(rect.y, 18.18);
    approx(rect.w, 200);
    approx(rect.h, 163.64);
  });

  it("keeps ordinary external SVG themes on the legacy non-object path by default", () => {
    const theme = {
      _builtin: false,
      viewBox: { x: 0, y: 0, width: 192, height: 208 },
      fileViewBoxes: {},
      objectScale: { widthRatio: 1, heightRatio: 1, offsetX: 0, offsetY: 0, objBottom: 0 },
      eyeTracking: { enabled: false, states: [] },
      trustedRuntime: { scriptedSvgFiles: [] },
      rendering: { svgChannel: "auto" },
    };

    assert.strictEqual(
      hitGeometry.usesObjectChannel(theme, "idle", "ordinary-idle.svg"),
      false
    );
  });

  it("uses object-channel geometry when a theme forces SVG object rendering", () => {
    const theme = {
      _builtin: false,
      viewBox: { x: 0, y: 0, width: 192, height: 208 },
      fileViewBoxes: {},
      objectScale: { widthRatio: 1, heightRatio: 1, offsetX: 0, offsetY: 0, objBottom: 0 },
      eyeTracking: { enabled: false, states: [] },
      trustedRuntime: { scriptedSvgFiles: [] },
      rendering: { svgChannel: "object" },
    };

    assert.strictEqual(
      hitGeometry.usesObjectChannel(theme, "idle", "codex-pet-idle-loop.svg"),
      true
    );

    const rect = hitGeometry.getAssetRectScreen(
      theme,
      bounds,
      "idle",
      "codex-pet-idle-loop.svg"
    );

    approx(rect.x, 7.69);
    approx(rect.y, 0);
    approx(rect.w, 184.62);
    approx(rect.h, 200);
  });

  it("maps screen cursor points into the active asset viewBox for pointer bridge payloads", () => {
    const theme = {
      _builtin: true,
      viewBox: { x: -32, y: -24, width: 88, height: 72 },
      miniMode: { viewBox: { x: -12, y: -12, width: 48, height: 48 } },
      fileViewBoxes: {},
      objectScale: { widthRatio: 1, heightRatio: 1, offsetX: 0, offsetY: 0, objBottom: 0 },
      eyeTracking: { enabled: false, states: [] },
      trustedRuntime: { scriptedSvgFiles: ["cloudling-mini-idle.svg"] },
    };
    const rect = hitGeometry.getAssetRectScreen(
      theme,
      bounds,
      "mini-idle",
      "cloudling-mini-idle.svg"
    );
    const payload = hitGeometry.getAssetPointerPayload(
      theme,
      bounds,
      "mini-idle",
      "cloudling-mini-idle.svg",
      { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }
    );
    const outside = hitGeometry.getAssetPointerPayload(
      theme,
      bounds,
      "mini-idle",
      "cloudling-mini-idle.svg",
      { x: rect.x - 1, y: rect.y + rect.h / 2 }
    );

    approx(payload.x, 12);
    approx(payload.y, 12);
    assert.strictEqual(payload.inside, true);
    assert.strictEqual(outside.inside, false);
  });
});
