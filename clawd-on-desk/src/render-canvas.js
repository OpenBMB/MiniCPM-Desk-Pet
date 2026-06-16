"use strict";

const DEFAULT_RENDER_CANVAS = Object.freeze({
  widthRatio: 1,
  anchorX: 0.5,
});

function basenameOnly(value) {
  return typeof value === "string" ? value.replace(/^.*[\/\\]/, "") : value;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeCanvasEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const widthRatio = finiteNumber(value.widthRatio)
    ? clamp(value.widthRatio, 1, 3)
    : DEFAULT_RENDER_CANVAS.widthRatio;
  const anchorX = finiteNumber(value.anchorX)
    ? clamp(value.anchorX, 0, 1)
    : DEFAULT_RENDER_CANVAS.anchorX;
  if (widthRatio <= 1) return null;
  return { widthRatio, anchorX };
}

function normalizeRenderCanvas(raw) {
  const out = { fileRatios: {} };
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const fileRatios = source.fileRatios && typeof source.fileRatios === "object" && !Array.isArray(source.fileRatios)
    ? source.fileRatios
    : {};
  for (const [rawName, rawEntry] of Object.entries(fileRatios)) {
    const name = basenameOnly(rawName);
    const entry = normalizeCanvasEntry(rawEntry);
    if (name && entry) out.fileRatios[name] = entry;
  }
  return out;
}

function getRenderCanvasForFile(theme, file) {
  const name = basenameOnly(file);
  const configured = name
    && theme
    && theme.renderCanvas
    && theme.renderCanvas.fileRatios
    && theme.renderCanvas.fileRatios[name];
  return configured || DEFAULT_RENDER_CANVAS;
}

function renderCanvasEquals(a, b) {
  return !!a && !!b
    && a.widthRatio === b.widthRatio
    && a.anchorX === b.anchorX;
}

function getActualBoundsForLogical(bounds, canvas = DEFAULT_RENDER_CANVAS) {
  if (!bounds) return null;
  const widthRatio = finiteNumber(canvas.widthRatio) ? Math.max(1, canvas.widthRatio) : 1;
  const anchorX = finiteNumber(canvas.anchorX) ? clamp(canvas.anchorX, 0, 1) : 0.5;
  const width = Math.round(bounds.width * widthRatio);
  const extraWidth = width - bounds.width;
  return {
    x: Math.round(bounds.x - extraWidth * anchorX),
    y: Math.round(bounds.y),
    width,
    height: Math.round(bounds.height),
  };
}

function getLogicalBoundsForActual(bounds, canvas = DEFAULT_RENDER_CANVAS) {
  if (!bounds) return null;
  const widthRatio = finiteNumber(canvas.widthRatio) ? Math.max(1, canvas.widthRatio) : 1;
  const anchorX = finiteNumber(canvas.anchorX) ? clamp(canvas.anchorX, 0, 1) : 0.5;
  const width = Math.round(bounds.width / widthRatio);
  const extraWidth = bounds.width - width;
  return {
    x: Math.round(bounds.x + extraWidth * anchorX),
    y: Math.round(bounds.y),
    width,
    height: Math.round(bounds.height),
  };
}

function renderCanvasCacheSignature(theme, file) {
  const canvas = getRenderCanvasForFile(theme, file);
  if (!canvas || canvas.widthRatio <= 1) return "canvas:1";
  return `canvas:${canvas.widthRatio.toFixed(3)}:${canvas.anchorX.toFixed(3)}`;
}

module.exports = {
  DEFAULT_RENDER_CANVAS,
  normalizeRenderCanvas,
  getRenderCanvasForFile,
  renderCanvasEquals,
  getActualBoundsForLogical,
  getLogicalBoundsForActual,
  renderCanvasCacheSignature,
};
