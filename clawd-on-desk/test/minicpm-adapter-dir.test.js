"use strict";

// Lock down the adapter seeder used by minicpm-chat.js to copy bundled
// LoRA `.gguf` files from `<resources>/adapters/` into the writable
// `<userData>/adapters/`. The walker has to be:
//
//   - Recursive (lora_nekoqa_xxx/adapter_model.f16.gguf lives one level
//     deep, not at the root).
//   - Idempotent (already-existing user files must NOT be overwritten,
//     otherwise user deletions get clobbered every launch).
//   - Filtered (only ship `.gguf` + small metadata, not random repo
//     debris that lands inside the adapter dir).
//   - Failure-tolerant (one bad file shouldn't abort the entire walk).

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const targetPath = require.resolve("../src/minicpm-chat.js");

// Same trick the locate test uses: re-evaluate the file with an
// __internals export so we can reach the module-private helpers.
function loadInternals() {
  delete require.cache[targetPath];
  const src = fs.readFileSync(targetPath, "utf-8");
  const augmented =
    src +
    "\nmodule.exports.__internals = { seedAdaptersFromBundle };\n";
  const m = new Module(targetPath, module);
  m.filename = targetPath;
  m.paths = Module._nodeModulePaths(path.dirname(targetPath));
  m._compile(augmented, targetPath);
  return m.exports.__internals;
}

// Stub electron BEFORE the file is loaded.
const realResolve = Module._resolveFilename;
const fakeElectronPath = path.join(os.tmpdir(), "fake-electron-stub-adapter.js");
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

describe("seedAdaptersFromBundle", () => {
  let tmpRoot;
  let srcDir;
  let dstDir;
  let internals;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "minicpm-adapters-"));
    srcDir = path.join(tmpRoot, "bundled");
    dstDir = path.join(tmpRoot, "userdata");
    fs.mkdirSync(srcDir, { recursive: true });
    internals = loadInternals();
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("copies .gguf files into a nested layout", () => {
    const adapterDir = path.join(srcDir, "lora_nekoqa_xxx");
    fs.mkdirSync(adapterDir, { recursive: true });
    fs.writeFileSync(path.join(adapterDir, "adapter_model.f16.gguf"), "WEIGHTS");
    fs.writeFileSync(path.join(adapterDir, "USAGE.md"), "# usage");
    fs.writeFileSync(path.join(adapterDir, "adapter_config.json"), "{}");

    const r = internals.seedAdaptersFromBundle(srcDir, dstDir);

    const copied = path.join(dstDir, "lora_nekoqa_xxx", "adapter_model.f16.gguf");
    assert.equal(fs.readFileSync(copied, "utf-8"), "WEIGHTS");
    assert.ok(fs.existsSync(path.join(dstDir, "lora_nekoqa_xxx", "USAGE.md")));
    assert.ok(fs.existsSync(path.join(dstDir, "lora_nekoqa_xxx", "adapter_config.json")));
    assert.equal(r.copied.length, 3);
    assert.equal(r.errors.length, 0);
  });

  it("skips files that already exist at destination", () => {
    fs.mkdirSync(path.join(srcDir, "lora_a"));
    fs.writeFileSync(path.join(srcDir, "lora_a", "adapter.gguf"), "NEW");
    fs.mkdirSync(path.join(dstDir, "lora_a"), { recursive: true });
    fs.writeFileSync(path.join(dstDir, "lora_a", "adapter.gguf"), "OLD");

    const r = internals.seedAdaptersFromBundle(srcDir, dstDir);

    // User-edited file must survive — the seed step never overwrites.
    assert.equal(fs.readFileSync(path.join(dstDir, "lora_a", "adapter.gguf"), "utf-8"), "OLD");
    assert.equal(r.copied.length, 0);
    assert.equal(r.skipped.length, 1);
  });

  it("filters out unrelated junk in the bundle", () => {
    fs.writeFileSync(path.join(srcDir, "weights.safetensors"), "huge");
    fs.writeFileSync(path.join(srcDir, "secret.env"), "TOKEN");
    fs.writeFileSync(path.join(srcDir, "notes.txt"), "blah");
    fs.writeFileSync(path.join(srcDir, "model.gguf"), "ok");

    const r = internals.seedAdaptersFromBundle(srcDir, dstDir);

    assert.ok(fs.existsSync(path.join(dstDir, "model.gguf")));
    assert.ok(!fs.existsSync(path.join(dstDir, "weights.safetensors")));
    assert.ok(!fs.existsSync(path.join(dstDir, "secret.env")));
    assert.ok(!fs.existsSync(path.join(dstDir, "notes.txt")));
    assert.equal(r.copied.length, 1);
  });

  it("returns an empty result when srcDir is null (dev mode)", () => {
    const r = internals.seedAdaptersFromBundle(null, dstDir);
    assert.deepEqual(r, { copied: [], skipped: [], errors: [] });
    // Should not create the dst dir when there's nothing to copy.
    assert.ok(!fs.existsSync(dstDir));
  });

  it("is resilient to individual file copy failures", () => {
    fs.writeFileSync(path.join(srcDir, "good.gguf"), "ok");
    fs.writeFileSync(path.join(srcDir, "bad.gguf"), "ok");

    const realCopy = fs.copyFileSync;
    const fakeFs = {
      ...fs,
      copyFileSync: (s, d) => {
        if (path.basename(s) === "bad.gguf") {
          throw new Error("simulated EACCES");
        }
        return realCopy(s, d);
      },
    };

    const r = internals.seedAdaptersFromBundle(srcDir, dstDir, fakeFs);

    assert.ok(fs.existsSync(path.join(dstDir, "good.gguf")));
    assert.ok(!fs.existsSync(path.join(dstDir, "bad.gguf")));
    assert.equal(r.copied.length, 1);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0].error, /simulated/);
  });
});
