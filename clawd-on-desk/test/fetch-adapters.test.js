"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  FETCH_COMMAND,
  REMOTE_ADAPTERS,
  encodeRepoPath,
  buildTreeApiUrl,
  buildResolveUrl,
  hfAuthHeaders,
  pickGgufEntry,
  pickGgufFromTree,
  extractLfsSha256,
  extractFileSize,
  sha256,
  isGgufMagic,
  describeBadMagic,
  verifyGgufBuffer,
  verifyGgufFileSync,
  withRetry,
  selectAdapters,
  fetchOneAdapter,
} = require("../scripts/fetch-adapters");

// A minimal but valid-looking GGUF: correct 4-byte magic + padding to size.
function makeGguf(size = 64) {
  const buf = Buffer.alloc(Math.max(size, 4), 0);
  buf.write("GGUF", 0, "latin1");
  return buf;
}

// What a Git LFS pointer stub actually starts with — the real-world bug.
const LFS_POINTER = Buffer.from(
  "version https://git-lfs.github.com/spec/v1\noid sha256:deadbeef\nsize 22436736\n",
  "utf8"
);

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "adapters-test-"));
}

// ── URL / header helpers ────────────────────────────────────────────────────

test("buildTreeApiUrl / buildResolveUrl produce HF endpoints", () => {
  assert.equal(
    buildTreeApiUrl("Owner/Repo", "main"),
    "https://huggingface.co/api/models/Owner/Repo/tree/main"
  );
  assert.equal(
    buildResolveUrl("Owner/Repo", "main", "adapter_model.f16.gguf"),
    "https://huggingface.co/Owner/Repo/resolve/main/adapter_model.f16.gguf?download=true"
  );
});

test("buildResolveUrl encodes path segments but keeps slashes", () => {
  assert.equal(encodeRepoPath("sub dir/a b.gguf"), "sub%20dir/a%20b.gguf");
  assert.equal(
    buildResolveUrl("o/r", "main", "sub dir/file.gguf"),
    "https://huggingface.co/o/r/resolve/main/sub%20dir/file.gguf?download=true"
  );
});

test("buildResolveUrl defaults a blank revision to main", () => {
  assert.match(buildResolveUrl("o/r", "", "f.gguf"), /\/resolve\/main\/f\.gguf/);
});

test("hfAuthHeaders only sets Authorization when a token is present", () => {
  assert.deepEqual(hfAuthHeaders({}), {});
  assert.deepEqual(hfAuthHeaders({ HF_TOKEN: "abc" }), { Authorization: "Bearer abc" });
  assert.deepEqual(hfAuthHeaders({ HUGGING_FACE_HUB_TOKEN: "xyz" }), { Authorization: "Bearer xyz" });
});

// ── tree picking ────────────────────────────────────────────────────────────

test("pickGgufFromTree returns the single .gguf", () => {
  const tree = [
    { type: "file", path: "README.md" },
    { type: "file", path: "adapter_model.f16.gguf" },
    { type: "file", path: "adapter_config.json" },
  ];
  assert.equal(pickGgufFromTree(tree), "adapter_model.f16.gguf");
});

test("pickGgufFromTree throws when ambiguous or empty", () => {
  assert.throws(() => pickGgufFromTree([]), /no \.gguf/);
  assert.throws(
    () => pickGgufFromTree([
      { type: "file", path: "a.gguf" },
      { type: "file", path: "b.gguf" },
    ]),
    /multiple \.gguf/
  );
});

test("pickGgufFromTree honors an explicit sourceFile", () => {
  const tree = [
    { type: "file", path: "a.gguf" },
    { type: "file", path: "b.gguf" },
  ];
  assert.equal(pickGgufFromTree(tree, { sourceFile: "b.gguf" }), "b.gguf");
  assert.throws(() => pickGgufFromTree(tree, { sourceFile: "missing.gguf" }), /not found/);
});

test("pickGgufEntry returns the full entry (so LFS metadata survives)", () => {
  const entry = { type: "file", path: "m.gguf", size: 22436736, lfs: { oid: "sha256:" + "a".repeat(64), size: 22436736 } };
  const tree = [{ type: "file", path: "README.md" }, entry];
  assert.deepEqual(pickGgufEntry(tree), entry);
});

test("extractLfsSha256 reads HF's published checksum (with or without prefix)", () => {
  const hex = "a".repeat(64);
  assert.equal(extractLfsSha256({ lfs: { oid: "sha256:" + hex } }), hex);
  assert.equal(extractLfsSha256({ lfs: { oid: hex.toUpperCase() } }), hex);
  assert.equal(extractLfsSha256({ lfs: { oid: "not-a-sha" } }), null);
  assert.equal(extractLfsSha256({ size: 10 }), null, "non-LFS entry → no checksum");
});

test("extractFileSize prefers the LFS size, falls back to entry size", () => {
  assert.equal(extractFileSize({ lfs: { size: 999 }, size: 5 }), 999);
  assert.equal(extractFileSize({ size: 5 }), 5);
  assert.equal(extractFileSize({}), null);
});

