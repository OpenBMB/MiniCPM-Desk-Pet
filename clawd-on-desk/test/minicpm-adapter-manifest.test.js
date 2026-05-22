"use strict";

// Cover the pure manifest helpers used by minicpm-chat.js to persist
// LoRA display names + aliases:
//
//   - parseManifestJson: tolerates malformed / empty / non-object input
//   - manifestUpsertItem: idempotent insert by id, merge semantics
//   - manifestRemoveItem: id-based removal, no-op on miss
//
// IO-heavy paths (readAdapterManifest / writeAdapterManifest /
// seedDefaultManifest) live inside the initMinicpmChat closure and are
// exercised in integration via npm start + Settings UI smoke; covering
// the pure layer here gives us regression protection without forcing
// Electron mocks.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const targetPath = require.resolve("../src/minicpm-chat.js");

function loadInternals() {
  delete require.cache[targetPath];
  const src = fs.readFileSync(targetPath, "utf-8");
  const augmented =
    src +
    "\nmodule.exports.__internals = { parseManifestJson, manifestUpsertItem, manifestRemoveItem };\n";
  const m = new Module(targetPath, module);
  m.filename = targetPath;
  m.paths = Module._nodeModulePaths(path.dirname(targetPath));
  m._compile(augmented, targetPath);
  return m.exports.__internals;
}

// Stub electron BEFORE the file is loaded (same trick as the other
// minicpm-* tests).
const realResolve = Module._resolveFilename;
const fakeElectronPath = path.join(os.tmpdir(), "fake-electron-stub-manifest.js");
fs.writeFileSync(
  fakeElectronPath,
  `module.exports = {
     BrowserWindow: class {}, ipcMain: {}, screen: {}, shell: {},
     Menu: {}, app: { isPackaged: false, getPath: () => "${os.tmpdir().replace(/\\/g, "/")}" }
   };`
);
Module._resolveFilename = function patched(request, parent, ...rest) {
  if (request === "electron") return fakeElectronPath;
  return realResolve.call(this, request, parent, ...rest);
};

const { parseManifestJson, manifestUpsertItem, manifestRemoveItem } = loadInternals();

describe("parseManifestJson", () => {
  it("returns an empty manifest for invalid JSON", () => {
    const r = parseManifestJson("{not json");
    assert.deepEqual(r, { version: 1, items: [] });
  });

  it("returns an empty manifest when items is missing", () => {
    const r = parseManifestJson(JSON.stringify({ version: 1 }));
    assert.deepEqual(r, { version: 1, items: [] });
  });

  it("returns an empty manifest when the root is an array (defensive)", () => {
    const r = parseManifestJson(JSON.stringify([{ id: "x" }]));
    assert.deepEqual(r, { version: 1, items: [] });
  });

  it("preserves version and filters non-object items", () => {
    const r = parseManifestJson(JSON.stringify({
      version: 2,
      items: [
        { id: "ok", displayName: "OK" },
        null,
        "not an object",
        { id: "ok2" },
      ],
    }));
    assert.equal(r.version, 2);
    assert.equal(r.items.length, 2);
    assert.deepEqual(r.items.map((it) => it.id), ["ok", "ok2"]);
  });
});

describe("manifestUpsertItem", () => {
  it("appends a new entry with a createdAt timestamp", () => {
    const out = manifestUpsertItem([], { id: "preset:nekoqa", displayName: "猫娘 宝宝" });
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "preset:nekoqa");
    assert.equal(out[0].displayName, "猫娘 宝宝");
    assert.ok(out[0].createdAt, "should stamp createdAt on insert");
  });

  it("merges into an existing entry, preserving fields not in the patch", () => {
    const existing = [{
      id: "preset:nekoqa",
      displayName: "old",
      aliases: ["a"],
      createdAt: "2026-01-01T00:00:00Z",
    }];
    const out = manifestUpsertItem(existing, {
      id: "preset:nekoqa",
      displayName: "猫娘",
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].displayName, "猫娘");
    // aliases survives the rename
    assert.deepEqual(out[0].aliases, ["a"]);
    // createdAt is preserved on update (not re-stamped)
    assert.equal(out[0].createdAt, "2026-01-01T00:00:00Z");
  });

  it("does not mutate the input array", () => {
    const input = [{ id: "x", displayName: "old" }];
    const out = manifestUpsertItem(input, { id: "x", displayName: "new" });
    assert.notStrictEqual(out, input);
    assert.equal(input[0].displayName, "old");
    assert.equal(out[0].displayName, "new");
  });

  it("returns a shallow copy when entry lacks an id (no-op)", () => {
    const input = [{ id: "x" }];
    const out = manifestUpsertItem(input, { displayName: "y" });
    assert.notStrictEqual(out, input);
    assert.deepEqual(out, input);
  });

  it("treats a non-array first arg as empty", () => {
    const out = manifestUpsertItem(undefined, { id: "x" });
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "x");
  });
});

describe("manifestRemoveItem", () => {
  it("removes the item with the matching id", () => {
    const out = manifestRemoveItem(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      "b"
    );
    assert.deepEqual(out.map((it) => it.id), ["a", "c"]);
  });

  it("is a no-op when id is missing", () => {
    const input = [{ id: "a" }];
    const out = manifestRemoveItem(input, "zzz");
    assert.deepEqual(out, input);
    assert.notStrictEqual(out, input, "should return a fresh array even on no-op");
  });

  it("handles a non-array input gracefully", () => {
    const out = manifestRemoveItem(null, "anything");
    assert.deepEqual(out, []);
  });

  it("skips falsy items in the list", () => {
    const out = manifestRemoveItem([null, { id: "x" }, undefined], "x");
    assert.deepEqual(out, []);
  });
});
