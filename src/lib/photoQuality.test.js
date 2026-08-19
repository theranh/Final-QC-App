// Tests for the photo-quality scoring helpers and WalkAroundCamera integration.
//
// scorePixels is a pure function — tested with synthetic pixel buffers.
// analyzeDataUrl is tested with a canvas stub for fail-open and warning paths.
// WalkAroundCamera integration tests verify the review overlay behaviour.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { scorePixels, analyzeDataUrl } from './photoQuality';

// ─── scorePixels — pure unit tests ────────────────────────────────────────────

const W = 20;
const H = 20;

/** Build a flat RGBA Uint8ClampedArray where every pixel has the same luma. */
function uniformPixels(luma, width = W, height = H) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = luma;     // R
    data[i * 4 + 1] = luma; // G
    data[i * 4 + 2] = luma; // B
    data[i * 4 + 3] = 255;  // A
  }
  return data;
}

/** Build a sharp checkerboard buffer. */
function checkerPixels(lo, hi, width = W, height = H) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const luma = i % 2 === 0 ? lo : hi;
    data[i * 4] = luma;
    data[i * 4 + 1] = luma;
    data[i * 4 + 2] = luma;
    data[i * 4 + 3] = 255;
  }
  return data;
}

/** Build a contrasty but edge-free gradient representative of obvious blur. */
function smoothGradientPixels(lo, hi, width = W, height = H) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const luma = Math.round(lo + (hi - lo) * (x / (width - 1)));
      data[i * 4] = luma;
      data[i * 4 + 1] = luma;
      data[i * 4 + 2] = luma;
      data[i * 4 + 3] = 255;
    }
  }
  return data;
}

describe('scorePixels — pure pixel scoring', () => {
  it('returns empty array for an empty buffer', () => {
    expect(scorePixels(new Uint8ClampedArray(0), 0, 0)).toEqual([]);
    expect(scorePixels(null, 0, 0)).toEqual([]);
  });

  it('warns "dark" for obviously dark pixels (mean < 45)', () => {
    // Uniform luma of 20 — definitely dark.
    const data = uniformPixels(20);
    const warnings = scorePixels(data, W, H);
    expect(warnings).toContain('dark');
  });

  it('does NOT warn dark for bright pixels (mean well above threshold)', () => {
    // Uniform luma of 150 — clearly bright.
    const data = uniformPixels(150);
    const warnings = scorePixels(data, W, H);
    expect(warnings).not.toContain('dark');
  });

  it('does NOT warn dark for a mid-grey value near but above the threshold', () => {
    // Luma 50 — above the 45 threshold.
    const data = uniformPixels(50);
    const warnings = scorePixels(data, W, H);
    expect(warnings).not.toContain('dark');
  });

  it('does not call a uniform scene blurry when there are no edges to judge', () => {
    const data = uniformPixels(100);
    const warnings = scorePixels(data, W, H);
    expect(warnings).not.toContain('blur');
  });

  it('does NOT warn blur for a sharp checkerboard image', () => {
    const data = checkerPixels(0, 255);
    const warnings = scorePixels(data, W, H);
    expect(warnings).not.toContain('blur');
  });

  it('warns blur for a contrasty but extremely smooth image', () => {
    const data = smoothGradientPixels(70, 190);
    const warnings = scorePixels(data, W, H);
    expect(warnings).toContain('blur');
  });

  it('returns combined dark+blur for a dark, smooth gradient', () => {
    const data = smoothGradientPixels(5, 65);
    const warnings = scorePixels(data, W, H);
    expect(warnings).toContain('dark');
    expect(warnings).toContain('blur');
  });

  it('does NOT double-warn blur on a dark but contrasty image', () => {
    const data = checkerPixels(0, 50);
    const warnings = scorePixels(data, W, H);
    expect(warnings).toContain('dark'); // average ≈ 25, dark threshold = 45
    expect(warnings).not.toContain('blur');
  });

  it('returns empty for a normal bright photo with reasonable contrast', () => {
    // Moderate variance (80 ↔ 180 alternating): neither dark nor blurry.
    const data = checkerPixels(80, 180);
    const warnings = scorePixels(data, W, H);
    expect(warnings).toEqual([]);
  });
});

