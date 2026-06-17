"use strict";

// ── Remote SSH stderr/stdout byte decoding ──
//
// Remote ssh stderr can arrive in any locale's encoding. Windows OpenSSH
// server (with cmd.exe as default shell) on Simplified Chinese Windows
// emits CP936/GBK bytes; default `Buffer.toString()` decodes those as
// UTF-8 and produces mojibake (the original "[fail] 创建远端 hook 目录 -
// ????????j??" symptom). Same risk on Linux hosts with a non-UTF-8 locale.
//
// We accumulate raw Buffer chunks and run a single decode attempt at the
// end: try UTF-8 first, count U+FFFD replacements, and if the result has
// any, try GB18030 (a strict superset of GBK / CP936 — also handles
// GB2312). Whichever pass produces fewer replacements wins. GB18030 is
// the chosen fallback because Node 18+ / Electron ship full ICU and
// GB18030 covers the realistic Chinese-Windows / Chinese-Linux cases
// without needing a third-party dependency.

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: false });
let GB18030_DECODER = null;

function getGb18030Decoder() {
  if (GB18030_DECODER === null) {
    try {
      GB18030_DECODER = new TextDecoder("gb18030", { fatal: false });
    } catch {
      GB18030_DECODER = false;
    }
  }
  return GB18030_DECODER || null;
}

function countReplacements(text) {
  if (!text) return 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0xfffd) n++;
  }
  return n;
}

function toBuffer(input) {
  if (input == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(input)) return input;
  if (Array.isArray(input)) {
    const parts = input.filter(Buffer.isBuffer);
    if (parts.length === input.length) return Buffer.concat(parts);
    return Buffer.from(String(input));
  }
  if (ArrayBuffer.isView(input)) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  return Buffer.from(String(input));
}

// Decode a byte buffer that came from a remote ssh stream. Tries UTF-8
// first; if any replacement chars appear, retries with GB18030 and keeps
// whichever decode has fewer replacements (ties go to UTF-8).
function decodeShellBytes(input) {
  const buf = toBuffer(input);
  if (buf.length === 0) return "";
  const utf = UTF8_DECODER.decode(buf);
  const utfBad = countReplacements(utf);
  if (utfBad === 0) return utf;
  const gb = getGb18030Decoder();
  if (!gb) return utf;
  const gbText = gb.decode(buf);
  const gbBad = countReplacements(gbText);
  return gbBad < utfBad ? gbText : utf;
}

module.exports = {
  decodeShellBytes,
  countReplacements,
};
