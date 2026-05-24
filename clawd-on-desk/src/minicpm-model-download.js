"use strict";

const fs = require("fs");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const path = require("path");

const MODEL_FILENAME = "MiniCPM5-1B-Q8_0.gguf";
const MODEL_SIZE_BYTES = 1_153_529_216;
const MODELSCOPE_MODEL_ID = "OpenBMB/MiniCPM5-1B-GGUF";
const MODELSCOPE_REVISION = "master";
const PROVIDERS = {
  huggingface: {
    id: "huggingface",
    label: "Hugging Face",
    url: `https://huggingface.co/openbmb/MiniCPM5-1B-GGUF/resolve/main/${MODEL_FILENAME}`,
    authHosts: new Set(["huggingface.co"]),
    tokenEnv: ["HF_TOKEN", "HUGGING_FACE_HUB_TOKEN"],
  },
  modelscope: {
    id: "modelscope",
    label: "ModelScope",
    url: `https://modelscope.cn/models/OpenBMB/MiniCPM5-1B-GGUF/resolve/master/${MODEL_FILENAME}`,
    authHosts: new Set(["modelscope.cn", "www.modelscope.cn"]),
    tokenEnv: ["MODELSCOPE_API_TOKEN", "MS_TOKEN", "MODELSCOPE_TOKEN"],
  },
};

function normalizeProvider(value) {
  const v = String(value || "").trim().toLowerCase();
  if (v === "hf" || v === "huggingface" || v === "hugging-face") return "huggingface";
  if (v === "ms" || v === "modelscope" || v === "model-scope") return "modelscope";
  return null;
}

function parseCloudflareTrace(text) {
  const lines = String(text || "").split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^loc=([A-Za-z]{2})$/);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

