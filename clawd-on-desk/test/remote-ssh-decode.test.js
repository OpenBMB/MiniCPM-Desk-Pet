"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { decodeShellBytes, countReplacements } = require("../src/remote-ssh-decode");

test("decodeShellBytes: empty input → empty string", () => {
  assert.equal(decodeShellBytes(null), "");
  assert.equal(decodeShellBytes(undefined), "");
  assert.equal(decodeShellBytes(""), "");
  assert.equal(decodeShellBytes(Buffer.alloc(0)), "");
  assert.equal(decodeShellBytes([]), "");
});

test("decodeShellBytes: clean ASCII passes through", () => {
  const text = "ssh: connect to host pi port 22: Connection refused";
  assert.equal(decodeShellBytes(Buffer.from(text, "utf8")), text);
});

test("decodeShellBytes: valid UTF-8 Chinese stays UTF-8", () => {
  const text = "无法连接到远端主机";
  assert.equal(decodeShellBytes(Buffer.from(text, "utf8")), text);
});

test("decodeShellBytes: CP936/GBK Chinese stderr (Windows cmd) decodes cleanly", () => {
  // Construct GBK bytes the way Chinese Windows cmd.exe would emit on a
  // "command not recognized" error. We encode via TextEncoder is not an
  // option (UTF-8 only), so handcraft the byte sequence for a known phrase.
  //
  // "创建" in GBK:  B4 B4 BD A8
  // "失败" in GBK:  CA A7 B0 DC
  const bytes = Buffer.from([0xb4, 0xb4, 0xbd, 0xa8, 0xca, 0xa7, 0xb0, 0xdc]);
  const decoded = decodeShellBytes(bytes);
  assert.equal(decoded, "创建失败");
});

test("decodeShellBytes: GBK fallback wins when UTF-8 produces replacements", () => {
  // 系统找不到指定的路径 (Windows "system can't find the specified path")
  // GBK bytes: CF B5 CD B3 D5 D2 B2 BB B5 BD D6 B8 B6 A8 B5 C4 C2 B7 BE B6
  const gbkBytes = Buffer.from([
    0xcf, 0xb5, 0xcd, 0xb3, 0xd5, 0xd2, 0xb2, 0xbb,
    0xb5, 0xbd, 0xd6, 0xb8, 0xb6, 0xa8, 0xb5, 0xc4,
    0xc2, 0xb7, 0xbe, 0xb6,
  ]);
  const decoded = decodeShellBytes(gbkBytes);
  assert.equal(decoded, "系统找不到指定的路径");
  assert.equal(countReplacements(decoded), 0);
});

test("decodeShellBytes: accepts an array of Buffer chunks (stream-like input)", () => {
  const a = Buffer.from("hello ", "utf8");
  const b = Buffer.from("远端", "utf8");
  assert.equal(decodeShellBytes([a, b]), "hello 远端");
});

test("decodeShellBytes: prefers UTF-8 on ties (zero replacements both ways)", () => {
  // Pure ASCII has zero replacements in both decoders. UTF-8 wins by
  // virtue of being tried first.
  const buf = Buffer.from("Permission denied (publickey).", "utf8");
  assert.equal(decodeShellBytes(buf), "Permission denied (publickey).");
});

test("countReplacements: counts U+FFFD chars", () => {
  assert.equal(countReplacements(""), 0);
  assert.equal(countReplacements("abc"), 0);
  assert.equal(countReplacements("ab�c�"), 2);
});
