// Persistent upload queue for walk-around photos.
//
// The camera already retries failed uploads while it stays open, but if the
// PWA is force-closed (or the phone dies) the in-memory queue is gone. This
// module mirrors every pending shot into IndexedDB so it survives an app
// restart, and flushes leftovers on the next launch.
//
// Records are keyed by a per-CAPTURE unique `key`, not by the deterministic
// server photo id (`quoteId_slot`). This matters when a slot is retaken while
// an earlier upload for the same slot is still in flight: the old upload's
// cleanup deletes only ITS OWN record, never the retake's — so the newest
// shot always survives an app close. When several records exist for the same
// server id (crash mid-supersede), only the newest is sent; older ones are
// stale and are dropped.

import { api } from './api';

const DB_NAME = 'fqPhotoQueue';
const STORE = 'photos';

let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return; }
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      // v2 re-keys records per capture (`key`) instead of per slot (`id`).
      if (req.result.objectStoreNames.contains(STORE)) req.result.deleteObjectStore(STORE);
      req.result.createObjectStore(STORE, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  // A failed open (private mode, quota) must not poison future attempts.
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

function tx(mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    fn(t.objectStore(STORE));
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

function getAllRecords() {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const r = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    r.onsuccess = () => resolve(r.result || []); r.onerror = () => reject(r.error);
  }));
}

// ---------- pending-count subscription (drives the "sending…" indicator) ----------
const listeners = new Set();
let lastCount = 0;
function notify(count) {
  lastCount = count;
  listeners.forEach((fn) => { try { fn(count); } catch { /* listener error */ } });
}
export function subscribePending(fn) {
  listeners.add(fn);
  fn(lastCount);
  return () => listeners.delete(fn);
}
async function refreshCount() {
  try {
    const all = await getAllRecords();
    // One slot = one photo: count distinct server ids, not raw records.
    notify(new Set(all.map((j) => j.id)).size);
  } catch { /* no IDB — indicator stays quiet */ }
}

// ---------- queue operations ----------
// job: { key, id, quoteId, slotKey, dataUrl }  (key is unique per capture;
// id is the deterministic server photo id; prev is UI-only, not persisted)
export function newJobKey(id) {
  return `${id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}
export async function persistJob(job) {
  try {
    await tx('readwrite', (store) => store.put({ key: job.key, id: job.id, quoteId: job.quoteId, slotKey: job.slotKey, dataUrl: job.dataUrl, addedAt: Date.now() }));
    await refreshCount();
  } catch { /* private mode / quota — in-memory retry still covers the session */ }
}
export async function removeJob(key) {
  try {
    await tx('readwrite', (store) => store.delete(key));
    await refreshCount();
  } catch { /* ignore */ }
}
// Drop superseded records for a server photo id (a retake replaced the shot),
// keeping the capture identified by exceptKey. When maxAddedAt is given, only
// records at least that old are dropped — records persisted AFTER it (a newer
// retake) are never touched.
export async function removeJobsForPhoto(id, exceptKey, maxAddedAt) {
  try {
    const stale = (await getAllRecords()).filter((j) => j.id === id && j.key !== exceptKey && (maxAddedAt == null || (j.addedAt || 0) <= maxAddedAt));
    if (stale.length) await tx('readwrite', (store) => stale.forEach((j) => store.delete(j.key)));
    await refreshCount();
  } catch { /* ignore */ }
}
export async function pendingJobs(quoteId) {
  try {
    let all = await getAllRecords();
    if (quoteId) all = all.filter((j) => j.quoteId === quoteId);
    // Newest capture wins per server id — older records are superseded shots.
    const newest = new Map();
    for (const j of all) {
      const cur = newest.get(j.id);
      if (!cur || (j.addedAt || 0) > (cur.addedAt || 0)) newest.set(j.id, j);
    }
    return [...newest.values()];
  } catch { return []; }
}

// ---------- background flush ----------
// The camera pauses the global flusher while it's open (it runs its own retry
// loop against the same persisted jobs), so the two never race.
let cameraOpen = false;
export function setCameraOpen(open) { cameraOpen = open; if (!open) flushQueue(); }

let flushing = false;
export async function flushQueue() {
  if (flushing || cameraOpen) return;
  flushing = true;
  try {
    const jobs = await pendingJobs(); // newest per server id
    // Show the "Sending N photos…" pill for the whole flush, including the
    // launch-time pass where nothing has notified listeners yet.
    if (jobs.length) notify(jobs.length);
    for (const job of jobs) {
      if (cameraOpen) break;
      try {
         
        await api.putQuotePhoto({ id: job.id, quoteId: job.quoteId, slot: job.slotKey, dataUrl: job.dataUrl });
        // This capture reached the server: clear it AND any OLDER superseded
        // records for the same slot — but never a newer retake persisted
        // while this upload was in flight (that one must still be sent).
         
        await removeJob(job.key);
         
        await removeJobsForPhoto(job.id, job.key, job.addedAt);
      } catch (e) {
        // Permanent rejections can never succeed later — drop them so the
        // queue doesn't retry forever (401 is transient: same job works
        // after the tech signs back in, so keep it).
         
        if (e.status === 413 || e.status === 409 || e.status === 403) await removeJob(job.key);
        // Transient (offline / 5xx / 401): leave it for the next flush pass.
      }
    }
  } finally {
    flushing = false;
    refreshCount();
  }
}
