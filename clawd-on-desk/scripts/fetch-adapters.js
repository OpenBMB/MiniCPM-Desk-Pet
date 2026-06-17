"use strict";

// Fetch bundled LoRA adapter weights (.gguf) from Hugging Face at build
// time. The .gguf artefacts are intentionally NOT stored in git/LFS
// anymore (see .gitattributes / .gitignore) — shipping them via Git LFS
// meant CI checkouts without `lfs: true` bundled 130-byte pointer stubs,
// which llama.cpp rejects with "invalid magic characters: 'vers'".
//
// This mirrors scripts/fetch-sidecar-binaries.js: Node built-ins only,
// pure helpers exported for unit tests, atomic temp-file install, and a
// CLI entry guarded by require.main.

const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");

const FETCH_COMMAND = "node scripts/fetch-adapters.js";
const USER_AGENT = "minicpm-desk-pet-adapter-fetcher";
const GGUF_MAGIC = "GGUF"; // first 4 bytes of every valid GGUF file

// Bundled adapters fetched into <repo>/adapters/ before electron-builder's
// extraResources picks them up. `dest` is relative to this script's parent
// (clawd-on-desk/), so "../adapters/..." lands at <repo>/adapters/... — the
// exact tree electron-builder copies from.
//
// Persona/preset wiring keys off the path: the gateway's _persona_for()
// matches "nekoqa" and minicpm-chat.js's preset filenameHint is
// "lora_nekoqa", so the destination dir name must keep that token.
const REMOTE_ADAPTERS = Object.freeze([
  Object.freeze({
    id: "preset:nekoqa",
    repo: "DennisHuang648/MiniCPM5-1B-NekoQA-v2-LoRA-GGUF",
    revision: "main",
    // null → auto-discover the single *.gguf via the HF tree API.
    sourceFile: null,
    dest: path.join("..", "adapters", "lora_nekoqa_v2_fixedbase_adapter_20260524_0959", "adapter_model.f16.gguf"),
    // An LFS pointer stub is ~130 bytes; the real f16 adapter is ~22 MiB.
    minBytes: 1_000_000,
    // Optional hard pin. Leave null to verify each download against Hugging
    // Face's own published LFS sha256 (auto-fetched from the tree API) —
    // that already catches corrupt/truncated transfers. Set this only to
    // lock a specific known-good revision; the file page on huggingface.co
    // shows the sha256 to use.
    sha256: null,
  }),
]);

// ── Hugging Face URL helpers ────────────────────────────────────────────────

