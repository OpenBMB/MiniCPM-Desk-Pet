"use strict";

// The inference engine used to be selectable only via MINICPM_BACKEND at
// launch, which a packaged .exe user has no way to set. These lock down the
// resolver behind the new Settings control.
//
// Two rules matter most:
//   1. An explicit env var still wins over the persisted preference, so the
//      existing `$env:MINICPM_BACKEND = "openvino"` workflow keeps working.
//   2. The model path is remembered per backend — the two engines read
//      different formats (.gguf vs an IR directory), so a shared path would
//      hand one engine a file the other wrote.

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const targetPath = require.resolve("../src/minicpm-chat.js");

let tmpUserData;

function loadInternals() {
  delete require.cache[targetPath];
  const src = fs.readFileSync(targetPath, "utf-8");
  // These live inside initMinicpmChat's closure, so re-export from there.
  const augmented = src.replace(
    "    isModelPresent: () => isModelPresent(),",
    "    isModelPresent: () => isModelPresent()," +
      "\n    __test: { normalizeBackend, getEffectiveBackend, getBackendModelDir," +
      " rememberBackendModelDir, SUPPORTED_BACKENDS },"
  );
  assert.ok(augmented !== src, "failed to splice test exports into minicpm-chat.js");
  const m = new Module(targetPath, module);
  m.filename = targetPath;
  m.paths = Module._nodeModulePaths(path.dirname(targetPath));
  m._compile(augmented, targetPath);
  return m.exports;
}

const realResolve = Module._resolveFilename;
const fakeElectronPath = path.join(os.tmpdir(), "fake-electron-stub-backend.js");

describe("inference backend resolution", () => {
  let internals;

  beforeEach(() => {
    tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), "minicpm-backend-"));
    fs.writeFileSync(
      fakeElectronPath,
      `module.exports = {
         BrowserWindow: class {}, ipcMain: { handle(){}, removeHandler(){}, on(){}, removeAllListeners(){},
                    removeListener(){}, handleOnce(){} },
         screen: {}, shell: {}, Menu: {}, dialog: {},
         app: { isPackaged: false, getVersion: () => "0.0.0",
                getPath: () => ${JSON.stringify(tmpUserData)} }
       };`
    );
    Module._resolveFilename = function patched(request, parent, ...rest) {
      if (request === "electron") return fakeElectronPath;
      return realResolve.call(this, request, parent, ...rest);
    };
    // All test files share one process — scrub what we key off.
    delete process.env.MINICPM_BACKEND;
    delete process.env.MINICPM_MODEL_DIR;
    // module.exports IS the factory function, not a namespace object.
    const initMinicpmChat = loadInternals();
    const api = initMinicpmChat({ log: () => {}, sendToRenderer: () => {} });
    internals = api && api.__test;
    assert.ok(internals, "expected __test exports to be spliced in");
  });

  afterEach(() => {
    Module._resolveFilename = realResolve;
    delete process.env.MINICPM_BACKEND;
    fs.rmSync(tmpUserData, { recursive: true, force: true });
  });

  it("normalises the spellings users actually type", () => {
    const { normalizeBackend } = internals;
    assert.equal(normalizeBackend("openvino"), "openvino");
    assert.equal(normalizeBackend("OpenVINO"), "openvino");
    assert.equal(normalizeBackend("ov"), "openvino");
    assert.equal(normalizeBackend("llama.cpp"), "llama.cpp");
    assert.equal(normalizeBackend("gguf"), "llama.cpp");
    assert.equal(normalizeBackend("nonsense"), null);
    assert.equal(normalizeBackend(""), null);
    assert.equal(normalizeBackend(undefined), null);
  });

  it("defaults to llama.cpp with nothing configured", () => {
    assert.equal(internals.getEffectiveBackend(), "llama.cpp");
  });

  it("lets an explicit env var override the persisted preference", () => {
    process.env.MINICPM_BACKEND = "openvino";
    assert.equal(internals.getEffectiveBackend(), "openvino");
  });

  it("ignores a garbage env var instead of breaking the default path", () => {
    process.env.MINICPM_BACKEND = "not-a-backend";
    assert.equal(internals.getEffectiveBackend(), "llama.cpp");
  });

  it("remembers a model path per backend", () => {
    const { rememberBackendModelDir, getBackendModelDir } = internals;
    rememberBackendModelDir("llama.cpp", "C:/models/a.gguf");
    rememberBackendModelDir("openvino", "C:/models/ov/ir-dir");

    assert.equal(getBackendModelDir("llama.cpp"), "C:/models/a.gguf");
    assert.equal(getBackendModelDir("openvino"), "C:/models/ov/ir-dir");
  });

  it("returns null for a backend with no remembered model", () => {
    // Deliberately a name no other case writes: minicpm-prefs.json lives
    // under the stubbed userData dir, and the stub bakes that path in as a
    // literal, so writes from earlier cases in this file are still there.
    assert.equal(internals.getBackendModelDir("never-configured"), null);
  });

  it("declares exactly the two supported backends", () => {
    assert.deepEqual(internals.SUPPORTED_BACKENDS, ["llama.cpp", "openvino"]);
  });
});