// ── magic / buffer verification ─────────────────────────────────────────────

test("isGgufMagic distinguishes GGUF from an LFS pointer", () => {
  assert.equal(isGgufMagic(makeGguf()), true);
  assert.equal(isGgufMagic(LFS_POINTER), false);
  assert.equal(isGgufMagic(Buffer.from("GG")), false);
});

test("describeBadMagic flags the LFS-pointer 'vers' signature", () => {
  assert.match(describeBadMagic(LFS_POINTER), /Git LFS pointer/);
  assert.match(describeBadMagic(Buffer.from("ELF\0")), /expected 'GGUF'/);
});

test("verifyGgufBuffer accepts a real GGUF and rejects stubs / tiny files", () => {
  assert.equal(verifyGgufBuffer(makeGguf(2048), { minBytes: 1024 }), true);
  assert.throws(() => verifyGgufBuffer(LFS_POINTER, { minBytes: 0 }), /invalid GGUF magic/);
  assert.throws(() => verifyGgufBuffer(makeGguf(8), { minBytes: 1024 }), /too small/);
});

test("verifyGgufBuffer enforces a pinned sha256 when provided", () => {
  const buf = makeGguf(64);
  const sha = require("node:crypto").createHash("sha256").update(buf).digest("hex");
  assert.equal(verifyGgufBuffer(buf, { sha256: sha }), true);
  assert.throws(() => verifyGgufBuffer(buf, { sha256: "0".repeat(64) }), /sha256 mismatch/);
});

// ── on-disk verification ────────────────────────────────────────────────────