function encodeRepoPath(filePath) {
  return String(filePath)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function buildTreeApiUrl(repo, revision = "main") {
  return `https://huggingface.co/api/models/${repo}/tree/${revision}`;
}

function buildResolveUrl(repo, revision, filePath) {
  return `https://huggingface.co/${repo}/resolve/${revision || "main"}/${encodeRepoPath(filePath)}?download=true`;
}

function hfAuthHeaders(env = process.env) {
  const token = env.HF_TOKEN || env.HUGGING_FACE_HUB_TOKEN || env.HUGGINGFACE_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// Pick the single .gguf entry from an HF tree listing. Throws (rather than
// guessing) when the choice is ambiguous so a repo layout change surfaces
// loudly instead of silently fetching the wrong file. Returns the full
// entry object so callers can read its LFS checksum/size metadata.
function pickGgufEntry(tree, options = {}) {
  const sourceFile = options.sourceFile || null;
  const entries = (Array.isArray(tree) ? tree : []).filter(
    (e) => e && typeof e.path === "string" && (e.type === "file" || e.type === undefined)
  );
  if (sourceFile) {
    const hit = entries.find((e) => e.path === sourceFile);
    if (!hit) throw new Error(`sourceFile "${sourceFile}" not found in repo tree`);
    return hit;
  }
  const ggufs = entries.filter((e) => e.path.toLowerCase().endsWith(".gguf"));
  if (ggufs.length === 0) {
    throw new Error("no .gguf file found in repo tree; set an explicit sourceFile");
  }
  if (ggufs.length > 1) {
    throw new Error(
      `multiple .gguf files found (${ggufs.map((e) => e.path).join(", ")}); set an explicit sourceFile`
    );
  }
  return ggufs[0];
}

function pickGgufFromTree(tree, options = {}) {
  return pickGgufEntry(tree, options).path;
}

// HF marks large files as LFS and publishes their sha256 + size in the tree
// listing: `{ lfs: { oid: "<sha256hex>" | "sha256:<hex>", size } }`. We use
// that published checksum to verify the download byte-for-byte — no need to
// hardcode a hash, and a corrupt/truncated download fails the build loudly.
function extractLfsSha256(entry) {
  const oid = entry && entry.lfs && (entry.lfs.oid || entry.lfs.sha256);
  if (typeof oid !== "string") return null;
  const hex = oid.startsWith("sha256:") ? oid.slice(7) : oid;
  return /^[a-f0-9]{64}$/i.test(hex) ? hex.toLowerCase() : null;
}

function extractFileSize(entry) {
  if (!entry) return null;
  if (entry.lfs && Number.isFinite(entry.lfs.size)) return entry.lfs.size;
  if (Number.isFinite(entry.size)) return entry.size;
  return null;
}

// ── GGUF verification ───────────────────────────────────────────────────────

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function isGgufMagic(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 4 && buffer.subarray(0, 4).toString("latin1") === GGUF_MAGIC;
}

// Human-readable hint for a bad header — the classic failure is an LFS
// pointer whose first bytes are "vers" (from "version https://git-lfs...").
function describeBadMagic(buffer) {
  const head = Buffer.isBuffer(buffer) ? buffer.subarray(0, 4).toString("latin1") : "";
  if (head === "vers") {
    return "looks like a Git LFS pointer stub (run `git lfs pull` or re-run fetch-adapters)";
  }
  return `unexpected magic ${JSON.stringify(head)} (expected '${GGUF_MAGIC}')`;
}

// Verify an in-memory buffer is a plausible full GGUF. Pure; used by tests.
function verifyGgufBuffer(buffer, options = {}) {
  const { minBytes = 0, sha256: expectedSha = null, label = "adapter" } = options;
  if (!Buffer.isBuffer(buffer)) throw new Error(`${label}: not a buffer`);
  if (buffer.length < minBytes) {
    throw new Error(`${label}: too small (${buffer.length} bytes < ${minBytes}); ${describeBadMagic(buffer)}`);
  }
  if (!isGgufMagic(buffer)) {
    throw new Error(`${label}: invalid GGUF magic — ${describeBadMagic(buffer)}`);
  }
  if (expectedSha) {
    const got = sha256(buffer);
    if (got !== String(expectedSha).toLowerCase()) {
      throw new Error(`${label}: sha256 mismatch (got ${got}, expected ${expectedSha})`);
    }
  }
  return true;
}

function readHead(fsModule, filePath, byteCount) {
  if (typeof fsModule.openSync === "function" && typeof fsModule.readSync === "function") {
    const fd = fsModule.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(byteCount);
      const bytes = fsModule.readSync(fd, buf, 0, byteCount, 0);
      return buf.subarray(0, bytes);
    } finally {
      fsModule.closeSync(fd);
    }
  }
  // Fallback for minimal fs shims (read the whole file, slice the head).
  return fsModule.readFileSync(filePath).subarray(0, byteCount);
}

// Verify an on-disk GGUF without loading the whole file unless a sha256
// pin requires it. Throws a descriptive error; returns { ok, size }.
function verifyGgufFileSync(filePath, options = {}) {
  const { minBytes = 0, sha256: expectedSha = null, expectedSize = null, fs: fsModule = fs, label = filePath } = options;
  let stat;
  try {
    stat = fsModule.statSync(filePath);
  } catch {
    throw new Error(`${label}: missing file`);
  }
  if (typeof stat.isFile === "function" && !stat.isFile()) {
    throw new Error(`${label}: not a regular file`);
  }
  const size = typeof stat.size === "number" ? stat.size : 0;
  const head = readHead(fsModule, filePath, 4);
  if (size < minBytes) {
    throw new Error(`${label}: too small (${size} bytes < ${minBytes}); ${describeBadMagic(head)}`);
  }
  if (!isGgufMagic(head)) {
    throw new Error(`${label}: invalid GGUF magic — ${describeBadMagic(head)}`);
  }
  if (expectedSize != null && size !== expectedSize) {
    throw new Error(`${label}: size mismatch (got ${size}, expected ${expectedSize}) — download likely truncated`);
  }
  if (expectedSha) {
    const got = sha256(fsModule.readFileSync(filePath));
    if (got !== String(expectedSha).toLowerCase()) {
      throw new Error(`${label}: sha256 mismatch (got ${got}, expected ${expectedSha}) — download corrupt`);
    }
  }
  return { ok: true, size };
}

// ── Networking ──────────────────────────────────────────────────────────────

function downloadBuffer(url, options = {}) {
  const { headers = {}, timeoutMs = 60000, redirects = 0, accept = "application/json" } = options;
  if (redirects > 6) return Promise.reject(new Error(`Too many redirects while requesting ${url}`));
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": USER_AGENT, Accept: accept, ...headers } }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        downloadBuffer(new URL(res.headers.location, url).toString(), { ...options, redirects: redirects + 1 }).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error(`Request failed (${status}) for ${url}`));
        return;
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Request timed out for ${url}`)));
  });
}

function fetchJson(url, options = {}) {
  return downloadBuffer(url, options).then((buf) => JSON.parse(buf.toString("utf8")));
}

// Stream a (potentially large) download straight to disk. Uses the real
// fs for streams; tests inject their own downloader instead.
function downloadToFile(url, destPath, options = {}) {
  const { headers = {}, timeoutMs = 300000, redirects = 0 } = options;
  if (redirects > 6) return Promise.reject(new Error(`Too many redirects while downloading ${url}`));
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/octet-stream", ...headers } }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        downloadToFile(new URL(res.headers.location, url).toString(), destPath, { ...options, redirects: redirects + 1 }).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error(`Download failed (${status}) for ${url}`));
        return;
      }
      const out = fs.createWriteStream(destPath);
      out.on("error", reject);
      out.on("finish", () => out.close((err) => (err ? reject(err) : resolve(destPath))));
      res.on("error", reject);
      res.pipe(out);
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Download timed out for ${url}`)));
  });
}

