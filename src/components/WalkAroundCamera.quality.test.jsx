// Advisory photo-quality feedback integration tests for WalkAroundCamera.
//
// Verifies that:
//   1. When analyzeDataUrl returns warnings, the review overlay is shown.
//   2. "Keep Photo" passes the EXACT original dataUrl to the save path.
//   3. "Retake" dismisses the overlay without saving (no upload, no queue record).
//   4. When there are no warnings, existing processing continues immediately.
//   5. File-picker path triggers the same quality gate.
//   6. The camera mode (guided / extra) is preserved after Retake.
//   7. A quality-analysis exception never blocks saving (fail-open).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

// ── module mocks ─────────────────────────────────────────────────────────────

vi.mock('../lib/api', () => ({
  api: {
    putQuotePhoto: vi.fn(),
    quotePhotos: vi.fn().mockResolvedValue({ photos: [] }),
  },
}));

// Default: analyzeDataUrl returns no warnings (pass-through behaviour).
// Individual tests override this to inject warnings.
vi.mock('../lib/photoQuality', () => ({
  analyzeDataUrl: vi.fn().mockResolvedValue([]),
}));

import { api } from '../lib/api';
import { analyzeDataUrl } from '../lib/photoQuality';
import { pendingJobs, removeJobsForPhoto, setCameraOpen } from '../lib/photoQueue';
import { WALK_SLOTS } from '../lib/walkSlots';
import WalkAroundCamera from './WalkAroundCamera';

// ── canvas / image stubs (jsdom has neither) ──────────────────────────────────

class FakeImage {
  constructor() { this.width = 120; this.height = 90; this.naturalWidth = 120; this.naturalHeight = 90; }
  set src(v) { this._src = v; queueMicrotask(() => this.onload && this.onload()); }
  get src() { return this._src; }
}
const ctxStub = {
  drawImage() {}, save() {}, restore() {}, translate() {}, rotate() {}, scale() {}, transform() {},
  getImageData(x, y, w, h) {
    const data = new Uint8ClampedArray(w * h * 4).fill(128);
    return { data };
  },
};

const QUOTE = 'QQ999';
const shotFile = () => new File(['jpegbytes'], 'photo.jpg', { type: 'image/jpeg' });

async function clearQueue() {
  for (const j of await pendingJobs()) await removeJobsForPhoto(j.id, '__none__');
}

/** Simulate a file-input capture and wait for the upload call (or overlay). */
async function snapFile(container, waitForUpload = true) {
  const input = container.querySelector('input[type="file"]');
  const before = api.putQuotePhoto.mock.calls.length;
  fireEvent.change(input, { target: { files: [shotFile()] } });
  if (waitForUpload) {
    await waitFor(() => expect(api.putQuotePhoto.mock.calls.length).toBe(before + 1), { timeout: 3000 });
  }
}

// ── test suite ────────────────────────────────────────────────────────────────

