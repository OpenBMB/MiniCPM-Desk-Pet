"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const MAIN_JS = path.join(__dirname, "..", "src", "main.js");

test("Telegram /status command uses the full diagnostic view by default", () => {
  const source = fs.readFileSync(MAIN_JS, "utf8");
  const match = source.match(/function handleTelegramNativeCommand\([\s\S]*?\n\}/);
  assert.ok(match, "main.js should define handleTelegramNativeCommand");
  const body = match[0];

  assert.match(body, /return buildTelegramStatusCommandText\(\{ all: true \}\);/);
  assert.doesNotMatch(body, /String\(args/);
  assert.doesNotMatch(body, /===\s*"all"/);
});