async function withRetry(fn, options = {}) {
  const { attempts = 3, onRetry = () => {} } = options;
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) onRetry(err, attempt);
    }
  }
  throw lastErr;
}

// ── Adapter selection ───────────────────────────────────────────────────────

function selectAdapters(raw, adapters = REMOTE_ADAPTERS) {
  const value = String(raw || "all").trim();
  if (!value || value === "all") return adapters.map((a) => ({ ...a }));
  const byId = new Map(adapters.map((a) => [a.id, a]));
  const seen = new Set();
  const selected = [];
  for (const part of value.split(",")) {
    const id = part.trim();
    if (!id) continue;
    const entry = byId.get(id);
    if (!entry) {
      throw new Error(`Unknown adapter "${id}". Expected one of: all, ${adapters.map((a) => a.id).join(", ")}`);
    }
    if (seen.has(id)) continue;
    seen.add(id);
    selected.push({ ...entry });
  }
  return selected;
}

// ── Fetch one / all ─────────────────────────────────────────────────────────

async function fetchOneAdapter(entry, options = {}) {
  const fsModule = options.fs || fs;
  const rootDir = options.rootDir || path.join(__dirname, "..");
  const log = options.log || (() => {});
  const env = options.env || process.env;
  const fetchJsonFn = options.fetchJson || fetchJson;
  const downloadFn = options.downloadToFile || downloadToFile;

  const destPath = path.resolve(rootDir, entry.dest);
  const minBytes = entry.minBytes || 0;
  const pinnedSha = entry.sha256 || null;
  const skipVerifyOpts = { minBytes, sha256: pinnedSha, fs: fsModule, label: entry.id };

  // 1. Idempotent skip: a valid on-disk copy (e.g. a dev `git lfs pull`,
  // or a previous fetch) means there's nothing to do. Offline by design —
  // checks magic + size (+ any manifest sha pin), never the network.
  if (fsModule.existsSync(destPath)) {
    try {
      const { size } = verifyGgufFileSync(destPath, skipVerifyOpts);
      log(`already present: ${entry.id} (${size} bytes) -> ${destPath}`);
      return { id: entry.id, path: destPath, action: "skipped" };
    } catch (err) {
      log(`existing ${entry.id} failed verification (${err.message}); re-fetching`);
    }
  }

  const headers = { ...hfAuthHeaders(env), ...(options.headers || {}) };
  const treeUrl = buildTreeApiUrl(entry.repo, entry.revision);

  // 2. Look up the file in the repo tree to (a) discover the filename when
  // not pinned and (b) read Hugging Face's published LFS sha256 + size, so
  // the download can be verified byte-for-byte. This is what catches a
  // corrupt/truncated transfer and fails the build instead of shipping junk.
  let sourceFile = entry.sourceFile;
  let remoteSha = null;
  let remoteSize = null;
  if (entry.sourceFile) {
    // Filename already known: fetching the checksum is best-effort.
    try {
      const tree = await fetchJsonFn(treeUrl, { headers, timeoutMs: options.requestTimeoutMs });
      const chosen = pickGgufEntry(tree, { sourceFile: entry.sourceFile });
      remoteSha = extractLfsSha256(chosen);
      remoteSize = extractFileSize(chosen);
    } catch (e) {
      log(`could not read HF checksum for ${entry.id} (${e.message}); verifying magic + size only`);
    }
  } else {
    // Discovery required: a tree failure here is fatal (filename unknown).
    const tree = await withRetry(
      () => fetchJsonFn(treeUrl, { headers, timeoutMs: options.requestTimeoutMs }),
      { attempts: 3, onRetry: (e, i) => log(`tree fetch retry ${i} for ${entry.id}: ${e.message}`) }
    );
    const chosen = pickGgufEntry(tree, {});
    sourceFile = chosen.path;
    remoteSha = extractLfsSha256(chosen);
    remoteSize = extractFileSize(chosen);
  }
  // Manifest pin wins (lets you lock a known-good version); otherwise verify
  // against HF's own published checksum.
  const expectedSha = pinnedSha || remoteSha || null;
  if (expectedSha) log(`will verify ${entry.id} against sha256 ${expectedSha.slice(0, 12)}…`);
  else log(`no published checksum for ${entry.id}; verifying magic + size only`);
  const url = buildResolveUrl(entry.repo, entry.revision, sourceFile);

  // 3. Download to a temp file, verify (magic + size + sha256), then
  // atomically rename into place.
  fsModule.mkdirSync(path.dirname(destPath), { recursive: true });
  const tmpPath = `${destPath}.download-${process.pid}`;
  try {
    log(`downloading ${entry.id} <- ${url}`);
    await withRetry(
      () => downloadFn(url, tmpPath, { headers, timeoutMs: options.downloadTimeoutMs }),
      {
        attempts: 3,
        onRetry: (e, i) => {
          try { fsModule.rmSync(tmpPath, { force: true }); } catch {}
          log(`download retry ${i} for ${entry.id}: ${e.message}`);
        },
      }
    );
    verifyGgufFileSync(tmpPath, {
      minBytes,
      sha256: expectedSha,
      expectedSize: remoteSize,
      fs: fsModule,
      label: entry.id,
    });
    fsModule.renameSync(tmpPath, destPath);
  } catch (err) {
    try { fsModule.rmSync(tmpPath, { force: true }); } catch {}
    throw new Error(`Failed to fetch ${entry.id} from ${entry.repo}: ${err.message}`);
  }
  log(`fetched ${entry.id} -> ${destPath}`);
  return { id: entry.id, path: destPath, action: "downloaded", source: url };
}

