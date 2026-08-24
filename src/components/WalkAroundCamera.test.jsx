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
const ctxStub = {
  drawImage: vi.fn(),
  save: vi.fn(),
  restore: vi.fn(),
  translate: vi.fn(),
  rotate: vi.fn(),
  scale: vi.fn(),
  transform: vi.fn(),
};

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
    for (const method of Object.values(ctxStub)) method.mockClear();
    api.quotePhotos.mockResolvedValue({ photos: [] });
    vi.stubGlobal('Image', FakeImage);
    HTMLCanvasElement.prototype.getContext = () => ctxStub;
    HTMLCanvasElement.prototype.toDataURL = () => 'data:image/jpeg;base64,normalized';
    showToast = vi.fn();
    setCameraOpen(false);
    localStorage.clear();
    await clearQueue();
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  const renderCamera = () =>
    render(<WalkAroundCamera quoteId={QUOTE} committed={false} onClose={() => {}} showToast={showToast} />);

  it('keeps the live viewfinder free of guided angle and damage-photo titles', () => {
    api.putQuotePhoto.mockResolvedValue({});
    renderCamera();

    expect(screen.queryByLabelText('Required angle: Front · driver corner')).not.toBeInTheDocument();
    expect(screen.queryByText(/NEXT REQUIRED PHOTO/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(screen.getByRole('button', { name: /add damage close-up/i }));
    expect(screen.queryByText('DAMAGE CLOSE-UP')).not.toBeInTheDocument();
    expect(screen.queryByText(/WIDE SHOT — STEP BACK/i)).not.toBeInTheDocument();
  });

  it('requests camera access and blocks the shutter until the opening permission gate completes', async () => {
    let resolveCamera;
    const track = {
      getCapabilities: () => ({}),
      applyConstraints: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
    };
    const stream = {
      getTracks: () => [track],
      getVideoTracks: () => [track],
    };
    const getUserMedia = vi.fn(() => new Promise((resolve) => { resolveCamera = resolve; }));
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia } });
    const { container } = renderCamera();

    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/requesting camera access/i)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Take photo'));
    expect(api.putQuotePhoto).not.toHaveBeenCalled();

    resolveCamera(stream);
    await waitFor(() => expect(screen.getByRole('button', { name: 'ENABLE CAMERA' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'ENABLE CAMERA' }));
    await waitFor(() => expect(screen.queryByText(/allow camera access before taking photos/i)).not.toBeInTheDocument());
    expect(container.querySelector('video').srcObject).toBe(stream);
    expect(api.putQuotePhoto).not.toHaveBeenCalled();
  });

  it('captures the browser-presented live frame without a hidden gravity rotation', async () => {
    const track = {
      getCapabilities: () => ({}),
      applyConstraints: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
    };
    const stream = {
      getTracks: () => [track],
      getVideoTracks: () => [track],
    };
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });
    api.putQuotePhoto.mockResolvedValue({});
    const { container } = renderCamera();

    await waitFor(() => expect(screen.getByRole('button', { name: 'ENABLE CAMERA' })).not.toBeDisabled());
    const video = container.querySelector('video');
    Object.defineProperties(video, {
      videoWidth: { configurable: true, value: 1920 },
      videoHeight: { configurable: true, value: 1080 },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ENABLE CAMERA' }));
    await waitFor(() => expect(screen.queryByText(/allow camera access before taking photos/i)).not.toBeInTheDocument());
    ctxStub.drawImage.mockClear();
    ctxStub.rotate.mockClear();

    fireEvent.click(screen.getByLabelText('Take photo'));

    await waitFor(() => expect(api.putQuotePhoto).toHaveBeenCalledTimes(1));
    expect(ctxStub.rotate).not.toHaveBeenCalled();
    expect(ctxStub.drawImage).toHaveBeenCalledWith(
      video,
      0,
      0,
      1920,
      1080,
      0,
      0,
      1600,
      900,
    );
  });

  it('calibrates an iPhone backing frame once, then corrects guided and damage shots before saving', async () => {
    const onDamageCapture = vi.fn();
    const track = {
      getCapabilities: () => ({}),
      getSettings: () => ({ facingMode: 'environment' }),
      applyConstraints: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
    };
    const stream = {
      getTracks: () => [track],
      getVideoTracks: () => [track],
    };
    vi.stubGlobal('navigator', {
      ...navigator,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 Version/18.2 Mobile/15E148 Safari/604.1',
      platform: 'iPhone',
      maxTouchPoints: 5,
      mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });
    api.putQuotePhoto.mockResolvedValue({});
    const { container } = render(
      <WalkAroundCamera
        quoteId={QUOTE}
        committed={false}
        onClose={() => {}}
        onDamageCapture={onDamageCapture}
        showToast={showToast}
      />,
    );

    await waitFor(() => expect(screen.getByRole('button', { name: 'ENABLE CAMERA' })).not.toBeDisabled());
    const video = container.querySelector('video');
    Object.defineProperties(video, {
      videoWidth: { configurable: true, value: 1920 },
      videoHeight: { configurable: true, value: 1080 },
      clientWidth: { configurable: true, value: 900 },
      clientHeight: { configurable: true, value: 1200 },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ENABLE CAMERA' }));
    await waitFor(() => expect(screen.queryByText(/allow camera access before taking photos/i)).not.toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('Take photo'));
    expect(await screen.findByRole('dialog', { name: 'Camera orientation check' })).toBeInTheDocument();
    expect(api.putQuotePhoto).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'ROTATE LEFT' }));
    await waitFor(() => expect(api.putQuotePhoto).toHaveBeenCalledTimes(1));

    ctxStub.rotate.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(screen.getByRole('button', { name: /add damage close-up/i }));
    const damageVideo = container.querySelector('video');
    Object.defineProperties(damageVideo, {
      videoWidth: { configurable: true, value: 1920 },
      videoHeight: { configurable: true, value: 1080 },
      clientWidth: { configurable: true, value: 900 },
      clientHeight: { configurable: true, value: 1200 },
    });
    expect(damageVideo.srcObject).toBe(stream);
    fireEvent.click(screen.getByLabelText('Take photo'));
    await waitFor(() => expect(ctxStub.rotate).toHaveBeenCalledWith(-Math.PI / 2));
    expect(screen.queryByRole('dialog', { name: 'Camera orientation check' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Take photo')).not.toBeDisabled());

    ctxStub.rotate.mockClear();
    fireEvent.click(screen.getByLabelText('Take photo'));
    await waitFor(() => expect(onDamageCapture).toHaveBeenCalledTimes(1));
    expect(ctxStub.rotate).toHaveBeenCalledWith(-Math.PI / 2);
    expect(onDamageCapture.mock.calls[0][0]).toMatch(/^data:image\/jpeg/);
    expect(onDamageCapture.mock.calls[0][1]).toMatch(/^data:image\/jpeg/);
  });

  it('binds rapid file selections to only one reserved slot at a time', async () => {
    api.putQuotePhoto.mockResolvedValue({});
    const { container } = renderCamera();
    const input = container.querySelector('input[type="file"]');

    fireEvent.change(input, { target: { files: [shotFile()] } });
    fireEvent.change(input, { target: { files: [shotFile()] } });

    await waitFor(() => expect(api.putQuotePhoto).toHaveBeenCalledTimes(1));
    expect(api.putQuotePhoto.mock.calls[0][0].id).toBe(`${QUOTE}_${WALK_SLOTS[0].key}`);

    fireEvent.change(input, { target: { files: [shotFile()] } });
    await waitFor(() => expect(api.putQuotePhoto).toHaveBeenCalledTimes(2));
    expect(api.putQuotePhoto.mock.calls[1][0].id).toBe(`${QUOTE}_${WALK_SLOTS[1].key}`);
  });

  it('serializes a same-slot retake and ignores the stale upload failure', async () => {
    let failFirstUpload;
    api.putQuotePhoto
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { failFirstUpload = reject; }))
      .mockResolvedValueOnce({});
    const { container } = renderCamera();

    const first = await snap(container);
    expect(api.putQuotePhoto).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(await screen.findByRole('button', { name: WALK_SLOTS[0].label }));
    const input = container.querySelector('input[type="file"]');
    fireEvent.change(input, { target: { files: [shotFile()] } });

    await waitFor(() => expect(screen.getByLabelText('Take photo')).not.toBeDisabled());
    expect(api.putQuotePhoto).toHaveBeenCalledTimes(1);

    failFirstUpload(Object.assign(new Error('too large'), { status: 413 }));
    await waitFor(() => expect(api.putQuotePhoto).toHaveBeenCalledTimes(2));
    const second = api.putQuotePhoto.mock.calls[1][0];
    expect(second.id).toBe(first.id);
    expect(second.captureTs).toBeGreaterThan(first.captureTs);
    expect(showToast).not.toHaveBeenCalledWith(expect.stringMatching(/too large/i));

    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(screen.getByRole('button', { name: WALK_SLOTS[0].label }).querySelector('img')).not.toBeNull();
  });

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