// ─── analyzeDataUrl — async analyzer with canvas stubbing ─────────────────────

describe('analyzeDataUrl — async analyzer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fails open and returns [] when Image decode rejects', async () => {
    // Simulate broken image decode.
    class BrokenImage {
      set src(_v) { queueMicrotask(() => this.onerror && this.onerror()); }
    }
    vi.stubGlobal('Image', BrokenImage);
    const result = await analyzeDataUrl('data:image/jpeg;base64,broken');
    expect(result).toEqual([]);
    vi.unstubAllGlobals();
  });

  it('fails open and returns [] when canvas getContext returns null', async () => {
    class GoodImage {
      constructor() { this.naturalWidth = 100; this.naturalHeight = 80; }
      set src(_v) { queueMicrotask(() => this.onload && this.onload()); }
    }
    vi.stubGlobal('Image', GoodImage);
    // Simulate no canvas 2d support.
    const origGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = () => null;
    const result = await analyzeDataUrl('data:image/jpeg;base64,test');
    expect(result).toEqual([]);
    HTMLCanvasElement.prototype.getContext = origGetContext;
    vi.unstubAllGlobals();
  });

  it('fails open and returns [] when getImageData throws', async () => {
    class GoodImage {
      constructor() { this.naturalWidth = 100; this.naturalHeight = 80; }
      set src(_v) { queueMicrotask(() => this.onload && this.onload()); }
    }
    vi.stubGlobal('Image', GoodImage);
    const origGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = () => ({
      drawImage() {},
      getImageData() { throw new Error('security'); },
    });
    const result = await analyzeDataUrl('data:image/jpeg;base64,test');
    expect(result).toEqual([]);
    HTMLCanvasElement.prototype.getContext = origGetContext;
    vi.unstubAllGlobals();
  });

  it('returns warnings from scorePixels when canvas decode succeeds', async () => {
    // Stub Image to succeed with 4×4 dimensions.
    class GoodImage {
      constructor() { this.naturalWidth = 4; this.naturalHeight = 4; }
      set src(_v) { queueMicrotask(() => this.onload && this.onload()); }
    }
    vi.stubGlobal('Image', GoodImage);

    // A uniform dark scene can be judged for exposure, but it has no edges
    // from which to infer focus.
    const origGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = () => ({
      drawImage() {},
      getImageData(_x, _y, w, h) {
        // 16 dark pixels
        const data = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < w * h; i++) {
          data[i * 4] = 10; data[i * 4 + 1] = 10; data[i * 4 + 2] = 10; data[i * 4 + 3] = 255;
        }
        return { data };
      },
    });

    const result = await analyzeDataUrl('data:image/jpeg;base64,test');
    expect(result).toContain('dark');
    expect(result).not.toContain('blur');

    HTMLCanvasElement.prototype.getContext = origGetContext;
    vi.unstubAllGlobals();
  });

  it('returns [] for a normal bright image', async () => {
    class GoodImage {
      constructor() { this.naturalWidth = 10; this.naturalHeight = 10; }
      set src(_v) { queueMicrotask(() => this.onload && this.onload()); }
    }
    vi.stubGlobal('Image', GoodImage);
    const origGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = () => ({
      drawImage() {},
      getImageData(_x, _y, w, h) {
        // Alternating 80/180 — neither dark nor blurry.
        const data = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < w * h; i++) {
          const v = i % 2 === 0 ? 80 : 180;
          data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v; data[i * 4 + 3] = 255;
        }
        return { data };
      },
    });

    const result = await analyzeDataUrl('data:image/jpeg;base64,ok');
    expect(result).toEqual([]);

    HTMLCanvasElement.prototype.getContext = origGetContext;
    vi.unstubAllGlobals();
  });
});
