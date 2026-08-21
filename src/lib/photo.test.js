// Tests for src/lib/photo.js
//
// jsdom cannot exercise real EXIF decoding, so these tests cover:
//   • EXIF is stripped from a temporary decode copy before browser decoding
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
  const ctx = {
    drawImage: vi.fn(), fillRect: vi.fn(), save: vi.fn(), restore: vi.fn(),
    scale: vi.fn(), translate: vi.fn(), rotate: vi.fn(), transform: vi.fn(),
  };
  const canvas = {
    width: 0, height: 0,
    getContext: () => ctx,
    toDataURL: () => 'data:image/jpeg;base64,stubresult',
    toBlob: (cb) => cb(probeJpeg),
  };
  canvas.ctx = ctx;
  const orig = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tag) =>
    tag === 'canvas' ? canvas : orig(tag),
  );
  return canvas;
}

// Reset module registry so every test gets a clean module instance.
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
// Metadata-independent bitmap decoding
// ---------------------------------------------------------------------------

describe('metadata-independent bitmap decoding', () => {
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

  it('decodes the EXIF-free source without browser orientation options', async () => {
    const createBitmap = vi.fn().mockResolvedValue({ width: 240, height: 320, close: vi.fn() });
    vi.stubGlobal('createImageBitmap', createBitmap);
    const { loadOriented } = await import('./photo.js');
    const result = await loadOriented(RED_1x1);
    expect(result.width).toBe(240);
    expect(result.height).toBe(320);
    expect(createBitmap.mock.calls[0]).toHaveLength(1);
  });

  it('falls back to img when createImageBitmap throws', async () => {
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
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bmp));
    const { loadOriented } = await import('./photo.js');
    const { done } = await loadOriented(RED_1x1);
    done();
    expect(bmp.close).toHaveBeenCalledOnce();
  });

  it('falls through to img when main bmp call throws', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('corrupt jpeg')));
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

function exifJpegDataUrl(orientation) {
  const bytes = new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe1, 0x00, 0x22,
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08,
    0x00, 0x01,
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01,
    0x00, orientation, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0xff, 0xd9,
  ]);
  return `data:image/jpeg;base64,${btoa(String.fromCharCode(...bytes))}`;
}

describe('canonical EXIF transforms', () => {
  it('applies every EXIF orientation exactly once to raw bitmap pixels', async () => {
    const canvas = stubCanvas();
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 4, height: 3, close: vi.fn() }));
    const { orientedJpegDataUrl } = await import('./photo.js');
    const matrices = {
      2: [-1, 0, 0, 1, 4, 0],
      3: [-1, 0, 0, -1, 4, 3],
      4: [1, 0, 0, -1, 0, 3],
      5: [0, 1, 1, 0, 0, 0],
      6: [0, 1, -1, 0, 3, 0],
      7: [0, -1, -1, 0, 3, 4],
      8: [0, -1, 1, 0, 0, 4],
    };

    for (let orientation = 1; orientation <= 8; orientation += 1) {
      canvas.ctx.transform.mockClear();
      await orientedJpegDataUrl(exifJpegDataUrl(orientation), 100, 0.8);
      expect(canvas.width).toBe(orientation >= 5 ? 3 : 4);
      expect(canvas.height).toBe(orientation >= 5 ? 4 : 3);
      if (orientation === 1) expect(canvas.ctx.transform).not.toHaveBeenCalled();
      else expect(canvas.ctx.transform).toHaveBeenCalledWith(...matrices[orientation]);
    }
  });

  it('removes EXIF before decoding while retaining its explicit transform', async () => {
    let decodedBytes;
    vi.stubGlobal('createImageBitmap', vi.fn(async (blob) => {
      decodedBytes = new Uint8Array(await blob.arrayBuffer());
      return { width: 4, height: 3, close: vi.fn() };
    }));
    const { loadOriented } = await import('./photo.js');
    const decoded = await loadOriented(exifJpegDataUrl(6));
    expect(decoded.orientation).toBe(6);
    expect(decoded.width).toBe(3);
    expect(decoded.height).toBe(4);
    expect(String.fromCharCode(...decodedBytes)).not.toContain('Exif');
  });
});

describe('manual canonical rotation', () => {
  it('normalizes source EXIF before applying one deliberate clockwise turn', async () => {
    const canvas = stubCanvas();
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 4, height: 3, close: vi.fn() }));
    const { rotateJpegDataUrl } = await import('./photo.js');
    const result = await rotateJpegDataUrl(exifJpegDataUrl(6), 90, 100, 0.8);
    expect(result).toBe('data:image/jpeg;base64,stubresult');
    expect(canvas.ctx.rotate).toHaveBeenCalledWith(Math.PI / 2);
  });
});