function parseCountryText(text) {
  const v = String(text || "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(v) ? v : null;
}

function selectProviderForCountry(country, fallback = "modelscope") {
  const parsed = parseCountryText(country);
  if (parsed === "CN") return "modelscope";
  if (parsed) return "huggingface";
  return normalizeProvider(fallback) || "modelscope";
}

function getTokenForProvider(providerId, env = process.env) {
  const provider = PROVIDERS[providerId];
  if (!provider) return null;
  for (const key of provider.tokenEnv) {
    const value = env && env[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function buildHeaders(providerId, urlStr, env = process.env) {
  const provider = PROVIDERS[providerId];
  const headers = {
    "user-agent": providerId === "modelscope"
      ? buildModelScopeUserAgent(env)
      : "MiniCPM-Desk-Pet/1.0",
  };
  if (!provider) return headers;
  let hostname = "";
  try { hostname = new URL(urlStr).hostname; } catch {}
  const token = getTokenForProvider(providerId, env);
  if (token && provider.authHosts.has(hostname)) {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

function randomId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return crypto.randomBytes(16).toString("hex");
}

function buildModelScopeUserAgent(env = process.env) {
  const appVersion = env.MINICPM_DESK_PET_VERSION || "1.0";
  const sessionId = env.MINICPM_MODELSCOPE_SESSION_ID || randomId();
  const cloudEnv = env.MODELSCOPE_CLOUD_ENVIRONMENT || "custom";
  const user = env.MODELSCOPE_CLOUD_USERNAME || "unknown";
  return [
    "modelscope/1.33.0",
    `node/${process.versions && process.versions.node ? process.versions.node : "unknown"}`,
    `session_id/${sessionId}`,
    `platform/${process.platform}-${process.arch}`,
    `processor/${process.arch}`,
    `env/${cloudEnv}`,
    `user/${user}`,
    `minicpm-desk-pet/${appVersion}`,
  ].join("; ");
}

function buildModelScopeSnapshotHeaders(env = process.env) {
  const requestId = randomId();
  const headers = buildHeaders("modelscope", "https://www.modelscope.cn", env);
  headers.Snapshot = "True";
  headers["snapshot-identifier"] = randomId();
  headers["X-Request-ID"] = requestId.replace(/-/g, "");
  return headers;
}

function triggerModelScopeSnapshotCount({
  env = process.env,
  modelId = MODELSCOPE_MODEL_ID,
  revision = MODELSCOPE_REVISION,
  timeoutMs = 5000,
} = {}) {
  return new Promise((resolve, reject) => {
    const encodedModelId = modelId.split("/").map(encodeURIComponent).join("/");
    const urlStr = `https://www.modelscope.cn/api/v1/models/${encodedModelId}/repo/files?Revision=${encodeURIComponent(revision)}&Recursive=True`;
    const u = new URL(urlStr);
    const req = https.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || undefined,
      path: u.pathname + (u.search || ""),
      method: "GET",
      headers: buildModelScopeSnapshotHeaders(env),
      timeout: timeoutMs,
    }, (res) => {
      const status = res.statusCode || 0;
      res.resume();
      res.on("end", () => {
        if (status >= 200 && status < 300) {
          resolve({ ok: true, status });
        } else {
          reject(new Error(`snapshot count failed with HTTP ${status}`));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("snapshot count timeout")));
    req.on("error", reject);
    req.end();
  });
}

function requestText(urlStr, { timeoutMs = 2500, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const u = new URL(urlStr);
    const client = u.protocol === "https:" ? https : http;
    const req = client.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || undefined,
      path: u.pathname + (u.search || ""),
      method: "GET",
      headers: { "user-agent": env.MINICPM_USER_AGENT || "MiniCPM-Desk-Pet/1.0" },
      timeout: timeoutMs,
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        if (settled) return;
        settled = true;
        if ((res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300) {
          resolve(body);
        } else {
          reject(new Error(`HTTP ${res.statusCode || 0}`));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    req.end();
  });
}

async function detectCountry({ env = process.env, requestTextImpl = requestText } = {}) {
  const override = env.MINICPM_MODEL_COUNTRY;
  const parsedOverride = parseCountryText(override);
  if (parsedOverride) return { country: parsedOverride, source: "env" };

  try {
    const trace = await requestTextImpl("https://www.cloudflare.com/cdn-cgi/trace", { timeoutMs: 2500, env });
    const country = parseCloudflareTrace(trace);
    if (country) return { country, source: "cloudflare" };
  } catch {}

  try {
    const country = parseCountryText(await requestTextImpl("https://ipapi.co/country/", { timeoutMs: 2500, env }));
    if (country) return { country, source: "ipapi" };
  } catch {}

  return { country: null, source: "unknown" };
}

function providerOrder(selectedProvider, forced = false) {
  const first = normalizeProvider(selectedProvider) || "huggingface";
  if (forced) return [first];
  const other = first === "modelscope" ? "huggingface" : "modelscope";
  return [first, other];
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function removeQuietly(file) {
  try { fs.rmSync(file, { force: true }); } catch {}
}

function downloadUrlToFile({
  providerId,
  url,
  destination,
  env = process.env,
  onProgress,
  maxRedirects = 8,
}) {
  return new Promise((resolve, reject) => {
    const tmp = `${destination}.part`;
    let file = null;
    let bytesDone = 0;

    function fail(err) {
      try { if (file) file.destroy(); } catch {}
      removeQuietly(tmp);
      reject(err);
    }

    function request(currentUrl, redirectsLeft) {
      let u;
      try { u = new URL(currentUrl); } catch (err) { fail(err); return; }
      const client = u.protocol === "https:" ? https : http;
      const req = client.request({
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + (u.search || ""),
        method: "GET",
        headers: buildHeaders(providerId, currentUrl, env),
      }, (res) => {
        const status = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            fail(new Error("too many redirects"));
            return;
          }
          const nextUrl = new URL(res.headers.location, currentUrl).toString();
          request(nextUrl, redirectsLeft - 1);
          return;
        }

        if (status < 200 || status >= 300) {
          res.resume();
          fail(new Error(`download failed with HTTP ${status}`));
          return;
        }

        const total = Number(res.headers["content-length"]) || MODEL_SIZE_BYTES;
        file = fs.createWriteStream(tmp);
        res.on("error", fail);
        res.on("data", (chunk) => {
          bytesDone += chunk.length;
          try {
            if (typeof onProgress === "function") {
              onProgress({
                phase: "transfer",
                provider: providerId,
                file: MODEL_FILENAME,
                bytes_done: bytesDone,
                bytes_total: total,
              });
            }
          } catch {}
        });
        res.pipe(file);
        file.on("finish", () => {
          file.close((err) => {
            if (err) { fail(err); return; }
            try {
              fs.renameSync(tmp, destination);
              resolve({ ok: true, bytes: bytesDone, path: destination });
            } catch (renameErr) {
              fail(renameErr);
            }
          });
        });
        file.on("error", fail);
      });
      req.on("error", fail);
      req.setTimeout(30_000, () => req.destroy(new Error("download timeout")));
      req.end();
    }

    removeQuietly(tmp);
    request(url, maxRedirects);
  });
}

async function downloadMiniCpmModel({
  destinationDir,
  env = process.env,
  onProgress,
  requestTextImpl = requestText,
  downloadImpl = downloadUrlToFile,
  snapshotCountImpl = triggerModelScopeSnapshotCount,
} = {}) {
  if (!destinationDir) throw new Error("destinationDir is required");
  ensureDir(destinationDir);
  const destination = path.join(destinationDir, MODEL_FILENAME);
  try {
    const st = fs.statSync(destination);
    if (st.isFile() && st.size > 0) {
      return { ok: true, path: destination, bytes: st.size, provider: "local", skipped: true };
    }
  } catch {}

  const forcedProvider = normalizeProvider(env.MINICPM_MODEL_PROVIDER);
  const geo = forcedProvider
    ? { country: null, source: "env-provider" }
    : await detectCountry({ env, requestTextImpl });
  const selected = forcedProvider || selectProviderForCountry(
    geo.country,
    env.MINICPM_MODEL_PROVIDER_FALLBACK || "modelscope"
  );
  const attempts = providerOrder(selected, !!forcedProvider);
  const errors = [];

  for (const providerId of attempts) {
    const provider = PROVIDERS[providerId];
    try {
      if (typeof onProgress === "function") {
        onProgress({ phase: "route", provider: providerId, country: geo.country, countrySource: geo.source });
      }
      if (providerId === "modelscope" && typeof snapshotCountImpl === "function") {
        try {
          await snapshotCountImpl({ env });
          if (typeof onProgress === "function") {
            onProgress({ phase: "snapshot-count", provider: providerId, ok: true });
          }
        } catch (snapshotErr) {
          if (typeof onProgress === "function") {
            onProgress({
              phase: "snapshot-count",
              provider: providerId,
              ok: false,
              message: String(snapshotErr && snapshotErr.message || snapshotErr),
            });
          }
        }
      }
      const result = await downloadImpl({
        providerId,
        url: provider.url,
        destination,
        env,
        onProgress,
      });
      if (typeof onProgress === "function") {
        onProgress({ phase: "complete", provider: providerId, file: MODEL_FILENAME, path: destination });
      }
      return {
        ...result,
        provider: providerId,
        country: geo.country,
        countrySource: geo.source,
        url: provider.url,
      };
    } catch (err) {
      const message = String((err && err.message) || err);
      errors.push({ provider: providerId, message });
      if (typeof onProgress === "function") {
        onProgress({ phase: "retry", provider: providerId, message });
      }
    }
  }

  const detail = errors.map((e) => `${e.provider}: ${e.message}`).join("; ");
  const error = new Error(detail || "download failed");
  error.errors = errors;
  throw error;
}

module.exports = {
  MODEL_FILENAME,
  MODEL_SIZE_BYTES,
  MODELSCOPE_MODEL_ID,
  MODELSCOPE_REVISION,
  PROVIDERS,
  buildHeaders,
  buildModelScopeSnapshotHeaders,
  buildModelScopeUserAgent,
  detectCountry,
  downloadMiniCpmModel,
  getTokenForProvider,
  normalizeProvider,
  parseCloudflareTrace,
  parseCountryText,
  providerOrder,
  selectProviderForCountry,
  triggerModelScopeSnapshotCount,
};
