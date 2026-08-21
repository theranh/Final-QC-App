// Persistent photo queue: the safety net that keeps walk-around shots from
// being lost when the PWA is force-closed mid-upload.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';

vi.mock('./api', () => ({ api: { putQuotePhoto: vi.fn(), deleteQuotePhoto: vi.fn() } }));
import { api } from './api';
import { clearQueueFailure, persistJob, removeJob, removeJobsForPhoto, pendingJobs, newJobKey, flushQueue, subscribePending, subscribeQueueFailure, setCameraOpen, markPhotoDeleted } from './photoQueue';

let seq = 0;
const job = (id, quoteId = 'Q1', dataUrl = 'data:image/jpeg;base64,AAA') =>
  ({ key: `${id}:k${++seq}`, id, quoteId, slotKey: 'ext_front', role: 'walk', dataUrl });
const httpErr = (status) => Object.assign(new Error(`HTTP ${status}`), { status });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function clearAll() {
  for (const j of await pendingJobs()) await removeJobsForPhoto(j.id, '__none__');
}

describe('photoQueue', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    setCameraOpen(false);
    clearQueueFailure();
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
    expect(api.putQuotePhoto).toHaveBeenCalledWith({ id: 'a', quoteId: 'Q1', slot: 'ext_front', role: 'walk', dataUrl: 'data:image/jpeg;base64,AAA' });
    expect(await pendingJobs()).toEqual([]);
  });

  it('forwards the original shutter timestamp when flushing a persisted capture', async () => {
    api.putQuotePhoto.mockResolvedValue({});
    const timed = { ...job('timed'), captureTs: 1_800_000_000_123 };
    await persistJob(timed);
    await flushQueue();

    expect(api.putQuotePhoto).toHaveBeenCalledWith(expect.objectContaining({
      id: 'timed',
      captureTs: timed.captureTs,
    }));
  });

  it('uses captureTs to keep the newest same-millisecond retake after restart', async () => {
    const addedAt = 1_800_000_000_000;
    const older = {
      ...job('same-slot', 'Q1', 'data:image/jpeg;base64,T0xE'),
      captureTs: addedAt + 1,
      addedAt,
    };
    const newer = {
      ...job('same-slot', 'Q1', 'data:image/jpeg;base64,TkVX'),
      captureTs: addedAt + 2,
      addedAt,
    };
    await persistJob(older);
    await persistJob(newer);

    expect((await pendingJobs())[0]).toMatchObject({
      key: newer.key,
      captureTs: newer.captureTs,
      dataUrl: newer.dataUrl,
    });

    api.putQuotePhoto.mockResolvedValue({});
    await flushQueue();
    expect(api.putQuotePhoto).toHaveBeenCalledTimes(1);
    expect(api.putQuotePhoto).toHaveBeenCalledWith(expect.objectContaining({
      id: newer.id,
      dataUrl: newer.dataUrl,
      captureTs: newer.captureTs,
    }));
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

  it('drops jobs on permanent rejections (400/413/409/403)', async () => {
    for (const [id, status] of [['invalid', 400], ['big', 413], ['locked', 409], ['forbid', 403]]) {
      await clearAll();
      await persistJob(job(id));
      api.putQuotePhoto.mockRejectedValueOnce(httpErr(status));
      await flushQueue();
      expect(await pendingJobs()).toEqual([]);
    }
  });

  it('uploads a genuinely old unknown slot as isolated unclassified metadata', async () => {
    api.putQuotePhoto.mockResolvedValue({});
    await persistJob({ ...job('old-front'), slotKey: 'front', role: undefined });
    await flushQueue();
    expect(api.putQuotePhoto).toHaveBeenCalledWith(expect.objectContaining({
      id: 'old-front',
      slot: 'front',
      role: 'unclassified',
    }));
    expect(await pendingJobs()).toEqual([]);
  });

  it('surfaces a retake warning when a queued photo is permanently rejected', async () => {
    const failures = [];
    const unsubscribe = subscribeQueueFailure((failure) => failures.push(failure));
    await persistJob(job('invalid'));
    api.putQuotePhoto.mockRejectedValueOnce(httpErr(400));
    await flushQueue();
    expect(failures.at(-1)).toEqual({ id: 'invalid', status: 400 });
    unsubscribe();
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
    expect(api.putQuotePhoto).toHaveBeenCalledWith({ id: 'closeup', quoteId: 'Q1', slot: 'dmg1712', role: 'damage', dataUrl: 'data:image/jpeg;base64,AAA' });
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

  it('issues a server delete when the photo is deleted while a flush PUT is in flight (delete-during-flush race)', async () => {
    api.deleteQuotePhoto.mockResolvedValue({});

    // Queue a damage close-up (slotKey starts with 'dmg').
    const dmgJob = { ...job('dmg_closeup_1'), slotKey: 'dmg_panel_a' };
    await persistJob(dmgJob);

    let resolvePut;
    api.putQuotePhoto.mockImplementationOnce(() => new Promise((r) => { resolvePut = r; }));

    const flushPromise = flushQueue(); // starts PUT, hangs in flight
    await vi.waitFor(() => expect(api.putQuotePhoto).toHaveBeenCalledTimes(1));

    // Inspector deletes the photo while the PUT is still in flight.
    // Simulate what purgeDeletedDamagePhoto does: mark then remove the record.
    markPhotoDeleted(dmgJob.id);
    await removeJobsForPhoto(dmgJob.id, '__none__');

    // Confirm the queue record is gone (delete arrived first).
    expect(await pendingJobs()).toEqual([]);

    resolvePut({}); // PUT response arrives — photo now on server
    await flushPromise;

    // flushQueue must consult deletedPhotoIds and issue a server delete so
    // the inspector's delete wins over the in-flight upload.
    expect(api.deleteQuotePhoto).toHaveBeenCalledWith({ id: dmgJob.id });
    // Queue remains empty.
    expect(await pendingJobs()).toEqual([]);
  });

  it('a completed older upload cannot delete a same-slot retake (regression)', async () => {
    // Slot photo A is uploading slowly; the tech retakes the slot (B) while
    // A is still in flight; A then succeeds and cleans up after itself.
    // B's durable record must survive a simulated restart, and the retake
    // supersession must NEVER trigger a server delete (only explicit inspector
    // deletions registered via markPhotoDeleted may do so).
    const A = job('Q1_front', 'Q1', 'data:A');
    await persistJob(A);

    let resolveA;
    api.putQuotePhoto.mockImplementationOnce(() => new Promise((r) => { resolveA = r; }));
    const flushPromise = flushQueue(); // starts uploading A, then hangs
    await vi.waitFor(() => expect(api.putQuotePhoto).toHaveBeenCalledTimes(1));

    // Retake: persist B (unique key), purge records superseded by B.
    // Note: markPhotoDeleted is NOT called — this is a retake, not a deletion.
    const B = { key: newJobKey('Q1_front'), id: 'Q1_front', quoteId: 'Q1', slotKey: 'ext_front', role: 'walk', dataUrl: 'data:B' };
    await sleep(2); // ensure B's addedAt is strictly newer than A's
    await persistJob(B);
    await removeJobsForPhoto('Q1_front', B.key);

    resolveA({}); // A finally reaches the server and removes its own record
    await flushPromise;

    // A retake must never issue a server delete — only explicit deletions do.
    expect(api.deleteQuotePhoto).not.toHaveBeenCalled();

    // Simulated restart: B is still queued and is what gets sent next.
    const left = await pendingJobs();
    expect(left).toHaveLength(1);
    expect(left[0].key).toBe(B.key);
    expect(left[0].dataUrl).toBe('data:B');

    api.putQuotePhoto.mockResolvedValue({});
    await flushQueue();
    expect(api.putQuotePhoto).toHaveBeenLastCalledWith({ id: 'Q1_front', quoteId: 'Q1', slot: 'ext_front', role: 'walk', dataUrl: 'data:B' });
    expect(await pendingJobs()).toEqual([]);
  });
});
