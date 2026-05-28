"use strict";

// Cover the pure bundled-preset reconcile helpers in minicpm-chat.js that
// stop duplicate persona chips in Settings when a newer copy of a preset
// adapter is seeded in alongside an older one:
//
//   - adapterMatchesHint:   filename OR parent-dir substring match
//   - planBundledReconcile: pick newest canonical, flag older copies as
//                           superseded, protect user uploads
//   - safeDeleteTargetFor:  never return a target at/above the adapter root
//
// The fs walk + manifest writes that drive these live inside the
// initMinicpmChat closure and are covered by npm start + Settings smoke;
// the pure layer is unit-tested here (same approach as the other
// minicpm-* tests).

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
    "\nmodule.exports.__internals = { adapterMatchesHint, planBundledReconcile, safeDeleteTargetFor };\n";
  const m = new Module(targetPath, module);
  m.filename = targetPath;
  m.paths = Module._nodeModulePaths(path.dirname(targetPath));
  m._compile(augmented, targetPath);
  return m.exports.__internals;
}

// Stub electron BEFORE the file is loaded (same trick as the other
// minicpm-* tests).
const realResolve = Module._resolveFilename;
const fakeElectronPath = path.join(os.tmpdir(), "fake-electron-stub-reconcile.js");
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

const { adapterMatchesHint, planBundledReconcile, safeDeleteTargetFor } = loadInternals();

// Absolute, platform-correct adapter dir for building fake paths.
const ROOT = path.join(os.tmpdir(), "minicpm-reconcile-fixtures", "adapters");
const gguf = (dirName) => path.join(ROOT, dirName, "adapter_model.f16.gguf");

const NEKO_PRESET = { id: "preset:nekoqa", filenameHint: "lora_nekoqa", persona: "neko" };

describe("adapterMatchesHint", () => {
  it("matches on the parent dir name even when the file is generic", () => {
    assert.equal(adapterMatchesHint(gguf("lora_nekoqa_v2_xxx"), "lora_nekoqa"), true);
  });

  it("matches on the filename", () => {
    assert.equal(adapterMatchesHint(path.join(ROOT, "lora_nekoqa.gguf"), "nekoqa"), true);
  });

  it("is case-insensitive", () => {
    assert.equal(adapterMatchesHint(gguf("LORA_NekoQA_x"), "lora_nekoqa"), true);
  });

  it("does not match an unrelated adapter", () => {
    assert.equal(adapterMatchesHint(gguf("lora_muice_x"), "lora_nekoqa"), false);
  });

  it("returns false on missing args", () => {
    assert.equal(adapterMatchesHint("", "nekoqa"), false);
    assert.equal(adapterMatchesHint(gguf("lora_nekoqa_x"), ""), false);
  });
});

