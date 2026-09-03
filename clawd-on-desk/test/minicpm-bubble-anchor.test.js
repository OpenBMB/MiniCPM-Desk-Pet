"use strict";

// The pet window carries wide transparent margins, so its bounds are not
// where the character appears. Anything that anchors the bubble to the window
// instead of going through getPetBoundsSafe() puts it a margin's width off.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src", "minicpm-chat.js");
const src = fs.readFileSync(SRC, "utf-8");

/** Byte span of a `function name(...) { ... }` body, by brace matching. */
function functionSpan(name) {
  const re = new RegExp(`function\\s+${name}\\s*\\(`);
  const start = src.search(re);
  assert.notEqual(start, -1, `${name}() not found in minicpm-chat.js`);
  let i = src.indexOf("{", start);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) return [start, j + 1];
    }
  }
  throw new Error(`unbalanced braces in ${name}()`);
}

function occurrences(needle) {
  const out = [];
  let i = src.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = src.indexOf(needle, i + 1);
  }
  return out;
}

function lineOf(index) {
  return src.slice(0, index).split("\n").length;
}

describe("pet bounds are resolved in exactly one place", () => {
  it("only getPetBoundsSafe reads ctx.getPetWindowBounds", () => {
    const [from, to] = functionSpan("getPetBoundsSafe");
    const strays = occurrences("ctx.getPetWindowBounds")
      .filter((i) => i < from || i >= to)
      .map(lineOf);

    assert.deepEqual(
      strays, [],
      "anchoring to the pet *window* skips the transparent margins and puts " +
      "the bubble away from the sprite — go through getPetBoundsSafe() " +
      `instead (offending line(s): ${strays.join(", ")})`
    );
  });

  it("getPetBoundsSafe prefers the hit rect over the window", () => {
    const [from, to] = functionSpan("getPetBoundsSafe");
    const body = src.slice(from, to);
    const hit = body.indexOf("ctx.getPetHitRect");
    const win = body.indexOf("ctx.getPetWindowBounds");

    assert.notEqual(hit, -1, "getPetBoundsSafe must consult the hit rect");
    assert.notEqual(win, -1, "getPetBoundsSafe must keep the window fallback");
    assert.ok(hit < win, "the hit rect has to be tried first, not as a fallback");
  });
});