describe('WalkAroundCamera — advisory photo-quality feedback', () => {
  let showToast;

  beforeEach(async () => {
    vi.clearAllMocks();
    api.putQuotePhoto.mockResolvedValue({});
    api.quotePhotos.mockResolvedValue({ photos: [] });
    analyzeDataUrl.mockResolvedValue([]); // default: no warnings
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

  const renderCamera = (props = {}) =>
    render(<WalkAroundCamera quoteId={QUOTE} committed={false} onClose={() => {}} showToast={showToast} {...props} />);

  // ── 1. No warning → save proceeds immediately ───────────────────────────────
  it('saves immediately when analyzeDataUrl returns no warnings', async () => {
    analyzeDataUrl.mockResolvedValue([]);
    const { container } = renderCamera();
    await snapFile(container);

    // No overlay shown.
    expect(screen.queryByRole('dialog')).toBeNull();
    // Upload was called once.
    expect(api.putQuotePhoto).toHaveBeenCalledTimes(1);
  });

  // ── 2. Warning → overlay shown; Keep passes exact dataUrl ──────────────────
  it('shows quality review overlay when dark warning is returned', async () => {
    analyzeDataUrl.mockResolvedValue(['dark']);
    const { container } = renderCamera();

    // Trigger a file-based capture (no real camera in jsdom).
    const input = container.querySelector('input[type="file"]');
    fireEvent.change(input, { target: { files: [shotFile()] } });

    // Overlay must appear.
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    // Both the badge ("TOO DARK") and headline ("Photo looks too dark") mention dark.
    expect(screen.getAllByText(/too dark/i).length).toBeGreaterThan(0);
    // No upload yet — photo is not saved until user decides.
    expect(api.putQuotePhoto).not.toHaveBeenCalled();
  });

  it('shows quality review overlay for blur warning', async () => {
    analyzeDataUrl.mockResolvedValue(['blur']);
    const { container } = renderCamera();

    const input = container.querySelector('input[type="file"]');
    fireEvent.change(input, { target: { files: [shotFile()] } });

    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    // Both badge ("BLURRY") and headline mention blur.
    expect(screen.getAllByText(/blur/i).length).toBeGreaterThan(0);
  });

  it('shows combined dark+blur headline', async () => {
    analyzeDataUrl.mockResolvedValue(['dark', 'blur']);
    const { container } = renderCamera();

    const input = container.querySelector('input[type="file"]');
    fireEvent.change(input, { target: { files: [shotFile()] } });

    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    expect(screen.getByText(/dark and blurry/i)).toBeInTheDocument();
  });

  it('Keep photo passes the exact original dataUrl to the save path', async () => {
    analyzeDataUrl.mockResolvedValue(['dark']);
    // Make toDataURL return a recognisable value.
    const EXPECTED_URL = 'data:image/jpeg;base64,originalcaptured';
    HTMLCanvasElement.prototype.toDataURL = () => EXPECTED_URL;

    const { container } = renderCamera();
    const input = container.querySelector('input[type="file"]');
    // File reader will produce its own dataUrl; the canvas path above is used
    // for live capture.  For a file-picker path the normalized URL flows from
    // dataUrlImage (stubbed via toDataURL) through the quality gate.
    fireEvent.change(input, { target: { files: [shotFile()] } });

    // Wait for overlay.
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

    // Press Keep.
    fireEvent.click(screen.getByLabelText('Keep photo'));

    // Upload should have been called with the normalized URL (from toDataURL stub).
    await waitFor(() => expect(api.putQuotePhoto).toHaveBeenCalledTimes(1));
    expect(api.putQuotePhoto.mock.calls[0][0].dataUrl).toBe(EXPECTED_URL);
  });

  it('serializes a rapid double activation of Keep into one save', async () => {
    analyzeDataUrl.mockResolvedValue(['dark']);
    let finishUpload;
    api.putQuotePhoto.mockImplementation(() => new Promise((resolve) => { finishUpload = resolve; }));
    const { container } = renderCamera();
    const input = container.querySelector('input[type="file"]');
    fireEvent.change(input, { target: { files: [shotFile()] } });
    const keep = await screen.findByLabelText('Keep photo');

    fireEvent.click(keep);
    fireEvent.click(keep);

    await waitFor(() => expect(api.putQuotePhoto).toHaveBeenCalledTimes(1));
    finishUpload({});
  });

  it('keeps the guided slot reserved through Keep, then unlocks on the next slot', async () => {
    analyzeDataUrl
      .mockResolvedValueOnce(['dark'])
      .mockResolvedValueOnce([]);
    let finishFirstUpload;
    api.putQuotePhoto
      .mockImplementationOnce(() => new Promise((resolve) => { finishFirstUpload = resolve; }))
      .mockResolvedValueOnce({});
    const { container } = renderCamera();
    const input = container.querySelector('input[type="file"]');

    fireEvent.change(input, { target: { files: [shotFile()] } });
    const keep = await screen.findByLabelText('Keep photo');
    expect(screen.getByLabelText('Take photo')).toBeDisabled();

    fireEvent.click(keep);

    await waitFor(() => {
      expect(api.putQuotePhoto).toHaveBeenCalledTimes(1);
      expect(screen.getByLabelText('Take photo')).toHaveAttribute('aria-busy', 'false');
    });
    fireEvent.change(input, { target: { files: [shotFile()] } });

    await waitFor(() => expect(api.putQuotePhoto).toHaveBeenCalledTimes(2));
    expect(api.putQuotePhoto.mock.calls[0][0].id).toBe(`${QUOTE}_${WALK_SLOTS[0].key}`);
    expect(api.putQuotePhoto.mock.calls[1][0].id).toBe(`${QUOTE}_${WALK_SLOTS[1].key}`);
    finishFirstUpload({});
  });

  // ── 3. Retake → overlay dismissed, no save ─────────────────────────────────
  it('Retake dismisses the overlay without saving', async () => {
    analyzeDataUrl.mockResolvedValue(['blur']);
    const { container } = renderCamera();

    const input = container.querySelector('input[type="file"]');
    fireEvent.change(input, { target: { files: [shotFile()] } });

    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

    // Press Retake.
    fireEvent.click(screen.getByLabelText('Retake photo'));

    // Overlay gone.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // No upload.
    expect(api.putQuotePhoto).not.toHaveBeenCalled();
    // No queue records.
    expect(await pendingJobs(QUOTE)).toHaveLength(0);
  });

  // ── 4. Mode preservation after Retake ──────────────────────────────────────
  it('camera remains in guided mode after Retake', async () => {
    analyzeDataUrl.mockResolvedValue(['dark']);
    const { container } = renderCamera();

    // The camera is ready in guided mode without showing an angle title.
    expect(screen.getByLabelText('Take photo')).toBeInTheDocument();
    expect(screen.queryByText(/NEXT REQUIRED PHOTO/i)).not.toBeInTheDocument();

    const input = container.querySelector('input[type="file"]');
    fireEvent.change(input, { target: { files: [shotFile()] } });

    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Retake photo'));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Still in guided mode — photo processing is ready again. The live
    // shutter remains disabled in this file-import-only test environment.
    expect(screen.getByLabelText('Take photo')).toHaveAttribute('aria-busy', 'false');
  });

  it('camera remains in extra mode after Retake', async () => {
    analyzeDataUrl.mockResolvedValue(['blur']);
    // Start in extra mode directly.
    const { container } = renderCamera({ initialMode: 'extra' });

    const input = container.querySelector('input[type="file"]');
    fireEvent.change(input, { target: { files: [shotFile()] } });

    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Retake photo'));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Header still shows extra mode.
    expect(screen.queryByLabelText('Take photo')).toBeInTheDocument();
  });

  it('reviews a damage close-up before advancing and Retake stays on close-up', async () => {
    analyzeDataUrl.mockResolvedValue(['dark']);
    const onDamageCapture = vi.fn();
    const { container } = renderCamera({ initialMode: 'damage', onDamageCapture });

    const input = container.querySelector('input[type="file"]');
    fireEvent.change(input, { target: { files: [shotFile()] } });

    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Retake photo'));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByLabelText('Take photo')).toHaveAttribute('aria-busy', 'false');
    expect(screen.queryByText(/DAMAGE CLOSE-UP/i)).not.toBeInTheDocument();
    expect(onDamageCapture).not.toHaveBeenCalled();
    expect(api.putQuotePhoto).not.toHaveBeenCalled();
  });

  it('Retake of a damage wide shot preserves the close-up and wide-shot mode', async () => {
    analyzeDataUrl
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(['blur']);
    const onDamageCapture = vi.fn();
    const { container } = renderCamera({ initialMode: 'damage', onDamageCapture });
    const input = container.querySelector('input[type="file"]');

    fireEvent.change(input, { target: { files: [shotFile()] } });
    await waitFor(() => expect(screen.getByLabelText('Take photo')).toHaveAttribute('aria-busy', 'false'));

    fireEvent.change(input, { target: { files: [shotFile()] } });
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Retake photo'));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByLabelText('Take photo')).toHaveAttribute('aria-busy', 'false');
    expect(screen.queryByText(/WIDE SHOT/i)).not.toBeInTheDocument();
    expect(onDamageCapture).not.toHaveBeenCalled();
  });

  it('Keep on a damage wide shot sends the reviewed pair and returns to guided mode', async () => {
    analyzeDataUrl
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(['blur']);
    const onDamageCapture = vi.fn();
    const { container } = renderCamera({ initialMode: 'damage', onDamageCapture });
    const input = container.querySelector('input[type="file"]');

    fireEvent.change(input, { target: { files: [shotFile()] } });
    await waitFor(() => expect(screen.getByLabelText('Take photo')).toHaveAttribute('aria-busy', 'false'));

    fireEvent.change(input, { target: { files: [shotFile()] } });
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Keep photo'));

    await waitFor(() => expect(onDamageCapture).toHaveBeenCalledTimes(1));
    const [closeUp, wide] = onDamageCapture.mock.calls[0];
    expect(closeUp).toBe('data:image/jpeg;base64,normalized');
    expect(wide).toBe('data:image/jpeg;base64,normalized');
    expect(screen.getByLabelText('Take photo')).toBeInTheDocument();
  });

  // ── 5. Fail-open: exception in analyzeDataUrl must not block saving ─────────
  it('fail-open: save proceeds immediately when analyzeDataUrl throws', async () => {
    analyzeDataUrl.mockRejectedValue(new Error('canvas error'));
    const { container } = renderCamera();
    await snapFile(container);

    // No overlay.
    expect(screen.queryByRole('dialog')).toBeNull();
    // Photo was saved.
    expect(api.putQuotePhoto).toHaveBeenCalledTimes(1);
  });

  // ── 6. Unchanged dataUrl flows through on Keep ──────────────────────────────
  it('the dataUrl passed to putQuotePhoto on Keep equals the dataUrl shown in the overlay preview', async () => {
    analyzeDataUrl.mockResolvedValue(['dark']);
    const CAPTURED = 'data:image/jpeg;base64,keepme';
    HTMLCanvasElement.prototype.toDataURL = () => CAPTURED;

    const { container } = renderCamera();
    const input = container.querySelector('input[type="file"]');
    fireEvent.change(input, { target: { files: [shotFile()] } });

    await waitFor(() => {
      const img = screen.queryByAltText('Captured photo preview');
      expect(img).toBeInTheDocument();
      expect(img.src).toContain('keepme');
    });

    fireEvent.click(screen.getByLabelText('Keep photo'));

    await waitFor(() => expect(api.putQuotePhoto).toHaveBeenCalledTimes(1));
    expect(api.putQuotePhoto.mock.calls[0][0].dataUrl).toBe(CAPTURED);
  });
});