describe("planBundledReconcile", () => {
  it("keeps the newest copy and supersedes the older, re-pointing the manifest", () => {
    const oldPath = gguf("lora_nekoqa_adapter_20260515_0738");
    const newPath = gguf("lora_nekoqa_v2_fixedbase_adapter_20260524_0959");
    const plan = planBundledReconcile({
      scanned: [
        { path: oldPath, name: "adapter_model.f16.gguf", mtimeMs: 1000 },
        { path: newPath, name: "adapter_model.f16.gguf", mtimeMs: 2000 },
      ],
      presets: [NEKO_PRESET],
      manifestItems: [{ id: "preset:nekoqa", path: oldPath, displayName: "猫娘" }],
    });
    assert.deepEqual(plan.repoint, [{ id: "preset:nekoqa", path: newPath }]);
    assert.deepEqual(plan.superseded, [oldPath]);
  });

  it("is a no-op when the only copy is already the manifest target", () => {
    const only = gguf("lora_nekoqa_v2_x");
    const plan = planBundledReconcile({
      scanned: [{ path: only, name: "adapter_model.f16.gguf", mtimeMs: 2000 }],
      presets: [NEKO_PRESET],
      manifestItems: [{ id: "preset:nekoqa", path: only, displayName: "猫娘" }],
    });
    assert.deepEqual(plan.repoint, []);
    assert.deepEqual(plan.superseded, []);
  });

  it("re-points a stale manifest path to the single on-disk copy without deleting it", () => {
    const onDisk = gguf("lora_nekoqa_v2_x");
    const stale = gguf("lora_nekoqa_deleted_old");
    const plan = planBundledReconcile({
      scanned: [{ path: onDisk, name: "adapter_model.f16.gguf", mtimeMs: 2000 }],
      presets: [NEKO_PRESET],
      manifestItems: [{ id: "preset:nekoqa", path: stale, displayName: "猫娘" }],
    });
    assert.deepEqual(plan.repoint, [{ id: "preset:nekoqa", path: onDisk }]);
    assert.deepEqual(plan.superseded, []);
  });

  it("protects a hint-matching user upload claimed by another manifest entry", () => {
    const presetPath = gguf("lora_nekoqa_v2_x");
    const uploadPath = gguf("my_custom_nekoqa_finetune");
    const plan = planBundledReconcile({
      scanned: [
        { path: presetPath, name: "adapter_model.f16.gguf", mtimeMs: 1000 },
        { path: uploadPath, name: "adapter_model.f16.gguf", mtimeMs: 5000 },
      ],
      presets: [NEKO_PRESET],
      manifestItems: [
        { id: "preset:nekoqa", path: presetPath, displayName: "猫娘" },
        { id: "upload:abc", path: uploadPath, displayName: "我的猫娘", source: "upload" },
      ],
    });
    // Upload is newer, but it is off-limits: not canonical, not superseded.
    assert.deepEqual(plan.repoint, []);
    assert.deepEqual(plan.superseded, []);
  });

  it("returns an empty plan when nothing matches the hint", () => {
    const plan = planBundledReconcile({
      scanned: [{ path: gguf("lora_muice_x"), name: "adapter_model.f16.gguf", mtimeMs: 1 }],
      presets: [NEKO_PRESET],
      manifestItems: [{ id: "preset:nekoqa", path: gguf("lora_nekoqa_x") }],
    });
    assert.deepEqual(plan, { repoint: [], superseded: [] });
  });

  it("breaks an mtime tie by greatest path (timestamped dir name wins)", () => {
    const older = gguf("lora_nekoqa_adapter_20260515_0738");
    const newer = gguf("lora_nekoqa_v2_fixedbase_adapter_20260524_0959");
    const plan = planBundledReconcile({
      scanned: [
        { path: older, name: "adapter_model.f16.gguf", mtimeMs: 1234 },
        { path: newer, name: "adapter_model.f16.gguf", mtimeMs: 1234 },
      ],
      presets: [NEKO_PRESET],
      manifestItems: [{ id: "preset:nekoqa", path: older }],
    });
    // "...v2_fixedbase..._0959" sorts after "...adapter_20260515_0738".
    assert.deepEqual(plan.repoint, [{ id: "preset:nekoqa", path: newer }]);
    assert.deepEqual(plan.superseded, [older]);
  });

  it("tolerates empty / missing input", () => {
    assert.deepEqual(planBundledReconcile(), { repoint: [], superseded: [] });
    assert.deepEqual(
      planBundledReconcile({ scanned: [], presets: [NEKO_PRESET], manifestItems: [] }),
      { repoint: [], superseded: [] },
    );
  });
});

describe("safeDeleteTargetFor", () => {
  it("returns the adapter's own dir when the file is in a proper subdir", () => {
    const file = gguf("lora_nekoqa_old");
    const r = safeDeleteTargetFor(file, ROOT);
    assert.equal(r.kind, "dir");
    assert.equal(r.target, path.join(ROOT, "lora_nekoqa_old"));
  });

  it("returns just the file when it sits directly in the adapter root", () => {
    const file = path.join(ROOT, "loose.gguf");
    const r = safeDeleteTargetFor(file, ROOT);
    assert.equal(r.kind, "file");
    assert.equal(r.target, file);
  });

  it("skips when the file path is the adapter root itself", () => {
    const r = safeDeleteTargetFor(ROOT, ROOT);
    assert.equal(r.kind, "skip");
  });

  it("skips a path outside the adapter root", () => {
    const r = safeDeleteTargetFor(path.join(os.tmpdir(), "elsewhere", "x.gguf"), ROOT);
    assert.equal(r.kind, "skip");
  });

  it("skips on missing args", () => {
    assert.equal(safeDeleteTargetFor("", ROOT).kind, "skip");
    assert.equal(safeDeleteTargetFor(gguf("lora_nekoqa_old"), "").kind, "skip");
  });
});
