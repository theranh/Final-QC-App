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
// Deletion tombstones: lines the inspector deleted locally that may not have
// reached the server yet (offline autosave). Stored durably so hydration on
// the next session can filter them out before they re-attach a wide shot.
const TOMBSTONE_STORE = 'deletedLines';

let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return; }
    const req = indexedDB.open(DB_NAME, 3);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      // v2 re-keys records per capture (`key`) instead of per slot (`id`).
      if (ev.oldVersion < 2) {
        if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
        db.createObjectStore(STORE, { keyPath: 'key' });
      }
      // v3 adds the deletion-tombstone store.
      if (ev.oldVersion < 3) {
        db.createObjectStore(TOMBSTONE_STORE, { keyPath: 'lineId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  // A failed open (private mode, quota) must not poison future attempts.
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

function tx(mode, fn, store = STORE) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    fn(t.objectStore(store));
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

// Session-scoped registry of photo IDs that were explicitly deleted by the
// inspector. Populated ONLY by markPhotoDeleted (called from
// purgeDeletedDamagePhoto). flushQueue checks this after a PUT lands to
// detect the delete-during-upload race and issue a corrective server delete.
//
// In-memory is sufficient: the race can only occur within the same session.
// On a restart, purgeDeletedDamagePhoto will have already removed the queue
// record, so flushQueue never picks the photo up again.
const deletedPhotoIds = new Set();
export function markPhotoDeleted(id) { deletedPhotoIds.add(id); }

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
// ---------- deletion tombstones ----------
// A tombstone is written when a damage line is deleted locally. It survives
// PWA restarts so hydration on the next session can filter the line out of
// q.lines before it re-attaches its wide-shot photo. Tombstones are cleaned
// up once the server no longer returns that line (autosave went through).
export async function addDeletionTombstone(lineId, widePhotoId) {
  try {
    await tx('readwrite', (store) => store.put({ lineId, widePhotoId: widePhotoId || null, deletedAt: Date.now() }), TOMBSTONE_STORE);
  } catch { /* private mode / quota — in-memory refs still guard the current session */ }
}
export async function getDeletionTombstones() {
  try {
    return await new Promise((resolve, reject) => {
      openDb().then((db) => {
        const r = db.transaction(TOMBSTONE_STORE, 'readonly').objectStore(TOMBSTONE_STORE).getAll();
        r.onsuccess = () => resolve(r.result || []);
        r.onerror = () => reject(r.error);
      }).catch(reject);
    });
  } catch { return []; }
}
export async function removeDeletionTombstone(lineId) {
  try {
    await tx('readwrite', (store) => store.delete(lineId), TOMBSTONE_STORE);
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
// While the camera is open it runs its own retry loop for walk-around and
// extra shots (the persisted jobs it also holds in memory), so the global
// flusher must not touch THOSE — the two would race. Damage close-ups are
// different: they are queued by the quote screen, the camera never retries
// them, so the global flusher keeps sending them even while the camera stays
// open (its interval + the window 'online' listener pick them up as soon as
// the signal returns).
let cameraOpen = false;
export function setCameraOpen(open) { cameraOpen = open; if (!open) flushQueue(); }

// Damage close-ups get 'dmg…' slot keys; everything else is a camera slot.
const isDamageJob = (job) => String(job.slotKey || '').startsWith('dmg');

let flushing = false;
export async function flushQueue() {
  if (flushing) return;
  flushing = true;
  try {
    let jobs = await pendingJobs(); // newest per server id
    // Camera open: only damage close-ups are ours to send — camera slots
    // belong to the camera's own retry loop.
    if (cameraOpen) jobs = jobs.filter(isDamageJob);
    if (!jobs.length) return;
    // Show the "Sending N photos…" pill for the whole flush, including the
    // launch-time pass where nothing has notified listeners yet.
    notify(jobs.length);
    for (const job of jobs) {
      // The camera may have opened mid-flush — stop touching its slots, but
      // damage close-ups are still safe to send.
      if (cameraOpen && !isDamageJob(job)) continue;
      try {
         
        await api.putQuotePhoto({ id: job.id, quoteId: job.quoteId, slot: job.slotKey, dataUrl: job.dataUrl });
        // Check whether the inspector deleted this photo while the PUT was
        // in flight. We consult the explicit deletedPhotoIds registry rather
        // than the queue — the registry is only set by purgeDeletedDamagePhoto,
        // so a retake supersession (which also removes a queue record) is never
        // mistaken for a deletion and never triggers an erroneous server DELETE.
        if (deletedPhotoIds.has(job.id)) {
          // Inspector deleted this photo while the PUT was in flight.
          // Remove the server copy that just landed so the delete wins.
          api.deleteQuotePhoto({ id: job.id }).catch(() => {});
        } else {
          // Normal path: clear this capture and any older superseded records
          // for the same slot — but never a newer retake added mid-flight.
          await removeJob(job.key);
          await removeJobsForPhoto(job.id, job.key, job.addedAt);
        }
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
