// Persistent photo queue: the safety net that keeps walk-around shots from
// being lost when the PWA is force-closed mid-upload.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';

vi.mock('./api', () => ({ api: { putQuotePhoto: vi.fn() } }));
import { api } from './api';
import { persistJob, removeJob, removeJobsForPhoto, pendingJobs, newJobKey, flushQueue, subscribePending, setCameraOpen } from './photoQueue';

let seq = 0;
const job = (id, quoteId = 'Q1', dataUrl = 'data:image/jpeg;base64,AAA') =>
  ({ key: `${id}:k${++seq}`, id, quoteId, slotKey: 'front', dataUrl });
const httpErr = (status) => Object.assign(new Error(`HTTP ${status}`), { status });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function clearAll() {
  for (const j of await pendingJobs()) await removeJobsForPhoto(j.id, '__none__');
}

describe('photoQueue', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    setCameraOpen(false);
    await clearAll();
  });

  it('round-trips persistJob / pendingJobs / removeJob', async () => {
    const a = job('a'); const b = job('b', 'Q2');
    await persistJob(a);
    await persistJob(b);
    expect((await pendingJobs()).map((j) => j.id).sort()).toEqual(['a', 'b']);
    expect((await pendingJobs('Q2')).map((j) => j.id)).toEqual(['b']);
    await removeJob(a.key);
    expect((await pendingJobs()).map((j) => j.id)).toEqual(['b']);
  });

  it('generates unique keys per capture of the same slot', () => {
    expect(newJobKey('Q1_front')).not.toBe(newJobKey('Q1_front'));
  });

  it('flushQueue uploads and clears jobs on success', async () => {
    api.putQuotePhoto.mockResolvedValue({});
    await persistJob(job('a'));
    await flushQueue();
    expect(api.putQuotePhoto).toHaveBeenCalledWith({ id: 'a', quoteId: 'Q1', slot: 'front', dataUrl: 'data:image/jpeg;base64,AAA' });
    expect(await pendingJobs()).toEqual([]);
  });

  it('keeps jobs on transient failures (network, 401) for a later retry', async () => {
    await persistJob(job('net'));
    api.putQuotePhoto.mockRejectedValueOnce(new Error('offline'));
    await flushQueue();
    expect((await pendingJobs()).map((j) => j.id)).toEqual(['net']);

    api.putQuotePhoto.mockRejectedValueOnce(httpErr(401));
    await flushQueue();
    expect((await pendingJobs()).map((j) => j.id)).toEqual(['net']); // survives sign-out
  });

  it('drops jobs on permanent rejections (413/409/403)', async () => {
    for (const [id, status] of [['big', 413], ['locked', 409], ['forbid', 403]]) {
      await clearAll();
      await persistJob(job(id));
      api.putQuotePhoto.mockRejectedValueOnce(httpErr(status));
      await flushQueue();
      expect(await pendingJobs()).toEqual([]);
    }
  });

  it('leaves camera slots alone while the camera is open, resumes on close', async () => {
    api.putQuotePhoto.mockResolvedValue({});
    setCameraOpen(true);
    const a = job('a');
    await persistJob(a);
    await flushQueue();
    expect(api.putQuotePhoto).not.toHaveBeenCalled();
    expect((await pendingJobs()).map((j) => j.id)).toEqual(['a']);
    setCameraOpen(false); // triggers a flush
    await vi.waitFor(async () => expect(await pendingJobs()).toEqual([]));
    expect(api.putQuotePhoto).toHaveBeenCalledTimes(1);
  });

  it('still sends damage close-ups (dmg… slots) while the camera is open', async () => {
    api.putQuotePhoto.mockResolvedValue({});
    setCameraOpen(true);
    const walk = job('walkshot');
    const dmg = { ...job('closeup'), slotKey: 'dmg1712' };
    await persistJob(walk);
    await persistJob(dmg);
    await flushQueue();
    // Only the damage close-up went out; the walk slot stays for the camera.
    expect(api.putQuotePhoto).toHaveBeenCalledTimes(1);
    expect(api.putQuotePhoto).toHaveBeenCalledWith({ id: 'closeup', quoteId: 'Q1', slot: 'dmg1712', dataUrl: 'data:image/jpeg;base64,AAA' });
    expect((await pendingJobs()).map((j) => j.id)).toEqual(['walkshot']);
    setCameraOpen(false);
    await vi.waitFor(async () => expect(await pendingJobs()).toEqual([]));
  });

  it('notifies subscribers with the pending count, including at flush start', async () => {
    const counts = [];
    const unsub = subscribePending((n) => counts.push(n));
    await persistJob(job('a'));
    await persistJob(job('b', 'Q2'));
    api.putQuotePhoto.mockResolvedValue({});
    await flushQueue();
    expect(counts).toContain(2); // pill shows while the launch flush runs
    expect(counts[counts.length - 1]).toBe(0); // and clears when done
    unsub();
  });

  it('a completed older upload cannot delete a same-slot retake (regression)', async () => {
    // Slot photo A is uploading slowly; the tech retakes the slot (B) while
    // A is still in flight; A then succeeds and cleans up after itself.
    // B's durable record must survive a simulated restart.
    const A = job('Q1_front', 'Q1', 'data:A');
    await persistJob(A);

    let resolveA;
    api.putQuotePhoto.mockImplementationOnce(() => new Promise((r) => { resolveA = r; }));
    const flushPromise = flushQueue(); // starts uploading A, then hangs
    await vi.waitFor(() => expect(api.putQuotePhoto).toHaveBeenCalledTimes(1));

    // Retake: persist B (unique key), purge records superseded by B.
    const B = { key: newJobKey('Q1_front'), id: 'Q1_front', quoteId: 'Q1', slotKey: 'front', dataUrl: 'data:B' };
    await sleep(2); // ensure B's addedAt is strictly newer than A's
    await persistJob(B);
    await removeJobsForPhoto('Q1_front', B.key);

    resolveA({}); // A finally reaches the server and removes its own record
    await flushPromise;

    // Simulated restart: B is still queued and is what gets sent next.
    const left = await pendingJobs();
    expect(left).toHaveLength(1);
    expect(left[0].key).toBe(B.key);
    expect(left[0].dataUrl).toBe('data:B');

    api.putQuotePhoto.mockResolvedValue({});
    await flushQueue();
    expect(api.putQuotePhoto).toHaveBeenLastCalledWith({ id: 'Q1_front', quoteId: 'Q1', slot: 'front', dataUrl: 'data:B' });
    expect(await pendingJobs()).toEqual([]);
  });
});
