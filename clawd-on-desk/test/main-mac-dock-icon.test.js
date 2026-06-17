const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const zlib = require("node:zlib");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const MAIN = path.join(ROOT, "src", "main.js");
const APP_ICON = path.join(ROOT, "assets", "icon.png");
const DOCK_ICON = path.join(ROOT, "assets", "dock-icon.png");
const DOCK_ICON_SOURCE = path.join(ROOT, "assets", "source", "dock-icon-fullbleed.png");
const pkg = require("../package.json");

// Minimal non-interlaced 8-bit RGBA PNG reader (no deps) so the dock/app icon
// cannot silently regress to full-bleed square corners.
function readRgbaPng(file) {
  const buf = fs.readFileSync(file);
  assert.equal(buf.readUInt32BE(0), 0x89504e47, `${file} should be a PNG`);
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  assert.ok(bitDepth === 8 && colorType === 6, `${file} should be 8-bit RGBA`);
  const bpp = 4;
  const stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const recon = Buffer.alloc(height * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  let p = 0;
  for (let y = 0; y < height; y++) {
    const ft = raw[p++];
    for (let i = 0; i < stride; i++) {
      const x = raw[p++];
      const a = i >= bpp ? recon[y * stride + i - bpp] : 0;
      const b = y > 0 ? recon[(y - 1) * stride + i] : 0;
      const c = i >= bpp && y > 0 ? recon[(y - 1) * stride + i - bpp] : 0;
      let v;
      if (ft === 0) v = x;
      else if (ft === 1) v = x + a;
      else if (ft === 2) v = x + b;
      else if (ft === 3) v = x + ((a + b) >> 1);
      else if (ft === 4) v = x + paeth(a, b, c);
      else throw new Error(`unsupported PNG filter ${ft}`);
      recon[y * stride + i] = v & 0xff;
    }
  }
  return { width, height, data: recon, bpp, stride };
}

function alphaAt(file, x, y) {
  const png = readRgbaPng(file);
  return png.data[y * png.stride + x * png.bpp + 3];
}

function alphaContentBBox(file) {
  const { width, height, data, bpp, stride } = readRgbaPng(file);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[y * stride + x * bpp + 3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { canvas: width, width: maxX - minX + 1, height: maxY - minY + 1 };
}

test("macOS runtime dock icon asset is packaged", () => {
  assert.ok(fs.existsSync(DOCK_ICON), "assets/dock-icon.png should exist");
  assert.ok(
    pkg.build.files.includes("assets/dock-icon.png"),
    "build.files should include assets/dock-icon.png"
  );
});

test("macOS runtime dock icon override respects hidden Dock preference", () => {
  const source = fs.readFileSync(MAIN, "utf8");
  const setIcon = 'app.dock.setIcon(path.join(__dirname, "..", "assets", "dock-icon.png"))';
  const guard = 'if (isMac && app.dock && _settingsController.get("showDock") !== false)';
  const setIconIndex = source.indexOf(setIcon);
  const guardIndex = source.lastIndexOf(guard, setIconIndex);

  assert.ok(setIconIndex >= 0, "main.js should set the runtime macOS dock icon");
  assert.ok(guardIndex >= 0, "dock icon override should be guarded by showDock !== false");
  assert.ok(
    setIconIndex - guardIndex < 250,
    "showDock guard should wrap the dock icon override"
  );
});

test("dock icon is padded to the macOS grid, not full-bleed (issue #416 Part B)", () => {
  const { canvas, width, height } = alphaContentBBox(DOCK_ICON);
  assert.equal(canvas, 1024, "dock icon canvas should be 1024px");
  // Apple grid target is 824/1024 = 80.5%. Guard against a full-bleed regression
  // (content === canvas) while leaving room to retune the exact padding.
  assert.ok(
    width < 900 && height < 900,
    `dock icon content (${width}x${height}) must be padded, not full-bleed`
  );
  assert.ok(
    width >= 780 && height >= 780,
    `dock icon content (${width}x${height}) should not be shrunk too far`
  );
});

test("MiniCPM app icons keep transparent rounded macOS corners", () => {
  for (const file of [APP_ICON, DOCK_ICON]) {
    const { canvas } = alphaContentBBox(file);
    const last = canvas - 1;
    assert.equal(alphaAt(file, 0, 0), 0, `${file} top-left corner should be transparent`);
    assert.equal(alphaAt(file, last, 0), 0, `${file} top-right corner should be transparent`);
    assert.equal(alphaAt(file, 0, last), 0, `${file} bottom-left corner should be transparent`);
    assert.equal(alphaAt(file, last, last), 0, `${file} bottom-right corner should be transparent`);
  }
});

test("dock icon source follows the MiniCPM app icon artwork", () => {
  assert.deepStrictEqual(
    fs.readFileSync(DOCK_ICON_SOURCE),
    fs.readFileSync(APP_ICON),
    "dock icon source should match the MiniCPM app icon, not an upstream replacement"
  );
});

test("full-bleed dock icon source is preserved for regeneration", () => {
  assert.ok(
    fs.existsSync(DOCK_ICON_SOURCE),
    "assets/source/dock-icon-fullbleed.png should exist as the regeneration source"
  );
});
