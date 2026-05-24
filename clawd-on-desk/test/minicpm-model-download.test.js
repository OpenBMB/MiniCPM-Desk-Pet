"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const downloader = require("../src/minicpm-model-download");

describe("minicpm-model-download", () => {
  it("declares the known Q8_0 GGUF size as a progress fallback", () => {
    assert.equal(downloader.MODEL_SIZE_BYTES, 1_153_529_216);
  });

  it("parses Cloudflare trace country", () => {
    assert.equal(downloader.parseCloudflareTrace("ip=1.2.3.4\nloc=CN\nwarp=off\n"), "CN");
    assert.equal(downloader.parseCloudflareTrace("loc=us\n"), "US");
    assert.equal(downloader.parseCloudflareTrace("ip=1.2.3.4\n"), null);
  });

  it("routes China IPs to ModelScope and other regions to Hugging Face", () => {
    assert.equal(downloader.selectProviderForCountry("CN"), "modelscope");
    assert.equal(downloader.selectProviderForCountry("US"), "huggingface");
    assert.equal(downloader.selectProviderForCountry(null), "modelscope");
  });

  it("supports explicit provider overrides", () => {
    assert.equal(downloader.normalizeProvider("hf"), "huggingface");
    assert.equal(downloader.normalizeProvider("hugging-face"), "huggingface");
    assert.equal(downloader.normalizeProvider("ms"), "modelscope");
    assert.equal(downloader.normalizeProvider("model-scope"), "modelscope");
    assert.equal(downloader.normalizeProvider("unknown"), null);
  });

  it("adds provider tokens only to first-party hosts", () => {
    const hfHeaders = downloader.buildHeaders(
      "huggingface",
      "https://huggingface.co/openbmb/repo/resolve/main/model.gguf",
      { HF_TOKEN: "hf_test" }
    );
    assert.equal(hfHeaders.authorization, "Bearer hf_test");

    const hfCdnHeaders = downloader.buildHeaders(
      "huggingface",
      "https://cdn-lfs.huggingface.co/object",
      { HF_TOKEN: "hf_test" }
    );
    assert.equal(hfCdnHeaders.authorization, undefined);

    const msHeaders = downloader.buildHeaders(
      "modelscope",
      "https://modelscope.cn/models/OpenBMB/repo/resolve/master/model.gguf",
      { MODELSCOPE_API_TOKEN: "ms_test" }
    );
    assert.equal(msHeaders.authorization, "Bearer ms_test");
    assert.match(msHeaders["user-agent"], /modelscope\//);
  });

  it("builds ModelScope snapshot counting headers", () => {
    const headers = downloader.buildModelScopeSnapshotHeaders({
      MODELSCOPE_API_TOKEN: "ms_test",
      MINICPM_MODELSCOPE_SESSION_ID: "fixed-session",
    });

    assert.equal(headers.Snapshot, "True");
    assert.equal(headers.authorization, "Bearer ms_test");
    assert.match(headers["user-agent"], /modelscope\//);
    assert.match(headers["user-agent"], /session_id\/fixed-session/);
    assert.equal(typeof headers["snapshot-identifier"], "string");
    assert.equal(typeof headers["X-Request-ID"], "string");
  });

  it("falls back to the other provider unless forced", () => {
    assert.deepEqual(downloader.providerOrder("modelscope", false), ["modelscope", "huggingface"]);
    assert.deepEqual(downloader.providerOrder("huggingface", false), ["huggingface", "modelscope"]);
    assert.deepEqual(downloader.providerOrder("modelscope", true), ["modelscope"]);
  });
});
