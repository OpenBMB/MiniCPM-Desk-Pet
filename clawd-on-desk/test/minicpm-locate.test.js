"use strict";

// Lock down minicpm-chat.js's locator helpers (sidecar binary + dev
// source dir + Python interpreter). These three functions decide how
// the Electron host spawns the llama.cpp-backed sidecar; regressions
// here cause "找不到 sidecar" boot failures.

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const targetPath = require.resolve("../src/minicpm-chat.js");

// Stub electron just enough to require the file *without* invoking
// initMinicpmChat. We re-evaluate the source in our own context so
// each test sees fresh module state.
function loadInternals() {
  delete require.cache[targetPath];
  const src = fs.readFileSync(targetPath, "utf-8");
  // Append exposes so we can hit the otherwise-module-private helpers.
  const augmented =
    src +
    "\nmodule.exports.__internals = { locateSidecarBinary, locateSidecarSourceDir, locatePython, triplet };\n";
  const m = new Module(targetPath, module);
  m.filename = targetPath;
  m.paths = Module._nodeModulePaths(path.dirname(targetPath));
  m._compile(augmented, targetPath);
  return m.exports.__internals;
}

// Stub electron BEFORE the file is loaded. We replace require() with a
// shim that intercepts the "electron" import.
const realResolve = Module._resolveFilename;
const fakeElectronPath = path.join(os.tmpdir(), "fake-electron-stub.js");
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

describe("minicpm-chat locator helpers", () => {
  let tmpRoot;
  let appRoot;
  let internals;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "minicpm-locate-"));
    appRoot = path.join(tmpRoot, "clawd-on-desk");
    fs.mkdirSync(appRoot, { recursive: true });
    delete process.env.MINICPM_SIDECAR_BIN;
    delete process.env.MINICPM_SIDECAR_DIR;
    delete process.env.MINICPM_PYTHON;
    internals = loadInternals();
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("triplet returns a platform-specific identifier", () => {
    const t = internals.triplet();
    assert.ok(/^(darwin|win|linux|.+)-/.test(t), `bad triplet: ${t}`);
  });

  it("locateSidecarBinary honours MINICPM_SIDECAR_BIN override", () => {
    const bin = path.join(tmpRoot, "fake-sidecar");
    fs.writeFileSync(bin, "#!/bin/sh\n");
    process.env.MINICPM_SIDECAR_BIN = bin;
    assert.equal(internals.locateSidecarBinary(appRoot), path.resolve(bin));
  });

  it("locateSidecarBinary finds the dev triple under minicpm-sidecar/bin", () => {
    const triple = internals.triplet();
    const exe = process.platform === "win32" ? ".exe" : "";
    const binDir = path.join(tmpRoot, "minicpm-sidecar", "bin", triple);
    fs.mkdirSync(binDir, { recursive: true });
    const bin = path.join(binDir, "minicpm-sidecar" + exe);
    fs.writeFileSync(bin, "#!/bin/sh\n");
    assert.equal(internals.locateSidecarBinary(appRoot), bin);
  });

  it("locateSidecarSourceDir finds a sibling gateway package", () => {
    const sidecar = path.join(tmpRoot, "minicpm-sidecar");
    fs.mkdirSync(path.join(sidecar, "gateway"), { recursive: true });
    fs.writeFileSync(path.join(sidecar, "gateway", "__main__.py"), "");
    assert.equal(internals.locateSidecarSourceDir(appRoot), path.resolve(sidecar));
  });

  it("locateSidecarSourceDir honours MINICPM_SIDECAR_DIR override", () => {
    const override = path.join(tmpRoot, "elsewhere");
    fs.mkdirSync(path.join(override, "gateway"), { recursive: true });
    fs.writeFileSync(path.join(override, "gateway", "__main__.py"), "");
    process.env.MINICPM_SIDECAR_DIR = override;
    assert.equal(internals.locateSidecarSourceDir(appRoot), path.resolve(override));
  });

  it("locatePython prefers the .venv python over Scripts on POSIX", () => {
    const sidecar = path.join(tmpRoot, "minicpm-sidecar");
    fs.mkdirSync(path.join(sidecar, ".venv", "bin"), { recursive: true });
    const py = path.join(sidecar, ".venv", "bin", "python");
    fs.writeFileSync(py, "#!/bin/sh\n");
    assert.equal(internals.locatePython(sidecar), py);
  });

  it("locatePython returns null when no venv is set up", () => {
    const sidecar = path.join(tmpRoot, "minicpm-sidecar");
    fs.mkdirSync(sidecar, { recursive: true });
    assert.equal(internals.locatePython(sidecar), null);
  });

  it("locatePython honours MINICPM_PYTHON override", () => {
    const py = path.join(tmpRoot, "custom-python");
    fs.writeFileSync(py, "#!/bin/sh\n");
    process.env.MINICPM_PYTHON = py;
    assert.equal(internals.locatePython(undefined), py);
  });
});
