// Tests for src/lib/photo.js
//
// jsdom cannot exercise real EXIF decoding, so these tests cover:
//   • probeOrientationSupport: absent createImageBitmap → img fallback used
//   • probeOrientationSupport: probe returns 1×2 → option honored, bmp path used
//   • probeOrientationSupport: probe returns 2×1 → silent-ignore detected, img fallback
//   • probeOrientationSupport: probe throws → img fallback
//   • loadOriented img path: resolves with naturalWidth × naturalHeight
//   • loadOriented img path: rejects on bad image
//   • loadOriented bmp path: returns bitmap dims; done() closes bitmap
//   • loadOriented bmp path: falls to img when main bmp call throws
//   • orientedJpegDataUrl: error propagation and data-URL output
//
// Real EXIF orientation (portrait/landscape upright on iPhone) requires
// manual smoke-testing on physical iOS hardware — see task #61 notes.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Minimal 1×1 JPEG data URL (no EXIF orientation tag).
const RED_1x1 =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsL' +
  'DBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARCAABAAEDASIA' +
  'AhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAA' +
  'AAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ACUAAB//2Q==';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeImageClass({ fail = false, naturalWidth = 320, naturalHeight = 240 } = {}) {
  return class FakeImage {
    constructor() {
      this.naturalWidth = naturalWidth;
      this.naturalHeight = naturalHeight;
      this.onload = null;
      this.onerror = null;
    }
    set src(_) {
      Promise.resolve().then(() => { if (fail) this.onerror?.(); else this.onload?.(); });
    }
  };
}

// Canvas stub that provides toBlob (needed for the orientation probe).
function stubCanvas() {
  const probeJpeg = new Blob([new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9])], { type: 'image/jpeg' });
  const ctx = { drawImage: vi.fn(), fillRect: vi.fn() };
  const canvas = {
    width: 0, height: 0,
    getContext: () => ctx,
    toDataURL: () => 'data:image/jpeg;base64,stubresult',
    toBlob: (cb) => cb(probeJpeg),
  };
  const orig = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tag) =>
    tag === 'canvas' ? canvas : orig(tag),
  );
  return canvas;
}

// Reset module registry so each dynamic import gets a fresh module instance
// (clears _orientationProbeResult = null back to its initial value).
beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// ---------------------------------------------------------------------------
// img fallback path — createImageBitmap absent
// ---------------------------------------------------------------------------

