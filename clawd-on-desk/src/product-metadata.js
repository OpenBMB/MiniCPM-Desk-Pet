"use strict";

const pkg = require("../package.json");

const DEFAULT_UPSTREAM_LABEL = "clawd-on-desk";
const DEFAULT_UPSTREAM_URL = "https://github.com/rullerzhou-afk/" + DEFAULT_UPSTREAM_LABEL;
const MODEL_REPO_URL = "https://huggingface.co/openbmb/MiniCPM5-1B-GGUF";

function normalizeRepoUrl(url) {
  if (!url || typeof url !== "string") return null;
  return url.replace(/\.git$/i, "").trim();
}

function parseGitHubRepo(url) {
  const normalized = normalizeRepoUrl(url);
  if (!normalized) return null;
  const match = normalized.match(/github\.com\/([^/]+)\/([^/]+)/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

function extractCopyrightShort(copyright) {
  if (!copyright) return "\u00a9 2026 OpenBMB";
  const match = String(copyright).match(/Copyright\s*\u00a9?\s*(\d{4})\s+([^.\n]+)/i);
  if (match) return `\u00a9 ${match[1]} ${match[2].trim()}`;
  return "\u00a9 2026 OpenBMB";
}

const repoUrl = normalizeRepoUrl(pkg.homepage) || normalizeRepoUrl(pkg.repository && pkg.repository.url);
const githubRepo = parseGitHubRepo(repoUrl);
const upstreamRepoUrl = normalizeRepoUrl(pkg.upstreamRepository) || DEFAULT_UPSTREAM_URL;
const upstreamMatch = parseGitHubRepo(upstreamRepoUrl);
const productName = (pkg.build && pkg.build.productName) || "MiniCPM Desk Pet";
const userAgent = productName.replace(/\s+/g, "-");

module.exports = {
  appDisplayName: productName,
  licenseId: pkg.license || "AGPL-3.0-only",
  copyrightLine: extractCopyrightShort(pkg.build && pkg.build.copyright),
  repoUrl,
  modelRepoUrl: MODEL_REPO_URL,
  releasesLatestUrl: repoUrl ? `${repoUrl}/releases/latest` : null,
  githubOwner: githubRepo ? githubRepo.owner : null,
  githubRepo: githubRepo ? githubRepo.repo : null,
  githubReleasesApiPath: githubRepo
    ? `/repos/${githubRepo.owner}/${githubRepo.repo}/releases/latest`
    : null,
  upstreamRepoUrl,
  upstreamLabel: (upstreamMatch && upstreamMatch.repo) || DEFAULT_UPSTREAM_LABEL,
  userAgent,
};
