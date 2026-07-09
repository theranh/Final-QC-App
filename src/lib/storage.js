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

export const SEED_USERS = [
  { id: 1, name: 'R. Delgado', title: 'VRA', email: 'rdelgado@truckranch.com' },
  { id: 2, name: 'Theran', title: 'Dir. Bus Dev.', email: 'theran@truckranch.com' },
  { id: 3, name: 'Ryan', title: 'Director', email: 'ryan@truckranch.com' },
];

export function loadUsers() {
  const users = loadLS('users', null);
  if (users && users.length) return users;
  saveLS('users', SEED_USERS);
  return SEED_USERS.map((u) => ({ ...u }));
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

export function loadInspections() {
  const recs = loadLS('inspections', []);
  recs.forEach(migrateRecord);
  return recs;
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

// One-time read of everything localStorage needs to seed initial React state on mount.
export function initBoot() {
  const users = loadUsers();
  const defaultUid = loadLS('default', users[0] && users[0].id);
  const recs = loadInspections();
  const seq = loadLS('seq', 1001);
  const draftBlob = loadLS('draft', null);
  if (draftBlob && draftBlob.draft) {
    return {
      users,
      defaultUid,
      recs,
      seq,
      draft: draftBlob.draft,
      marks: draftBlob.marks || {},
      notes: draftBlob.notes || {},
      photos: draftBlob.photos || {},
      optOut: draftBlob.optOut || {},
      stage: draftBlob.stage === 'sheet' ? 'sheet' : draftBlob.stage === 'form' ? 'form' : null,
    };
  }
  return { users, defaultUid, recs, seq, draft: newDraft(defaultUid), marks: {}, notes: {}, photos: {}, optOut: {}, stage: null };
}