describe('loadOriented — img fallback (no createImageBitmap)', () => {
  beforeEach(() => {
    vi.stubGlobal('createImageBitmap', undefined);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);
  });

  it('resolves with naturalWidth × naturalHeight', async () => {
    vi.stubGlobal('Image', makeImageClass({ naturalWidth: 800, naturalHeight: 600 }));
    const { loadOriented } = await import('./photo.js');
    const result = await loadOriented(RED_1x1);
    expect(result.width).toBe(800);
    expect(result.height).toBe(600);
    expect(typeof result.done).toBe('function');
  });

  it('accepts a Blob directly', async () => {
    vi.stubGlobal('Image', makeImageClass({ naturalWidth: 100, naturalHeight: 200 }));
    const { loadOriented } = await import('./photo.js');
    const result = await loadOriented(new Blob(['x'], { type: 'image/jpeg' }));
    expect(result.width).toBe(100);
    expect(result.height).toBe(200);
  });

  it('rejects when the image fails to decode', async () => {
    vi.stubGlobal('Image', makeImageClass({ fail: true }));
    const { loadOriented } = await import('./photo.js');
    await expect(loadOriented(RED_1x1)).rejects.toThrow('Could not read that image');
  });

  it('done() is a no-op', async () => {
    vi.stubGlobal('Image', makeImageClass());
    const { loadOriented } = await import('./photo.js');
    const { done } = await loadOriented(RED_1x1);
    expect(() => done()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Orientation probe detection
// ---------------------------------------------------------------------------

describe('probeOrientationSupport', () => {
  it('uses img fallback when createImageBitmap is absent', async () => {
    vi.stubGlobal('createImageBitmap', undefined);
    vi.stubGlobal('Image', makeImageClass({ naturalWidth: 50, naturalHeight: 100 }));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:absent');
    vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);
    const { loadOriented } = await import('./photo.js');
    const result = await loadOriented(RED_1x1);
    expect(result.width).toBe(50);
    expect(result.height).toBe(100);
  });

  it('uses createImageBitmap path when probe returns 1×2 (option honored)', async () => {
    stubCanvas();
    vi.stubGlobal('createImageBitmap', vi.fn()
      .mockResolvedValueOnce({ width: 1, height: 2, close: vi.fn() })  // probe
      .mockResolvedValueOnce({ width: 240, height: 320, close: vi.fn() }), // main
    );
    const { loadOriented } = await import('./photo.js');
    const result = await loadOriented(RED_1x1);
    expect(result.width).toBe(240);
    expect(result.height).toBe(320);
  });

  it('falls back to img when probe returns 2×1 (silent-ignore detected)', async () => {
    stubCanvas();
    vi.stubGlobal('createImageBitmap', vi.fn()
      .mockResolvedValueOnce({ width: 2, height: 1, close: vi.fn() }), // probe: ignored
    );
    vi.stubGlobal('Image', makeImageClass({ naturalWidth: 320, naturalHeight: 240 }));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:ignored');
    vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);
    const { loadOriented } = await import('./photo.js');
    const result = await loadOriented(RED_1x1);
    expect(result.width).toBe(320);
    expect(result.height).toBe(240);
  });

  it('falls back to img when probe createImageBitmap throws', async () => {
    stubCanvas();
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('no support')));
    vi.stubGlobal('Image', makeImageClass({ naturalWidth: 10, naturalHeight: 20 }));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:probe-throw');
    vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);
    const { loadOriented } = await import('./photo.js');
    const result = await loadOriented(RED_1x1);
    expect(result.width).toBe(10);
    expect(result.height).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// createImageBitmap path — details
// ---------------------------------------------------------------------------

describe('loadOriented — createImageBitmap path', () => {
  it('done() calls bmp.close()', async () => {
    stubCanvas();
    const bmp = { width: 240, height: 320, close: vi.fn() };
    vi.stubGlobal('createImageBitmap', vi.fn()
      .mockResolvedValueOnce({ width: 1, height: 2, close: vi.fn() })  // probe
      .mockResolvedValueOnce(bmp),                                       // main
    );
    const { loadOriented } = await import('./photo.js');
    const { done } = await loadOriented(RED_1x1);
    done();
    expect(bmp.close).toHaveBeenCalledOnce();
  });

  it('falls through to img when main bmp call throws', async () => {
    stubCanvas();
    vi.stubGlobal('createImageBitmap', vi.fn()
      .mockResolvedValueOnce({ width: 1, height: 2, close: vi.fn() }) // probe: honored
      .mockRejectedValueOnce(new Error('corrupt jpeg')),               // main: fails
    );
    vi.stubGlobal('Image', makeImageClass({ naturalWidth: 44, naturalHeight: 88 }));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:main-fail');
    vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);
    const { loadOriented } = await import('./photo.js');
    const result = await loadOriented(RED_1x1);
    expect(result.width).toBe(44);
    expect(result.height).toBe(88);
  });
});

// ---------------------------------------------------------------------------
// orientedJpegDataUrl
// ---------------------------------------------------------------------------

describe('orientedJpegDataUrl', () => {
  beforeEach(() => {
    vi.stubGlobal('createImageBitmap', undefined);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:oq');
    vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);
  });

  it('produces a data-URL string when decoding succeeds', async () => {
    vi.stubGlobal('Image', makeImageClass({ naturalWidth: 400, naturalHeight: 300 }));
    stubCanvas();
    const { orientedJpegDataUrl } = await import('./photo.js');
    const url = await orientedJpegDataUrl(RED_1x1, 1000, 0.8);
    expect(url).toMatch(/^data:/);
  });

  it('rejects when the image cannot be decoded', async () => {
    vi.stubGlobal('Image', makeImageClass({ fail: true }));
    const { orientedJpegDataUrl } = await import('./photo.js');
    await expect(orientedJpegDataUrl(RED_1x1, 1000, 0.8)).rejects.toThrow();
  });
});
