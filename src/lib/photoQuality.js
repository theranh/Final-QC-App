// Local advisory photo-quality analysis — dark / blur detection.
//
// DESIGN GOALS:
//   • Pure pixel-scoring helpers are exported and testable without canvas.
//   • Conservative thresholds: warn only on obviously bad shots; avoid
//     false positives that interrupt the crew's flow.
//   • analyzeDataUrl() is async, downsamples heavily, and fails open:
//     any canvas / image-decode failure returns [] (no warning), so a
//     quality-check exception can never block saving.
//   • No server calls, no re-encoding, no mutation of the data URL.

// ─── tunables ────────────────────────────────────────────────────────────────
// Downsample preview to this max dimension before pixel inspection.
const SAMPLE_MAX = 120;

// Luma thresholds (0–255 scale).
// DARK  — average luma below this → advisory "too dark"
const DARK_LUMA_THRESHOLD = 45;
// Blur is inferred only when the scene has enough contrast to judge and its
// Laplacian (high-frequency edge energy) is extremely low. A plain paint panel,
// sky, or other genuinely uniform scene is intentionally left alone rather than
// being called blurry just because it has little overall variance.
const MIN_JUDGEABLE_CONTRAST = 14;
const BLUR_LAPLACIAN_THRESHOLD = 1.8;
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Score a flat Uint8ClampedArray (RGBA, 4 bytes per pixel) from a canvas
 * getImageData() call.  Returns an array of warning strings (may be empty).
 *
 * Pure function — no DOM/canvas dependencies — so it can be called directly
 * in unit tests with synthetic pixel data.
 *
 * @param {Uint8ClampedArray} data  Raw RGBA pixel data.
 * @param {number}            width Pixel width.
 * @param {number}            height Pixel height.
 * @returns {string[]}              Zero or more advisory warning strings.
 */
export function scorePixels(data, width, height) {
  const len = Number(width) * Number(height);
  if (!data || len < 1) return [];

  const luma = new Float32Array(len);
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < len; i++) {
    const off = i * 4;
    // BT.601 luma (integer-friendly approximation; good enough for advisory use).
    const y = (data[off] * 77 + data[off + 1] * 150 + data[off + 2] * 29) >> 8;
    luma[i] = y;
    sum += y;
    sumSq += y * y;
  }

  const mean = sum / len;
  const variance = sumSq / len - mean * mean;
  const contrast = Math.sqrt(Math.max(0, variance));

  const warnings = [];
  if (mean < DARK_LUMA_THRESHOLD) warnings.push('dark');

  if (width >= 8 && height >= 8 && contrast >= MIN_JUDGEABLE_CONTRAST) {
    let laplacianSum = 0;
    let samples = 0;
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = y * width + x;
        const laplacian = Math.abs(
          4 * luma[i] -
          luma[i - 1] -
          luma[i + 1] -
          luma[i - width] -
          luma[i + width],
        );
        laplacianSum += laplacian;
        samples++;
      }
    }
    if (samples && laplacianSum / samples < BLUR_LAPLACIAN_THRESHOLD) warnings.push('blur');
  }
  return warnings;
}

/**
 * Analyse a JPEG/PNG data URL for obvious quality issues.
 * Downsamples to at most SAMPLE_MAX px on the longest side before scoring,
 * so the analysis is fast even on large files.
 *
 * Fails open: returns [] on any error (canvas unavailable, image decode
 * failure, etc.) so a quality-check exception never blocks saving.
 *
 * @param {string} dataUrl
 * @returns {Promise<string[]>}  Zero or more advisory warning strings.
 */
export async function analyzeDataUrl(dataUrl) {
  try {
    if (typeof document === 'undefined') return [];
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('decode'));
      i.src = dataUrl;
    });

    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    if (!iw || !ih) return [];

    const scale = Math.min(1, SAMPLE_MAX / Math.max(iw, ih));
    const w = Math.max(1, Math.round(iw * scale));
    const h = Math.max(1, Math.round(ih * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return [];
    ctx.drawImage(img, 0, 0, w, h);

    const imageData = ctx.getImageData(0, 0, w, h);
    return scorePixels(imageData.data, w, h);
  } catch {
    // Fail open — never block saving.
    return [];
  }
}
