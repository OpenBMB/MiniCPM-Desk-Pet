const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const updateBubble = fs.readFileSync(path.join(__dirname, "..", "src", "update-bubble.html"), "utf8");

describe("update bubble visual style", () => {
  it("matches the permission bubble's core card styling tokens", () => {
    assert.match(updateBubble, /body \{ padding: 6px; \}/);
    assert.doesNotMatch(updateBubble, /body \{ padding: 0; \}/);
    assert.match(updateBubble, /border-radius: 16px;/);
    assert.match(updateBubble, /padding: 16px 20px;/);
    assert.match(updateBubble, /gap: 8px;/);
    assert.match(updateBubble, /box-shadow: var\(--card-shadow\), var\(--card-inset, none\);/);
    assert.match(updateBubble, /transition: opacity 0\.35s var\(--ease-spring\), transform 0\.4s var\(--ease-spring\);/);
  });

  it("uses permission-style detail and button treatments", () => {
    assert.match(updateBubble, /font-family: "SF Mono", "ui-monospace", "Cascadia Code", "Fira Code", monospace;/);
    assert.match(updateBubble, /border-radius: 10px;/);
    assert.match(updateBubble, /box-shadow: var\(--cmd-shadow\);/);
    assert.match(updateBubble, /--primary-bg: #373ED8;/);
    assert.match(updateBubble, /\.btn-primary \{[\s\S]*background: var\(--primary-bg\);[\s\S]*\}/);
    assert.match(updateBubble, /\.btn-secondary \{[\s\S]*background: var\(--deny-bg\);[\s\S]*\}/);
  });

  it("gives checking and available bubbles a permission-style footprint", () => {
    assert.match(updateBubble, /<div class="summary" id="summary">/);
    assert.match(updateBubble, /\.card\[data-mode="checking"\],\s*\.card\[data-mode="available"\] \{/);
    assert.match(updateBubble, /min-height: 134px;/);
    assert.match(updateBubble, /\.card\[data-mode="checking"\] \.summary,\s*\.card\[data-mode="available"\] \.summary \{/);
    assert.match(updateBubble, /background: var\(--cmd-bg\);/);
    assert.match(updateBubble, /border: 1px solid var\(--cmd-border\);/);
  });

  it("reports height including the body padding so rounded corners are not clipped", () => {
    assert.match(updateBubble, /body \{ padding: 6px; \}/);
    assert.match(updateBubble, /window\.updateBubbleAPI\.reportHeight\(card\.offsetHeight \+ 16\);/);
  });
});
