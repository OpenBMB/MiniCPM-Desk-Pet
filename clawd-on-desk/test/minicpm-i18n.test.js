"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const minicpm = require("../src/minicpm-i18n");

const SUPPORTED = minicpm.SUPPORTED_LANGS;

function placeholders(value) {
  return Array.from(String(value).matchAll(/\{[^}]+\}/g), (m) => m[0]).sort();
}

describe("minicpm-i18n", () => {
  it("declares the 5 supported UI languages", () => {
    assert.deepStrictEqual(SUPPORTED, ["en", "zh", "zh-TW", "ko", "ja"]);
  });

  it("STRINGS keysets align with English across all supported langs", () => {
    const baseKeys = Object.keys(minicpm.STRINGS.en).sort();
    assert.ok(baseKeys.length > 50, "English STRINGS should be well-populated");
    for (const lang of SUPPORTED) {
      const dict = minicpm.STRINGS[lang];
      assert.ok(dict, `missing STRINGS[${lang}]`);
      assert.deepStrictEqual(
        Object.keys(dict).sort(),
        baseKeys,
        `STRINGS[${lang}] keys diverge from en`
      );
      for (const key of baseKeys) {
        assert.strictEqual(
          typeof dict[key],
          "string",
          `STRINGS[${lang}].${key} should be a string`
        );
        assert.deepStrictEqual(
          placeholders(dict[key]),
          placeholders(minicpm.STRINGS.en[key]),
          `STRINGS[${lang}].${key} placeholder mismatch`
        );
      }
    }
  });

  it("COMMAND_PATTERNS share the same structure across langs", () => {
    const baseKeys = Object.keys(minicpm.COMMAND_PATTERNS.en).sort();
    assert.ok(baseKeys.includes("hints"), "expected `hints` pattern");
    assert.ok(baseKeys.includes("status"), "expected `status` pattern");
    for (const lang of SUPPORTED) {
      const patterns = minicpm.COMMAND_PATTERNS[lang];
      assert.deepStrictEqual(
        Object.keys(patterns).sort(),
        baseKeys,
        `COMMAND_PATTERNS[${lang}] keys diverge from en`
      );
      for (const key of baseKeys) {
        assert.ok(
          patterns[key] instanceof RegExp,
          `COMMAND_PATTERNS[${lang}].${key} should be a RegExp`
        );
      }
    }
  });

  it("CLASSIFIER_PROMPTS provide a non-empty prompt per lang", () => {
    for (const lang of SUPPORTED) {
      const entry = minicpm.CLASSIFIER_PROMPTS[lang];
      assert.ok(entry && typeof entry.prompt === "string", `missing prompt for ${lang}`);
      assert.ok(entry.prompt.length > 100, `${lang} classifier prompt looks too short`);
    }
  });

  it("NARRATION provides parity keys + a non-empty system prompt per lang", () => {
    const baseKeys = Object.keys(minicpm.NARRATION.en).sort();
    assert.ok(baseKeys.includes("systemPrompt"));
    for (const lang of SUPPORTED) {
      const dict = minicpm.NARRATION[lang];
      assert.deepStrictEqual(
        Object.keys(dict).sort(),
        baseKeys,
        `NARRATION[${lang}] keys diverge from en`
      );
      assert.ok(dict.systemPrompt.length > 100, `${lang} narration prompt looks too short`);
      for (const key of baseKeys) {
        if (key === "systemPrompt") continue;
        assert.deepStrictEqual(
          placeholders(dict[key]),
          placeholders(minicpm.NARRATION.en[key]),
          `NARRATION[${lang}].${key} placeholder mismatch`
        );
      }
    }
  });

  describe("makeTranslator", () => {
    it("substitutes placeholders", () => {
      let lang = "en";
      const t = minicpm.makeTranslator(() => lang);
      assert.strictEqual(
        t("onboardingDiskAvailable", { free: "10 GB", need: "5 GB" }),
        "10 GB available (need 5 GB)"
      );
      lang = "zh";
      assert.strictEqual(
        t("onboardingDiskAvailable", { free: "10 GB", need: "5 GB" }),
        "可用 10 GB（需要 5 GB）"
      );
    });

    it("falls back to en when a lang is unknown", () => {
      const t = minicpm.makeTranslator(() => "klingon");
      assert.strictEqual(t("onboardingNext"), "Next");
    });

    it("returns the key untouched when the key is unknown", () => {
      const t = minicpm.makeTranslator(() => "en");
      assert.strictEqual(t("doesNotExist"), "doesNotExist");
    });
  });

  describe("serializePatterns / deserializePatterns", () => {
    it("round-trips RegExp objects through plain JSON", () => {
      const en = minicpm.COMMAND_PATTERNS.en;
      const serialized = minicpm.serializePatterns(en);
      const json = JSON.parse(JSON.stringify(serialized));
      const deserialized = minicpm.deserializePatterns(json);
      for (const key of Object.keys(en)) {
        assert.ok(deserialized[key] instanceof RegExp, `${key} should round-trip to RegExp`);
        assert.strictEqual(deserialized[key].source, en[key].source);
        assert.strictEqual(deserialized[key].flags, en[key].flags);
      }
    });
  });

  describe("getMinicpmI18nPayload", () => {
    it("bundles strings + serialized patterns + classifier + narration for one lang", () => {
      const payload = minicpm.getMinicpmI18nPayload("zh");
      assert.strictEqual(payload.lang, "zh");
      assert.strictEqual(payload.strings.menuMinicpmChat, "MiniCPM Chat");
      assert.ok(payload.commandPatterns.hints.source, "patterns are serialized");
      assert.ok(typeof payload.classifierPrompt === "string");
      assert.ok(payload.narration.systemPrompt.length > 100);
    });
  });
});
