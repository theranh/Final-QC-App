// Walk-around camera: continuous shooting + no-photo-left-behind coverage.
//
// Verifies (1) the 24th guided shot flips the camera into "extra" mode and
// keeps it open for unlimited photos, and (2) any shot taken with weak/no
// signal — including shots after the 24th — is persisted to IndexedDB, so it
// survives closing the camera (or force-closing the app) and is sent by the
// launch-time flush on the next open.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

vi.mock('../lib/api', () => ({
  api: { putQuotePhoto: vi.fn(), quotePhotos: vi.fn().mockResolvedValue({ photos: [] }) },
}));
import { api } from '../lib/api';
import { pendingJobs, removeJobsForPhoto, flushQueue, setCameraOpen } from '../lib/photoQueue';
import { WALK_SLOTS } from '../lib/walkSlots';
import WalkAroundCamera from './WalkAroundCamera';

// jsdom has no image decoding or 2D canvas: stub both so dataUrlImage()
// (thumbnail/normalize pipeline) resolves with a deterministic data URL.
class FakeImage {
  constructor() { this.width = 120; this.height = 90; }
  set src(v) { this._src = v; queueMicrotask(() => this.onload && this.onload()); }
  get src() { return this._src; }
}
const ctxStub = { drawImage() {}, save() {}, restore() {}, translate() {}, rotate() {} };

const QUOTE = 'FQ123';
const shotFile = () => new File(['jpegbytes'], 'shot.jpg', { type: 'image/jpeg' });

async function clearQueue() {
  for (const j of await pendingJobs()) await removeJobsForPhoto(j.id, '__none__');
}

/** Feed one "photo" through the hidden file input (the capture path that
 * works without a live camera) and wait until the queue/upload dance ran. */
async function snap(container) {
  const input = container.querySelector('input[type="file"]');
  const before = api.putQuotePhoto.mock.calls.length;
  fireEvent.change(input, { target: { files: [shotFile()] } });
  await waitFor(() => expect(api.putQuotePhoto.mock.calls.length).toBe(before + 1));
  return api.putQuotePhoto.mock.calls[before][0];
}

describe('WalkAroundCamera — continuous shooting & durability', () => {
  let showToast;
  beforeEach(async () => {
    vi.clearAllMocks();
    api.quotePhotos.mockResolvedValue({ photos: [] });
    vi.stubGlobal('Image', FakeImage);
    HTMLCanvasElement.prototype.getContext = () => ctxStub;
    HTMLCanvasElement.prototype.toDataURL = () => 'data:image/jpeg;base64,normalized';
    showToast = vi.fn();
    setCameraOpen(false);
    await clearQueue();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const renderCamera = () =>
    render(<WalkAroundCamera quoteId={QUOTE} committed={false} onClose={() => {}} showToast={showToast} />);

  it('24th guided shot switches to extra mode and keeps the camera open for unlimited photos', async () => {
    api.putQuotePhoto.mockResolvedValue({});
    const { container, unmount } = renderCamera();

    // Shoot all 24 guided angles.
    for (let i = 0; i < WALK_SLOTS.length; i += 1) {
      const call = await snap(container);
      expect(call.id).toBe(`${QUOTE}_${WALK_SLOTS[i].key}`);
    }

    // Camera did NOT close: extra mode, with the "keep shooting" message.
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringContaining('All 24 angles captured')));
    expect(screen.getByText(/24 photos/)).toBeInTheDocument(); // extra-mode header
    expect(screen.getByLabelText('Take photo')).toBeInTheDocument(); // shutter still there

    // Shots 25 and 26 land as additive extras with unique ids.
    const extra1 = await snap(container);
    const extra2 = await snap(container);
    expect(extra1.id).toMatch(new RegExp(`^${QUOTE}_x`));
    expect(extra2.id).toMatch(new RegExp(`^${QUOTE}_x`));
    expect(extra2.id).not.toBe(extra1.id);
    expect(screen.getByText(/26 photos/)).toBeInTheDocument();

    // Everything uploaded — nothing lingers on disk.
    expect(await pendingJobs()).toEqual([]);
    unmount();
  });

  it('weak-signal shots (guided AND after the 24th) survive closing the camera and send on next launch', async () => {
    // Every upload fails as if the shop has no signal.
    api.putQuotePhoto.mockRejectedValue(new Error('offline'));
    const { container, unmount } = renderCamera();

    // 24 guided shots offline…
    for (let i = 0; i < WALK_SLOTS.length; i += 1) await snap(container);
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringContaining('All 24 angles captured')));
    // …plus one MORE shot after the 24th, still offline.
    const extraCall = await snap(container);
    expect(extraCall.id).toMatch(new RegExp(`^${QUOTE}_x`));

    // Tech closes the camera with everything unsent (app-level flush kicks in
    // on close but the network is still down, so nothing is lost or dropped).
    unmount();
    await waitFor(async () => {
      const left = await pendingJobs(QUOTE);
      expect(left).toHaveLength(WALK_SLOTS.length + 1);
    });
    const queued = await pendingJobs(QUOTE);
    const ids = queued.map((j) => j.id).sort();
    for (const s of WALK_SLOTS) expect(ids).toContain(`${QUOTE}_${s.key}`);
    expect(ids.some((id) => id.startsWith(`${QUOTE}_x`))).toBe(true);

    // "Next launch": signal is back, the launch-time flush sends every shot.
    api.putQuotePhoto.mockResolvedValue({});
    await flushQueue();
    expect(await pendingJobs()).toEqual([]);
    const sentIds = api.putQuotePhoto.mock.calls.map(([a]) => a.id);
    for (const id of ids) expect(sentIds).toContain(id);
  });

  it('a shot whose upload is still in flight when the camera closes is persisted and sent on next launch', async () => {
    // Uploads hang — the classic "closed the app mid-send" case. Keep the
    // hung promises' rejecters so we can cut the connection after close.
    const hung = [];
    api.putQuotePhoto.mockImplementation(() => new Promise((_r, reject) => hung.push(reject)));
    const { container, unmount } = renderCamera();

    await snap(container); // first guided shot, upload never completes
    unmount(); // camera (or app) closed mid-upload

    // The shot is on disk, keyed to its slot.
    const left = await pendingJobs(QUOTE);
    expect(left).toHaveLength(1);
    expect(left[0].id).toBe(`${QUOTE}_${WALK_SLOTS[0].key}`);

    // The in-flight sends die with the app (connection cut on close).
    hung.forEach((reject) => reject(new Error('connection lost')));

    // Next launch: it goes through.
    api.putQuotePhoto.mockResolvedValue({});
    await vi.waitFor(async () => {
      await flushQueue(); // no-op while the aborted pass is still unwinding
      expect(await pendingJobs()).toEqual([]);
    });
    expect(api.putQuotePhoto).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: `${QUOTE}_${WALK_SLOTS[0].key}`, quoteId: QUOTE }),
    );
  });

  it('reopening the camera picks queued shots back into its own retry queue', async () => {
    // A previous force-closed session left one unsent shot on disk.
    api.putQuotePhoto.mockRejectedValue(new Error('offline'));
    const first = renderCamera();
    await snap(first.container);
    first.unmount();
    expect(await pendingJobs(QUOTE)).toHaveLength(1);

    // Reopen: the camera adopts the leftover job (header shows "sending 1…"),
    // and the global flusher stays paused while it is open.
    const second = renderCamera();
    await waitFor(() => expect(screen.getByText(/sending 1/)).toBeInTheDocument());
    second.unmount();
  });
});