test("verifyGgufFileSync passes for a valid file, throws otherwise", () => {
  const dir = tmpDir();
  try {
    const good = path.join(dir, "good.gguf");
    fs.writeFileSync(good, makeGguf(4096));
    assert.deepEqual(verifyGgufFileSync(good, { minBytes: 1024 }), { ok: true, size: 4096 });

    const stub = path.join(dir, "stub.gguf");
    fs.writeFileSync(stub, LFS_POINTER);
    assert.throws(() => verifyGgufFileSync(stub, { minBytes: 0 }), /Git LFS pointer/);

    assert.throws(() => verifyGgufFileSync(path.join(dir, "nope.gguf")), /missing file/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── retry / selection ───────────────────────────────────────────────────────

test("withRetry retries until success", async () => {
  let calls = 0;
  const out = await withRetry(() => {
    calls += 1;
    if (calls < 3) throw new Error("boom");
    return "ok";
  }, { attempts: 3 });
  assert.equal(out, "ok");
  assert.equal(calls, 3);
});

test("selectAdapters resolves all / by id / unknown", () => {
  const adapters = [{ id: "preset:a" }, { id: "preset:b" }];
  assert.deepEqual(selectAdapters("all", adapters).map((a) => a.id), ["preset:a", "preset:b"]);
  assert.deepEqual(selectAdapters("preset:b", adapters).map((a) => a.id), ["preset:b"]);
  assert.throws(() => selectAdapters("preset:zzz", adapters), /Unknown adapter/);
});

// ── fetchOneAdapter (network injected) ──────────────────────────────────────

test("fetchOneAdapter skips when a valid copy already exists", async () => {
  const dir = tmpDir();
  try {
    const entry = { id: "preset:x", repo: "o/r", revision: "main", sourceFile: null, dest: "adapters/x/model.gguf", minBytes: 8 };
    fs.mkdirSync(path.join(dir, "adapters/x"), { recursive: true });
    fs.writeFileSync(path.join(dir, "adapters/x/model.gguf"), makeGguf(64));
    let touched = false;
    const res = await fetchOneAdapter(entry, {
      rootDir: dir,
      fetchJson: async () => { touched = true; return []; },
      downloadToFile: async () => { touched = true; },
    });
    assert.equal(res.action, "skipped");
    assert.equal(touched, false, "must not hit the network when a valid file is present");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchOneAdapter auto-discovers, downloads, verifies sha256, and installs", async () => {
  const dir = tmpDir();
  try {
    const entry = { id: "preset:x", repo: "Owner/Repo", revision: "main", sourceFile: null, dest: "adapters/x/model.gguf", minBytes: 8 };
    const gguf = makeGguf(128);
    const oid = sha256(gguf);
    const urls = [];
    const res = await fetchOneAdapter(entry, {
      rootDir: dir,
      // HF tree publishes the LFS sha256 + size; the fetcher verifies against it.
      fetchJson: async () => [{ type: "file", path: "adapter_model.f16.gguf", lfs: { oid: "sha256:" + oid, size: gguf.length } }],
      downloadToFile: async (url, destPath) => {
        urls.push(url);
        fs.writeFileSync(destPath, gguf);
        return destPath;
      },
    });
    assert.equal(res.action, "downloaded");
    assert.match(urls[0], /\/Owner\/Repo\/resolve\/main\/adapter_model\.f16\.gguf\?download=true$/);
    const dest = path.join(dir, "adapters/x/model.gguf");
    assert.ok(fs.existsSync(dest));
    assert.deepEqual(fs.readFileSync(dest), gguf);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchOneAdapter rejects a download that mismatches HF's published sha256", async () => {
  const dir = tmpDir();
  try {
    const entry = { id: "preset:x", repo: "o/r", revision: "main", sourceFile: null, dest: "adapters/x/model.gguf", minBytes: 8 };
    const expected = makeGguf(128);
    const corrupt = makeGguf(128);
    corrupt[100] = 0x42; // valid GGUF magic + right size, but wrong bytes
    await assert.rejects(
      fetchOneAdapter(entry, {
        rootDir: dir,
        fetchJson: async () => [{ type: "file", path: "m.gguf", lfs: { oid: sha256(expected), size: expected.length } }],
        downloadToFile: async (url, destPath) => { fs.writeFileSync(destPath, corrupt); return destPath; },
      }),
      /sha256 mismatch|Failed to fetch preset:x/
    );
    assert.equal(fs.existsSync(path.join(dir, "adapters/x/model.gguf")), false, "corrupt download must not be installed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchOneAdapter rejects a download whose size mismatches HF's metadata", async () => {
  const dir = tmpDir();
  try {
    const entry = { id: "preset:x", repo: "o/r", revision: "main", sourceFile: null, dest: "adapters/x/model.gguf", minBytes: 8 };
    await assert.rejects(
      fetchOneAdapter(entry, {
        rootDir: dir,
        // HF says 4096 bytes but the download yields 128 → truncation caught.
        fetchJson: async () => [{ type: "file", path: "m.gguf", lfs: { size: 4096 } }],
        downloadToFile: async (url, destPath) => { fs.writeFileSync(destPath, makeGguf(128)); return destPath; },
      }),
      /size mismatch|truncated|Failed to fetch preset:x/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchOneAdapter re-fetches when the existing file is an LFS stub", async () => {
  const dir = tmpDir();
  try {
    const entry = { id: "preset:x", repo: "o/r", revision: "main", sourceFile: "a.gguf", dest: "adapters/x/model.gguf", minBytes: 8 };
    fs.mkdirSync(path.join(dir, "adapters/x"), { recursive: true });
    fs.writeFileSync(path.join(dir, "adapters/x/model.gguf"), LFS_POINTER);
    let downloaded = false;
    const res = await fetchOneAdapter(entry, {
      rootDir: dir,
      fetchJson: async () => [{ type: "file", path: "a.gguf" }],
      downloadToFile: async (url, destPath) => { downloaded = true; fs.writeFileSync(destPath, makeGguf(128)); return destPath; },
    });
    assert.equal(res.action, "downloaded");
    assert.equal(downloaded, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchOneAdapter rejects a downloaded stub instead of installing it", async () => {
  const dir = tmpDir();
  try {
    const entry = { id: "preset:x", repo: "o/r", revision: "main", sourceFile: "a.gguf", dest: "adapters/x/model.gguf", minBytes: 1024 };
    await assert.rejects(
      fetchOneAdapter(entry, {
        rootDir: dir,
        fetchJson: async () => [{ type: "file", path: "a.gguf" }],
        downloadToFile: async (url, destPath) => { fs.writeFileSync(destPath, LFS_POINTER); return destPath; },
      }),
      /Failed to fetch preset:x/
    );
    assert.equal(fs.existsSync(path.join(dir, "adapters/x/model.gguf")), false, "must not leave a bad file in place");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── manifest / packaging guards ─────────────────────────────────────────────

test("the nekoqa preset destination keeps the persona-hint token", () => {
  const neko = REMOTE_ADAPTERS.find((a) => a.id === "preset:nekoqa");
  assert.ok(neko, "preset:nekoqa must exist");
  // _persona_for() and the minicpm-chat filenameHint both key off "nekoqa"/
  // "lora_nekoqa" in the path; losing it would break persona switching.
  assert.match(neko.dest, /lora_nekoqa/);
  assert.match(neko.dest, /\.gguf$/);
  assert.equal(neko.repo, "DennisHuang648/MiniCPM5-1B-NekoQA-v2-LoRA-GGUF");
});

test("prebuild scripts fetch adapters before packaging", () => {
  const pkg = require("../package.json");
  assert.equal(pkg.scripts["fetch:adapters"], FETCH_COMMAND);
  for (const name of ["prebuild", "prebuild:win:x64", "prebuild:mac", "prebuild:linux", "prebuild:all"]) {
    assert.ok(pkg.scripts[name].includes("scripts/fetch-adapters.js"), `${name} should fetch adapters`);
    assert.ok(pkg.scripts[name].includes("scripts/verify-adapters.js"), `${name} should verify adapters`);
  }
});
