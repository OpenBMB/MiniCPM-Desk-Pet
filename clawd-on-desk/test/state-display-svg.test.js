const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert");
const path = require("path");

// Load default theme for test ctx
const themeLoader = require("../src/theme-loader");
themeLoader.init(path.join(__dirname, "..", "src"));
const _defaultTheme = themeLoader.loadTheme("cybercat");

function makeCtx() {
  const theme = structuredClone(_defaultTheme);
  theme.displayHintMap = {
    "cybercat-building.gif": "cybercat-building.gif",
    "cybercat-juggling.gif": "cybercat-juggling.gif",
    "cybercat-thinking.gif": "cybercat-thinking.gif",
  };
  return {
    theme,
    doNotDisturb: false,
    miniTransitioning: false,
    miniMode: false,
    mouseOverPet: false,
    idlePaused: false,
    forceEyeResend: false,
    mouseStillSince: Date.now(),
    playSound() {},
    sendToRenderer() {},
    syncHitWin() {},
    sendToHitWin() {},
    miniPeekIn() {},
    miniPeekOut() {},
    buildContextMenu() {},
    buildTrayMenu() {},
    pendingPermissions: [],
    resolvePermissionEntry() {},
    t: (k) => k,
    focusTerminalWindow() {},
  };
}

describe("display_svg session hints (updateSession path)", () => {
  let api;
  const pid = process.pid;

  beforeEach(() => {
    api = require("../src/state")(makeCtx());
  });

  function baseOpts(overrides = {}) {
    return {
      cwd: "/tmp",
      editor: "cursor",
      agentPid: pid,
      agentId: "cursor-agent",
      ...overrides,
    };
  }

  it("uses allowlisted display_svg for working state", () => {
    api.updateSession("c1", "working", "PreToolUse", baseOpts({ displayHint: "cybercat-building.gif" }));
    assert.strictEqual(api.getSvgOverride("working"), "cybercat-building.gif");
  });

  it("falls back to getWorkingSvg when no hint", () => {
    api.updateSession("c1", "working", "PreToolUse", baseOpts());
    assert.strictEqual(api.getSvgOverride("working"), "cybercat-working.gif");
  });

  it("ignores non-allowlisted svg and falls back", () => {
    api.updateSession("c1", "working", "PreToolUse", baseOpts({ displayHint: "evil.svg" }));
    assert.strictEqual(api.getSvgOverride("working"), "cybercat-working.gif");
  });

  it("picks the most recently updated session among working sessions", async () => {
    api.updateSession("a", "working", "PreToolUse", baseOpts({ cwd: "/a", displayHint: "cybercat-building.gif" }));
    await new Promise((r) => setTimeout(r, 5));
    api.updateSession("b", "working", "PostToolUse", baseOpts({ cwd: "/b", displayHint: "cybercat-juggling.gif" }));
    assert.strictEqual(api.getSvgOverride("working"), "cybercat-juggling.gif");
  });

  it("clears hint when display_svg is null", () => {
    api.updateSession("c1", "working", "PreToolUse", baseOpts({ displayHint: "cybercat-building.gif" }));
    assert.strictEqual(api.getSvgOverride("working"), "cybercat-building.gif");
    api.updateSession("c1", "working", "PostToolUse", baseOpts({ displayHint: null }));
    assert.strictEqual(api.getSvgOverride("working"), "cybercat-working.gif");
  });

  it("applies thinking hint for thinking state", () => {
    api.updateSession("c1", "thinking", "AfterAgentThought", baseOpts({ displayHint: "cybercat-thinking.gif" }));
    assert.strictEqual(api.getSvgOverride("thinking"), "cybercat-thinking.gif");
  });
});
