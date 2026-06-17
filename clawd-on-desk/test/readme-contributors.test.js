"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const ALL_READMES = [
  "README.md",
  "README.zh-CN.md",
  "README.zh-TW.md",
  "README.ko-KR.md",
  "README.ja-JP.md",
];

function readReadme(filename) {
  return fs.readFileSync(path.join(ROOT, filename), "utf8");
}

test("README files keep MiniCPM Desk Pet as the product identity", () => {
  for (const filename of ALL_READMES) {
    const markdown = readReadme(filename);
    assert.match(markdown, /<h1 align="center">MiniCPM Desk Pet<\/h1>/, `${filename} should use the MiniCPM product title`);
    assert.ok(markdown.includes("assets/tray-icon.png"), `${filename} should use the MiniCPM tray icon asset`);
    assert.ok(markdown.includes("MiniCPM5-1B-GGUF"), `${filename} should describe the MiniCPM model`);
    assert.ok(markdown.includes("OpenBMB/MiniCPM-Desk-Pet"), `${filename} should link to the OpenBMB repository or releases`);
  }
});

test("README files do not regress to upstream Clawd product copy", () => {
  const forbidden = [
    /<h1[^>]*>Clawd(?: on Desk| 桌宠| 桌寵)?<\/h1>/i,
    /Clawd lives on your desktop/i,
    /Clawd 住在你的桌面上/,
    /像素螃蟹/,
    /pixel crab/i,
    /Clawd-on-Desk-Setup/i,
    /awesome-claude-code/i,
    /Anthropic/i,
  ];

  for (const filename of ALL_READMES) {
    const markdown = readReadme(filename);
    for (const pattern of forbidden) {
      assert.doesNotMatch(markdown, pattern, `${filename} should not contain upstream product copy: ${pattern}`);
    }
  }
});

test("README files keep remote and human-control features gated off by default", () => {
  const gatedFeatures = [
    "Telegram",
    "Direct Send",
    "mobile PWA",
    "Hardware Buddy",
    "auto-pilot",
  ];

  for (const filename of ALL_READMES) {
    const markdown = readReadme(filename);
    for (const feature of gatedFeatures) {
      assert.ok(markdown.includes(feature), `${filename} should mention ${feature}`);
    }
    assert.match(markdown, /default|默认|預設|既定|기본/i, `${filename} should document default gating`);
  }
});
