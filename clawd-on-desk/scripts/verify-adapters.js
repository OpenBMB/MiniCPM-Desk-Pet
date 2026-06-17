"use strict";

// Prebuild fuse: refuse to package when a bundled LoRA adapter .gguf is
// missing or is a Git LFS pointer stub (magic 'vers' instead of 'GGUF').
// Pairs with scripts/fetch-adapters.js — verify is the loud failure that
// stops a broken installer from ever shipping. Mirrors the shape of
// scripts/verify-sidecar-binaries.js (pure core, require.main CLI).

const fs = require("node:fs");
const path = require("node:path");

const { REMOTE_ADAPTERS, verifyGgufFileSync } = require("./fetch-adapters");

const VERIFY_COMMAND = "node scripts/verify-adapters.js";
const FETCH_HINT = "run `node scripts/fetch-adapters.js` (or `npm run fetch:adapters`)";

function verifyAdapters(options = {}) {
  const rootDir = options.rootDir || path.join(__dirname, "..");
  const fsModule = options.fs || fs;
  const adapters = options.adapters || REMOTE_ADAPTERS;
  const checked = [];
  const problems = [];
  for (const entry of adapters) {
    const filePath = path.resolve(rootDir, entry.dest);
    checked.push({ id: entry.id, path: filePath });
    try {
      verifyGgufFileSync(filePath, {
        minBytes: entry.minBytes || 0,
        sha256: entry.sha256 || null,
        fs: fsModule,
        label: entry.id,
      });
    } catch (err) {
      problems.push({ id: entry.id, path: filePath, error: err && err.message ? err.message : String(err) });
    }
  }
  return { ok: problems.length === 0, checked, problems };
}

function main() {
  const result = verifyAdapters();
  if (result.checked.length === 0) return;
  if (result.ok) {
    console.log(`Verified ${result.checked.length} bundled LoRA adapter .gguf file(s).`);
    return;
  }
  console.error("Invalid or missing bundled LoRA adapter .gguf file(s):");
  for (const item of result.problems) {
    console.error(`- ${item.id}: ${item.error}`);
  }
  console.error("");
  console.error(`These are fetched from Hugging Face, not committed — ${FETCH_HINT}.`);
  process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  VERIFY_COMMAND,
  verifyAdapters,
};
