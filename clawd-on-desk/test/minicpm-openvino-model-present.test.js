"use strict";

// A llama.cpp model is one .gguf file; an OpenVINO model is a whole
// directory (openvino_model.xml + .bin + tokenizer pair). Every "is there
// a model here?" check has to accept both — `isModelPresent` feeds the
// onboarding wizard's model-vanished re-show test, so getting this wrong
// nags OpenVINO users with a GGUF download wizard forever.
//
// The regression case matters as much as the new one: .gguf detection must
// keep working exactly as before.

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const targetPath = require.resolve("../src/minicpm-chat.js");

function loadInternals() {
  delete require.cache[targetPath];
  const src = fs.readFileSync(targetPath, "utf-8");
  // Only module-scope helpers are reachable this way. `_firstGgufIn` and
  // `isModelPresent` live inside the initMinicpmChat closure and need
  // Electron's `app`, which is why `firstOpenvinoIrIn` was put at module
  // scope in the first place.
  const augmented =
    src + "\nmodule.exports.__internals = { firstOpenvinoIrIn };\n";
  const m = new Module(targetPath, module);
  m.filename = targetPath;
  m.paths = Module._nodeModulePaths(path.dirname(targetPath));
  m._compile(augmented, targetPath);
  return m.exports.__internals;
}

// Unique stub filename: the whole test directory shares one runner
// process, so a name collision with another test file's stub would make
// both flaky depending on execution order.
const realResolve = Module._resolveFilename;
const fakeElectronPath = path.join(os.tmpdir(), "fake-electron-stub-openvino.js");
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

const IR_FILES = [
  "openvino_model.xml",
  "openvino_model.bin",
  "openvino_tokenizer.xml",
  "openvino_detokenizer.xml",
];

function makeIr(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of IR_FILES) fs.writeFileSync(path.join(dir, name), "");
  return dir;
}

describe("firstOpenvinoIrIn", () => {
  let tmpRoot;
  let internals;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "minicpm-ov-"));
    // Scrub the backend env: all test files share one process, so a
    // leftover value from another file would leak in here.
    delete process.env.MINICPM_BACKEND;
    internals = loadInternals();
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("detects an IR directory passed directly", () => {
    makeIr(tmpRoot);
    assert.equal(internals.firstOpenvinoIrIn(tmpRoot), tmpRoot);
  });

  it("detects an IR nested one level down", () => {
    const inner = makeIr(path.join(tmpRoot, "MiniCPM5-2.6B-int8"));
    assert.equal(internals.firstOpenvinoIrIn(tmpRoot), inner);
  });

  it("returns null for an empty directory", () => {
    assert.equal(internals.firstOpenvinoIrIn(tmpRoot), null);
  });

  it("returns null for a directory of .gguf files", () => {
    fs.writeFileSync(path.join(tmpRoot, "model.gguf"), "");
    assert.equal(internals.firstOpenvinoIrIn(tmpRoot), null);
  });

  it("returns null rather than throwing on a missing path", () => {
    assert.equal(internals.firstOpenvinoIrIn(path.join(tmpRoot, "nope")), null);
  });

  it("does not treat a lone .bin as an IR", () => {
    // openvino_model.xml is the marker; a stray .bin is not enough.
    fs.mkdirSync(path.join(tmpRoot, "half"), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, "half", "openvino_model.bin"), "");
    assert.equal(internals.firstOpenvinoIrIn(tmpRoot), null);
  });

  it("ignores a nested .gguf-only directory", () => {
    // isModelPresent ORs the two detectors together, so this one must not
    // claim a gguf tree as an IR — otherwise a llama.cpp model would be
    // handed to the OpenVINO loader.
    fs.mkdirSync(path.join(tmpRoot, "gguf-models"), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, "gguf-models", "a.gguf"), "");
    assert.equal(internals.firstOpenvinoIrIn(tmpRoot), null);
  });
});
