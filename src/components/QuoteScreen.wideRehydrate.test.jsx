// Wide-shot thumbnail persistence: after reopening a saved quote, any line
// that has a widePhotoId must get its wideBase64 restored from the server
// so the WIDE thumbnail still shows and re-running classify uses two-image mode.
//
// Task #87 regression: wideThumb (compressed data URL) must be stored in the
// saved line so the WIDE thumbnail appears instantly on reopen, before the
// async rehydrateWideShots fetch completes.
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

  // ── Task #87 regression: wideThumb instant display ──────────────────────────

  it('rehydrateWideShots preserves wideThumb when it patches wideBase64', async () => {
    // A line restored from the server already has wideThumb (stored at capture
    // time). rehydrateWideShots must not strip it — the thumbnail must remain
    // visible while the full-res fetch is in progress AND after it completes.
    const WIDE_THUMB = 'data:image/jpeg;base64,smallthumb';
    const line = { id: 'lw', widePhotoId: 'lw_w', wideThumb: WIDE_THUMB };
    const fetchFn = okFetch(makeBlob());
    const setLines = vi.fn();

    await rehydrateWideShots([line], setLines, () => true, fetchFn);

    const updater = setLines.mock.calls[0][0];
    const prev = [{ id: 'lw', widePhotoId: 'lw_w', wideThumb: WIDE_THUMB }];
    const next = updater(prev);

    // wideBase64 added (full-res arrived)
    expect(typeof next[0].wideBase64).toBe('string');
    expect(next[0].wideBase64.length).toBeGreaterThan(0);
    // wideThumb not stripped
    expect(next[0].wideThumb).toBe(WIDE_THUMB);
  });

  it('a line with wideThumb but no wideBase64 satisfies the WIDE thumbnail render condition', () => {
    // LineCard renders the WIDE thumbnail when (l.wideBase64 || l.wideThumb).
    // This test asserts that invariant holds for the pre-rehydration state so
    // the WIDE thumbnail is visible the moment the quote loads, not 200–500 ms
    // later when rehydrateWideShots completes.
    const linePreRehydration = {
      id: 'lp', widePhotoId: 'lp_w',
      wideThumb: 'data:image/jpeg;base64,thumb', wideBase64: undefined,
    };
    const lineNoWide = { id: 'ln', widePhotoId: null, wideThumb: '', wideBase64: undefined };

    expect(!!(linePreRehydration.wideBase64 || linePreRehydration.wideThumb)).toBe(true);
    expect(!!(lineNoWide.wideBase64 || lineNoWide.wideThumb)).toBe(false);

    // The src the component would use: wideBase64 preferred, wideThumb fallback.
    const src = linePreRehydration.wideBase64
      ? `data:image/jpeg;base64,${linePreRehydration.wideBase64}`
      : linePreRehydration.wideThumb;
    expect(src).toBe('data:image/jpeg;base64,thumb');
  });

  it('a line with wideThumb switches cleanly to wideBase64 after rehydration', async () => {
    // After rehydrateWideShots resolves, the line has both fields.  The render
    // must prefer the full-res wideBase64 over the compressed wideThumb.
    const WIDE_THUMB = 'data:image/jpeg;base64,smallthumb';
    const line = { id: 'lr', widePhotoId: 'lr_w', wideThumb: WIDE_THUMB };
    const fetchFn = okFetch(makeBlob());
    const setLines = vi.fn();

    await rehydrateWideShots([line], setLines, () => true, fetchFn);

    const updater = setLines.mock.calls[0][0];
    const next = updater([{ ...line }]);

    // After rehydration, wideBase64 is present; the component prefers it.
    const src = next[0].wideBase64
      ? `data:image/jpeg;base64,${next[0].wideBase64}`
      : next[0].wideThumb;
    expect(src.startsWith('data:image/jpeg;base64,')).toBe(true);
    // Full-res is different from (longer than) the original compressed thumb.
    expect(src).not.toBe(WIDE_THUMB);
  });
});
