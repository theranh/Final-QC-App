// Durable pending-commit record for Final QC and re-check submissions.
//
// The commit payload is written here BEFORE the network call and cleared only
// after the server confirms success (or confirms the work is already saved).
// If the write fails — offline, 5xx, crash mid-request — the app shows a
// persistent NOT SAVED banner with a Retry, instead of looking saved.
//
// Only one commit is ever in flight at a time in this app (the SAVE buttons
// are disabled while saving), so a single slot is sufficient.

const KEY = 'fq_pending_commit_v1';

/** entry: { type: 'create'|'recheck', payload, qc? } */
export function savePendingCommit(entry) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...entry, ts: Date.now() }));
  } catch {
    /* private mode / quota — banner still shows for the in-memory copy */
  }
}

export function loadPendingCommit() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object') return null;
    if (v.type !== 'create' && v.type !== 'recheck') return null;
    if (!v.payload || typeof v.payload !== 'object') return null;
    if (v.type === 'recheck' && !v.qc) return null;
    return v;
  } catch {
    return null;
  }
}

export function clearPendingCommit() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