async function fetchAdapters(options = {}) {
  const adapters = selectAdapters(options.target || "all", options.adapters || REMOTE_ADAPTERS);
  if (options.dryRun) {
    const rootDir = options.rootDir || path.join(__dirname, "..");
    return {
      ok: true,
      results: adapters.map((entry) => ({
        id: entry.id,
        repo: entry.repo,
        revision: entry.revision,
        dest: path.resolve(rootDir, entry.dest),
      })),
    };
  }
  const results = [];
  for (const entry of adapters) {
    results.push(await fetchOneAdapter(entry, options));
  }
  return { ok: true, results };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { target: "all", dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--target" || arg === "--id") out.target = argv[++i];
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function printHelp(stdout = process.stdout) {
  stdout.write(`Usage: ${FETCH_COMMAND} [--target all|<id>[,..]] [--dry-run]\n`);
  stdout.write(`Adapters: ${REMOTE_ADAPTERS.map((a) => a.id).join(", ")}\n`);
  stdout.write(`Optional auth: set HF_TOKEN for gated/private repos.\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const result = await fetchAdapters({ target: args.target, dryRun: args.dryRun, log: (m) => console.log(m) });
  if (args.dryRun) {
    console.log(JSON.stringify(result.results, null, 2));
    return;
  }
  const downloaded = result.results.filter((r) => r.action === "downloaded").length;
  const skipped = result.results.filter((r) => r.action === "skipped").length;
  console.log(`Adapters ready: ${result.results.length} (${downloaded} downloaded, ${skipped} already present).`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.message ? err.message : err);
    process.exitCode = 1;
  });
}

module.exports = {
  FETCH_COMMAND,
  GGUF_MAGIC,
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
  readHead,
  downloadBuffer,
  fetchJson,
  downloadToFile,
  withRetry,
  selectAdapters,
  fetchOneAdapter,
  fetchAdapters,
  parseArgs,
};
