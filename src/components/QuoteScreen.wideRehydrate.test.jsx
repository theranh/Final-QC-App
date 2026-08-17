// Wide-shot thumbnail persistence: after reopening a saved quote, any line
// that has a widePhotoId must get its wideBase64 restored from the server
// so the WIDE thumbnail still shows and re-running classify uses two-image mode.
import { describe, it, expect, vi } from 'vitest';
import { rehydrateWideShots } from './QuoteScreen';

// Minimal JPEG bytes — enough for Blob + FileReader to produce a valid data URL.
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const makeBlob = () => new Blob([JPEG_BYTES], { type: 'image/jpeg' });

function okFetch(blob) {
  return vi.fn().mockResolvedValue({ ok: true, blob: async () => blob });
}

describe('rehydrateWideShots', () => {
  it('restores wideBase64 on a line with a widePhotoId after reload', async () => {
    const line = { id: 'l1', thumb: 'data:image/jpeg;base64,abc', widePhotoId: 'l1_w' };
    const fetchFn = okFetch(makeBlob());
    const setLines = vi.fn();

    await rehydrateWideShots([line], setLines, () => true, fetchFn);

    // Correct endpoint is called with encoded id.
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/quoter/photo?id=l1_w',
      { credentials: 'include' },
    );

    // setLines is called exactly once with an updater function.
    expect(setLines).toHaveBeenCalledTimes(1);

    // Apply the updater to confirm wideBase64 is set and is a non-empty string.
    const updater = setLines.mock.calls[0][0];
    const prev = [{ id: 'l1', thumb: 'data:image/jpeg;base64,abc', widePhotoId: 'l1_w' }];
    const next = updater(prev);
    expect(typeof next[0].wideBase64).toBe('string');
    expect(next[0].wideBase64.length).toBeGreaterThan(0);
    // Must not accidentally clear other fields.
    expect(next[0].thumb).toBe('data:image/jpeg;base64,abc');
    expect(next[0].widePhotoId).toBe('l1_w');
  });

  it('does not fetch or call setLines for lines without a widePhotoId', async () => {
    const lines = [
      { id: 'l2', thumb: 'data:...', widePhotoId: null },
      { id: 'l3', thumb: 'data:...' }, // widePhotoId absent entirely
    ];
    const fetchFn = vi.fn();
    const setLines = vi.fn();

    await rehydrateWideShots(lines, setLines, () => true, fetchFn);

    expect(fetchFn).not.toHaveBeenCalled();
    expect(setLines).not.toHaveBeenCalled();
  });

  it('skips a line when the server returns a non-ok status (e.g. 404)', async () => {
    const line = { id: 'l4', widePhotoId: 'l4_w' };
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const setLines = vi.fn();

    await rehydrateWideShots([line], setLines, () => true, fetchFn);

    expect(setLines).not.toHaveBeenCalled();
  });

  it('does not call setLines when the component unmounted (isLive returns false)', async () => {
    const line = { id: 'l5', widePhotoId: 'l5_w' };
    const fetchFn = okFetch(makeBlob());
    const setLines = vi.fn();

    await rehydrateWideShots([line], setLines, () => false, fetchFn);

    // Fetch ran but state update was correctly suppressed.
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(setLines).not.toHaveBeenCalled();
  });

  it('swallows a network error and resolves without throwing', async () => {
    const line = { id: 'l6', widePhotoId: 'l6_w' };
    const fetchFn = vi.fn().mockRejectedValue(new Error('network error'));
    const setLines = vi.fn();

    await expect(
      rehydrateWideShots([line], setLines, () => true, fetchFn),
    ).resolves.toBeUndefined();
    expect(setLines).not.toHaveBeenCalled();
  });

  it('handles a mix: fetches only the two lines that have widePhotoId', async () => {
    const lines = [
      { id: 'la', widePhotoId: 'la_w' },
      { id: 'lb', widePhotoId: null },  // no wide shot — skip
      { id: 'lc', widePhotoId: 'lc_w' },
    ];
    const fetchFn = okFetch(makeBlob());
    const setLines = vi.fn();

    await rehydrateWideShots(lines, setLines, () => true, fetchFn);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn).toHaveBeenCalledWith('/api/quoter/photo?id=la_w', expect.any(Object));
    expect(fetchFn).toHaveBeenCalledWith('/api/quoter/photo?id=lc_w', expect.any(Object));
    expect(setLines).toHaveBeenCalledTimes(2);
  });

  it('updater only patches the matching line and leaves others untouched', async () => {
    const line = { id: 'lx', widePhotoId: 'lx_w' };
    const fetchFn = okFetch(makeBlob());
    const setLines = vi.fn();

    await rehydrateWideShots([line], setLines, () => true, fetchFn);

    const updater = setLines.mock.calls[0][0];
    const prev = [
      { id: 'other', widePhotoId: null },
      { id: 'lx', widePhotoId: 'lx_w' },
    ];
    const next = updater(prev);
    expect(next[0].wideBase64).toBeUndefined(); // untouched
    expect(typeof next[1].wideBase64).toBe('string');
    expect(next[1].wideBase64.length).toBeGreaterThan(0);
  });
});
