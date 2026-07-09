import { CATS } from './constants';
import { failList } from './records';

const PREFIX = 'fqc_';

export function loadLS(key, fallback) {
  try {
    const v = localStorage.getItem(PREFIX + key);
    if (v == null) return fallback;
    const p = JSON.parse(v);
    return p == null ? fallback : p;
  } catch {
    return fallback;
  }
}

export function saveLS(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

// Ensure older/imported records carry the re-check fields the app relies on.
export function migrateRecord(r) {
  if (!r.status) r.status = r.result === 'pass' ? 'pass' : 'open';
  if (!r.rechecks) r.rechecks = [];
  if (!r.openItems) {
    r.openItems = r.status === 'open' ? failList(r, CATS).map((f) => ({ cat: f.k, item: f.item, note: f.note, photos: f.photos })) : [];
  }
  return r;
}

export function newDraft(uid) {
  return { stock: '', vehicle: '', vin: '', uid };
}

// Strip 're-check' scoped keys (rc|N) out of a marks/notes/photos map before
// persisting the resumable "new inspection" draft, or before re-entering a fresh re-check.
export function stripRc(m) {
  const o = {};
  Object.keys(m || {}).forEach((k) => {
    if (k.indexOf('rc|') !== 0) o[k] = m[k];
  });
  return o;
}

export function persistDraftBundle({ draft, marks, notes, photos, optOut, stage }) {
  return saveLS('draft', {
    draft,
    marks: stripRc(marks),
    notes: stripRc(notes),
    photos: stripRc(photos),
    optOut,
    stage: stage === 'sheet' || stage === 'form' ? stage : null,
  });
}

// In-progress drafts are device-local scratch space; committed inspections live
// in the shared database. This only restores an unfinished draft on this device.
export function initDraftBoot() {
  const draftBlob = loadLS('draft', null);
  if (draftBlob && draftBlob.draft) {
    return {
      draft: draftBlob.draft,
      marks: draftBlob.marks || {},
      notes: draftBlob.notes || {},
      photos: draftBlob.photos || {},
      optOut: draftBlob.optOut || {},
      stage: draftBlob.stage === 'sheet' ? 'sheet' : draftBlob.stage === 'form' ? 'form' : null,
    };
  }
  return { draft: newDraft('me'), marks: {}, notes: {}, photos: {}, optOut: {}, stage: null };
}

// ---------- legacy on-device data (pre-database versions) ----------

export function hasLegacyData() {
  const recs = loadLS('inspections', null);
  return Array.isArray(recs) && recs.length > 0;
}

export function loadLegacyData() {
  const recs = loadLS('inspections', []) || [];
  recs.forEach(migrateRecord);
  return { inspections: recs, seq: loadLS('seq', 1001) };
}

export function legacyImportDone() {
  return !!loadLS('legacyImported', false);
}

export function markLegacyImported() {
  saveLS('legacyImported', true);
}
