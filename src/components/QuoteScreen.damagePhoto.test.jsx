// Damage close-up durability: a close-up taken with weak/no signal must be
// persisted to the on-device queue BEFORE the upload attempt (same safety net
// as guided walk-around shots), survive the camera/app closing, and be sent
// by the launch-time flush on the next open. Pattern mirrors
// WalkAroundCamera.test.jsx.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';

vi.mock('../lib/api', () => ({
  api: { putQuotePhoto: vi.fn(), deleteQuotePhoto: vi.fn().mockResolvedValue({}), quotePhotos: vi.fn().mockResolvedValue({ photos: [] }) },
}));
import { api } from '../lib/api';
import { pendingJobs, removeJobsForPhoto, flushQueue, setCameraOpen } from '../lib/photoQueue';
import { uploadDamagePhotoDurably, purgeDeletedDamagePhoto } from './QuoteScreen';

const QUOTE = 'FQ123';
const DATA_URL = 'data:image/jpeg;base64,closeup';

async function clearQueue() {
  for (const j of await pendingJobs()) await removeJobsForPhoto(j.id, '__none__');
}

describe('damage close-up durability (uploadDamagePhotoDurably)', () => {
  let showToast;
  beforeEach(async () => {
    vi.clearAllMocks();
    showToast = vi.fn();
    setCameraOpen(false);
    await clearQueue();
  });

  it('uploads immediately when the signal is good and leaves nothing queued', async () => {
    api.putQuotePhoto.mockResolvedValue({});
    await uploadDamagePhotoDurably({ id: 'w1', quoteId: QUOTE, slot: 'dmg', dataUrl: DATA_URL }, showToast);
    expect(api.putQuotePhoto).toHaveBeenCalledWith({ id: 'w1', quoteId: QUOTE, slot: 'dmg', dataUrl: DATA_URL });
    await vi.waitFor(async () => expect(await pendingJobs()).toEqual([]));
    expect(showToast).not.toHaveBeenCalled();
  });

  it('a close-up taken with no signal survives closing the camera/app and reaches the server on next launch', async () => {
    // Upload fails as if the shop has no signal.
    api.putQuotePhoto.mockRejectedValue(new Error('offline'));
    await uploadDamagePhotoDurably({ id: 'w2', quoteId: QUOTE, slot: 'dmg', dataUrl: DATA_URL }, showToast);
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/saved.*background/i));

    // The shot is on disk — an app close at this point loses nothing.
    const left = await pendingJobs(QUOTE);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ id: 'w2', quoteId: QUOTE, slotKey: 'dmg', dataUrl: DATA_URL });

    // "Next launch": signal is back, the launch-time flush sends the close-up.
    api.putQuotePhoto.mockResolvedValue({});
    await flushQueue();
    expect(await pendingJobs()).toEqual([]);
    expect(api.putQuotePhoto).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'w2', quoteId: QUOTE, slot: 'dmg', dataUrl: DATA_URL }),
    );
  });

  it('several offline close-ups all survive and all send on the next launch', async () => {
    api.putQuotePhoto.mockRejectedValue(new Error('offline'));
    await uploadDamagePhotoDurably({ id: 'wA', quoteId: QUOTE, slot: 'dmg', dataUrl: DATA_URL }, showToast);
    await uploadDamagePhotoDurably({ id: 'wB', quoteId: QUOTE, slot: 'dmg', dataUrl: DATA_URL }, showToast);
    expect((await pendingJobs(QUOTE)).map((j) => j.id).sort()).toEqual(['wA', 'wB']);

    api.putQuotePhoto.mockResolvedValue({});
    await flushQueue();
    expect(await pendingJobs()).toEqual([]);
    const sentIds = api.putQuotePhoto.mock.calls.map(([a]) => a.id);
    expect(sentIds).toContain('wA');
    expect(sentIds).toContain('wB');
  });

  it('permanent rejections (409 committed) are surfaced and NOT left queued forever', async () => {
    api.putQuotePhoto.mockRejectedValue(Object.assign(new Error('committed'), { status: 409 }));
    await uploadDamagePhotoDurably({ id: 'w3', quoteId: QUOTE, slot: 'dmg', dataUrl: DATA_URL }, showToast);
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/committed/i));
    await vi.waitFor(async () => expect(await pendingJobs()).toEqual([]));
  });

  it('a deleted close-up is never uploaded later: capture offline → delete → flush after reconnect sends nothing', async () => {
    // Capture with no signal — the shot lands in the durable queue.
    api.putQuotePhoto.mockRejectedValue(new Error('offline'));
    await uploadDamagePhotoDurably({ id: 'wDel', quoteId: QUOTE, slot: 'dmg', dataUrl: DATA_URL }, showToast);
    expect(await pendingJobs(QUOTE)).toHaveLength(1);

    // Inspector deletes the photo (removePhoto path): queued copy is purged
    // and the server delete is issued (harmless offline — nothing landed).
    await purgeDeletedDamagePhoto('wDel');
    expect(api.deleteQuotePhoto).toHaveBeenCalledWith({ id: 'wDel' });
    expect(await pendingJobs()).toEqual([]);

    // "Next launch" with signal back: the flusher must NOT resurrect it.
    api.putQuotePhoto.mockClear();
    api.putQuotePhoto.mockResolvedValue({});
    await flushQueue();
    expect(api.putQuotePhoto).not.toHaveBeenCalled();
  });

  it('deleting while the upload is in flight cancels it: no retry, and the server copy is deleted if it landed', async () => {
    // Upload hangs mid-send.
    let resolveUpload;
    api.putQuotePhoto.mockImplementation(() => new Promise((r) => { resolveUpload = r; }));
    const deleted = new Set();
    const done = uploadDamagePhotoDurably({ id: 'wFlight', quoteId: QUOTE, slot: 'dmg', dataUrl: DATA_URL }, showToast, (id) => deleted.has(id));
    await vi.waitFor(() => expect(api.putQuotePhoto).toHaveBeenCalled());

    // Inspector deletes it while the send is still in the air.
    deleted.add('wFlight');
    await purgeDeletedDamagePhoto('wFlight');

    // The in-flight send lands anyway — the delete must win: server copy is
    // deleted again and nothing stays queued.
    api.deleteQuotePhoto.mockClear();
    resolveUpload({});
    await done;
    await vi.waitFor(() => expect(api.deleteQuotePhoto).toHaveBeenCalledWith({ id: 'wFlight' }));
    expect(await pendingJobs()).toEqual([]);
  });

  it('deleting while the upload is in flight and the send then FAILS leaves nothing queued and no toast', async () => {
    let rejectUpload;
    api.putQuotePhoto.mockImplementation(() => new Promise((_r, rej) => { rejectUpload = rej; }));
    const deleted = new Set();
    const done = uploadDamagePhotoDurably({ id: 'wGone', quoteId: QUOTE, slot: 'dmg', dataUrl: DATA_URL }, showToast, (id) => deleted.has(id));
    await vi.waitFor(() => expect(api.putQuotePhoto).toHaveBeenCalled());

    deleted.add('wGone');
    await purgeDeletedDamagePhoto('wGone');
    rejectUpload(new Error('offline'));
    await done;
    // No "saved, sending in background" toast for a photo the inspector removed.
    expect(showToast).not.toHaveBeenCalled();
    expect(await pendingJobs()).toEqual([]);
  });

  it('413 too-large is dropped from the queue with a size message', async () => {
    api.putQuotePhoto.mockRejectedValue(Object.assign(new Error('too big'), { status: 413 }));
    await uploadDamagePhotoDurably({ id: 'w4', quoteId: QUOTE, slot: 'dmg', dataUrl: DATA_URL }, showToast);
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/too large/i));
    await vi.waitFor(async () => expect(await pendingJobs()).toEqual([]));
  });
});
