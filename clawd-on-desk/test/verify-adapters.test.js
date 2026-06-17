"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { VERIFY_COMMAND, verifyAdapters } = require("../scripts/verify-adapters");

function makeGguf(size = 64) {
  const buf = Buffer.alloc(Math.max(size, 4), 0);
  buf.write("GGUF", 0, "latin1");
  return buf;
}

const LFS_POINTER = Buffer.from("version https://git-lfs.github.com/spec/v1\n", "utf8");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "verify-adapters-test-"));
}

test("verifyAdapters passes when every bundled .gguf is valid", () => {
  const dir = tmpDir();
  try {
    const adapters = [{ id: "preset:x", dest: "adapters/x/model.gguf", minBytes: 8 }];
    fs.mkdirSync(path.join(dir, "adapters/x"), { recursive: true });
    fs.writeFileSync(path.join(dir, "adapters/x/model.gguf"), makeGguf(64));
    const result = verifyAdapters({ rootDir: dir, adapters });
    assert.equal(result.ok, true);
    assert.deepEqual(result.problems, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyAdapters fails on an LFS pointer stub with a fix hint", () => {
  const dir = tmpDir();
  try {
    const adapters = [{ id: "preset:x", dest: "adapters/x/model.gguf", minBytes: 8 }];
    fs.mkdirSync(path.join(dir, "adapters/x"), { recursive: true });
    fs.writeFileSync(path.join(dir, "adapters/x/model.gguf"), LFS_POINTER);
    const result = verifyAdapters({ rootDir: dir, adapters });
    assert.equal(result.ok, false);
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0].error, /Git LFS pointer/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyAdapters fails when a bundled adapter is missing", () => {
  const dir = tmpDir();
  try {
    const adapters = [{ id: "preset:x", dest: "adapters/x/model.gguf", minBytes: 8 }];
    const result = verifyAdapters({ rootDir: dir, adapters });
    assert.equal(result.ok, false);
    assert.match(result.problems[0].error, /missing file/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("package prebuild scripts run the adapter verification command", () => {
  const pkg = require("../package.json");
  assert.equal(pkg.scripts["verify:adapters"], VERIFY_COMMAND);
  for (const name of ["prebuild", "prebuild:win:x64", "prebuild:mac", "prebuild:linux", "prebuild:all"]) {
    assert.ok(pkg.scripts[name].includes(VERIFY_COMMAND), `${name} should verify adapters before packaging`);
  }
});
