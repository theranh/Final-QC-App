import { useCallback, useEffect, useRef, useState } from 'react';
import { CATS } from '../lib/constants';
import { initials, fmtDT } from '../lib/format';
import { loadLegacyData, hasLegacyData, markLegacyImported, legacyImportDone } from '../lib/storage';
import { parseBackupFile, convertOldReconBackup } from '../lib/exports';
import { api } from '../lib/api';
import { orientedJpegDataUrl } from '../lib/photo';

// ---------------------------------------------------------------------------
// Fleet-scan checkpoint helpers — exported for testing
// ---------------------------------------------------------------------------
export const FLEET_SCAN_KEY = 'fleetScanProgress_v1';

export const saveFleetProgress = (offset, accumulated, totalScanned) => {
  try { localStorage.setItem(FLEET_SCAN_KEY, JSON.stringify({ offset, accumulated, totalScanned })); } catch {}
};
export const loadFleetProgress = () => {
  try {
    const raw = localStorage.getItem(FLEET_SCAN_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
};
export const removeFleetProgress = () => {
  try { localStorage.removeItem(FLEET_SCAN_KEY); } catch {}
};

/**
 * Core fleet-scan loop — exported for unit testing.
 *
 * Calls `apiFn(offset)` repeatedly, accumulates candidates, and fires
 * `onPage({ offset, totalScanned, accumulated, newCandidates, done })` after
 * each successful page.  Throws if `apiFn` throws (so the caller can
 * checkpoint the last-saved offset and surface the error).
 *
 * @param {(offset: number) => Promise<{scanned:number, candidates?:any[], done:boolean}>} apiFn
 * @param {{offset?:number, totalScanned?:number, accumulated?:any[]}|null} resumeFrom
 * @param {{ onPage?: (info: object) => void }} callbacks
 * @returns {Promise<{totalScanned: number, accumulated: any[]}>}
 */
export async function runFleetScanLoop(apiFn, resumeFrom, callbacks = {}) {
  const { onPage } = callbacks;
  let offset = resumeFrom?.offset ?? 0;
  let totalScanned = resumeFrom?.totalScanned ?? 0;
  const accumulated = resumeFrom?.accumulated ? [...resumeFrom.accumulated] : [];

  while (true) {
    const r = await apiFn(offset);
    totalScanned += r.scanned;
    offset += r.scanned;
    const newCandidates = r.candidates?.length ? r.candidates : [];
    if (newCandidates.length) accumulated.push(...newCandidates);
    onPage?.({ offset, totalScanned, accumulated: [...accumulated], newCandidates, done: !!r.done });
    if (r.done) break;
  }

  return { totalScanned, accumulated };
}

const STATUS_META = {
  pending: { label: 'PENDING', bg: 'var(--amber)' },
  active: { label: 'ACTIVE', bg: 'var(--green)' },
  inactive: { label: 'DEACTIVATED', bg: 'var(--muted)' },
};

export default function SettingsScreen({ me, lastBackupAt, serverBackupAt, recs, nextQc, onExportBackup, onImported, onArchived, showToast }) {
  const importRef = useRef(null);
  const [employees, setEmployees] = useState(null);
  const [empError, setEmpError] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [pinFor, setPinFor] = useState(null); // employee id whose PIN is being set
  const [pinVal, setPinVal] = useState('');
  const [adding, setAdding] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [importing, setImporting] = useState(false);
  const [legacyPresent, setLegacyPresent] = useState(() => hasLegacyData() && !legacyImportDone());
  const [snapshots, setSnapshots] = useState(null);
  const [snapError, setSnapError] = useState(false);
  const [snapMonth, setSnapMonth] = useState('');
  const [snapBusy, setSnapBusy] = useState(false);

  const isAdmin = !!me.isAdmin;

  // Recent months as "Mon YYYY" tab names (this month + the prior 11), matching
  // the tracker's monthly tabs. Newest first; excludes the current live month is
  // NOT done here — the admin may snapshot a month once it has closed.
  const recentMonths = (() => {
    const now = new Date();
    const out = [];
    for (let i = 0; i < 12; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      out.push(d.toLocaleString('en-US', { month: 'short' }) + ' ' + d.getFullYear());
    }
    return out;
  })();

  const loadSnapshots = useCallback(() => {
    if (!me.isAdmin) return;
    api
      .trackerSnapshots()
      .then((d) => { setSnapshots(d.snapshots || []); setSnapError(false); })
      .catch(() => setSnapError(true));
  }, [me.isAdmin]);
  useEffect(() => { loadSnapshots(); }, [loadSnapshots]);
  useEffect(() => { if (isAdmin && !snapMonth) setSnapMonth(recentMonths[1] || recentMonths[0] || ''); }, [isAdmin]); // eslint-disable-line react-hooks/exhaustive-deps

  const runSnapshot = () => {
    if (!snapMonth || snapBusy) return;
    setSnapBusy(true);
    api
      .snapshotTrackerMonth(snapMonth)
      .then((r) => {
        showToast(`Snapshotted ${r.month}: ${r.rows} row${r.rows === 1 ? '' : 's'} frozen ✓`);
        loadSnapshots();
      })
      .catch((err) => showToast('Snapshot failed: ' + err.message))
      .finally(() => setSnapBusy(false));
  };

  const loadEmployees = useCallback(() => {
    if (!me.isAdmin) return;
    api
      .employees()
      .then((rows) => { setEmployees(rows); setEmpError(false); })
      .catch(() => setEmpError(true));
  }, [me.isAdmin]);
  useEffect(() => { loadEmployees(); }, [loadEmployees]);

  const patchEmployee = (emp, patch, okMsg) => {
    setBusyId(emp.id);
    api
      .updateEmployee(emp.id, patch)
      .then((row) => {
        setEmployees((prev) => prev.map((e) => (e.id === row.id ? row : e)));
        showToast(okMsg);
      })
      .catch((err) => showToast(err.message))
      .finally(() => setBusyId(null));
  };

  const savePin = (emp) => {
    if (!/^\d{4}$/.test(pinVal)) {
      showToast('PIN must be 4 digits');
      return;
    }
    setBusyId(emp.id);
    api
      .setEmployeePin(emp.id, pinVal)
      .then(() => {
        setEmployees((prev) => prev.map((e) => (e.id === emp.id ? { ...e, hasPin: true } : e)));
        setPinFor(null);
        setPinVal('');
        showToast('PIN set ✓');
      })
      .catch((err) => showToast(err.message))
      .finally(() => setBusyId(null));
  };

  const [repairBusy, setRepairBusy] = useState(false);
  const runRepair = () => {
    if (repairBusy) return;
    setRepairBusy(true);
    api
      .repairImportedRechecks()
      .then((r) => showToast(r.scanned === 0 ? 'Nothing to repair — all re-checks are complete ✓' : `Repaired ${r.rebuilt} re-check${r.rebuilt === 1 ? '' : 's'}, cleared ${r.cleared} ✓`))
      .catch((err) => showToast('Repair failed: ' + err.message))
      .finally(() => setRepairBusy(false));
  };

  // Phase 1A — read-only pricing-accuracy report (observation only).
  const [accBusy, setAccBusy] = useState(false);
  const [accReport, setAccReport] = useState(null);
  const loadAccuracy = () => {
    if (accBusy) return;
    setAccBusy(true);
    api
      .accuracyReport()
      .then((r) => setAccReport(r))
      .catch((err) => showToast('Report failed: ' + err.message))
      .finally(() => setAccBusy(false));
  };

  const [archiveBusy, setArchiveBusy] = useState(false);
  const runArchiveImported = () => {
    if (archiveBusy) return;
    setArchiveBusy(true);
    api
      .archiveImported()
      .then((r) => {
        showToast(r.archived === 0 ? 'Nothing to archive — all imported units are already archived ✓' : `Archived ${r.archived} imported unit${r.archived === 1 ? '' : 's'} ✓`);
        if (r.archived > 0 && onArchived) onArchived();
      })
      .catch((err) => showToast('Archive failed: ' + err.message))
      .finally(() => setArchiveBusy(false));
  };

  // ----- photo orientation repair -----
  const [photoRepairMode, setPhotoRepairMode] = useState('single'); // 'single' | 'fleet'

  // --- single-truck mode ---
  const [photoRepairQuoteId, setPhotoRepairQuoteId] = useState('');
  const [photoRepairScanState, setPhotoRepairScanState] = useState('idle'); // idle | scanning | done | fixing | fixed | error
  const [photoRepairCandidates, setPhotoRepairCandidates] = useState(null); // null | [{id, slot, quoteId, orientation}]
  const [photoRepairProgress, setPhotoRepairProgress] = useState({ done: 0, total: 0 });
  const [photoRepairError, setPhotoRepairError] = useState('');

  const runPhotoScan = async () => {
    const qid = photoRepairQuoteId.trim().toUpperCase();
    if (!qid) { setPhotoRepairError('Enter a truck ID first'); return; }
    setPhotoRepairScanState('scanning');
    setPhotoRepairCandidates(null);
    setPhotoRepairError('');
    try {
      const r = await api.photoOrientationCandidates(qid);
      setPhotoRepairCandidates(r.candidates || []);
      setPhotoRepairScanState('done');
    } catch (err) {
      setPhotoRepairError('Scan failed: ' + err.message);
      setPhotoRepairScanState('error');
    }
  };

  const runPhotoFix = async (candidateList, onProgress, onDone, onError) => {
    const list = candidateList || photoRepairCandidates;
    if (!list || !list.length) return;
    const setProgress = onProgress || ((d, t) => setPhotoRepairProgress({ done: d, total: t }));
    const setDone = onDone || (() => {
      setPhotoRepairScanState('fixed');
      showToast(`Fixed ${list.length} photo${list.length === 1 ? '' : 's'} ✓`);
    });
    const setError = onError || ((msg) => {
      setPhotoRepairError(msg);
      setPhotoRepairScanState('error');
    });
    if (!onProgress) {
      setPhotoRepairScanState('fixing');
      setPhotoRepairProgress({ done: 0, total: list.length });
      setPhotoRepairError('');
    }
    try {
      for (let i = 0; i < list.length; i++) {
        const ph = list[i];
        // Fetch the raw JPEG bytes from the server
        const resp = await fetch(`/api/quoter/photo?id=${encodeURIComponent(ph.id)}`);
        if (!resp.ok) throw new Error(`Could not fetch photo ${ph.id} (${resp.status})`);
        const blob = await resp.blob();
        // Re-encode upright: createImageBitmap with imageOrientation:'from-image' bakes
        // the EXIF rotation into pixels, then the canvas produces an orientation-1 JPEG.
        const dataUrl = await orientedJpegDataUrl(blob, 1600, 0.8);
        await api.putQuotePhoto({ id: ph.id, quoteId: ph.quoteId, slot: ph.slot || '', dataUrl });
        setProgress(i + 1, list.length);
      }
      setDone();
      // PAGE-RELOAD SAFETY: No "fixed IDs" set is needed here.
      // orientedJpegDataUrl() produces a canvas.toDataURL() JPEG that carries
      // no EXIF APP1 segment.  The server stores those raw bytes, so the next
      // call to runPhotoScan hits readJpegExifOrientation() and gets null (no
      // tag).  The candidate filter is `orientation !== null && orientation !== 1`,
      // so null is excluded — already-fixed photos are never returned as
      // candidates again after a page reload + re-scan, even though
      // photoRepairCandidates is reset to null by React on remount.
    } catch (err) {
      setError('Fix failed: ' + err.message);
    }
  };

  // --- fleet scan mode ---
  const [fleetScanState, setFleetScanState] = useState('idle'); // idle | scanning | done | fixing | fixed | error
  const [fleetScanned, setFleetScanned] = useState(0);
  const [fleetCandidates, setFleetCandidates] = useState([]); // [{id, slot, quoteId, orientation}]
  const [fleetFixProgress, setFleetFixProgress] = useState({ done: 0, total: 0, currentQuoteId: '' });
  const [fleetError, setFleetError] = useState('');
  const [fleetTruckBusy, setFleetTruckBusy] = useState(new Set()); // quoteIds currently being fixed individually
  const [fleetResumable, setFleetResumable] = useState(false);

  // Wraps the module-level removeFleetProgress so it also clears the React flag
  const clearFleetProgress = () => {
    removeFleetProgress();
    setFleetResumable(false);
  };

  // Check for a saved resume point whenever fleet mode becomes active
  useEffect(() => {
    if (photoRepairMode === 'fleet') {
      setFleetResumable(!!loadFleetProgress());
    }
  }, [photoRepairMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Derived: group fleet candidates by quoteId for display
  const fleetByTruck = (() => {
    const map = new Map();
    for (const c of fleetCandidates) {
      if (!map.has(c.quoteId)) map.set(c.quoteId, []);
      map.get(c.quoteId).push(c);
    }
    return Array.from(map.entries()).map(([quoteId, list]) => ({ quoteId, count: list.length }));
  })();

  // Runs (or resumes) the fleet scan. Pass a saved progress object to resume mid-scan.
  const runFleetScan = async (resumeFrom = null) => {
    setFleetScanState('scanning');
    setFleetError('');

    // Restore visible state immediately so the UI shows correct counts while scanning
    setFleetScanned(resumeFrom?.totalScanned ?? 0);
    setFleetCandidates(resumeFrom?.accumulated ? [...resumeFrom.accumulated] : []);

    if (!resumeFrom) {
      // Fresh start — drop any stale checkpoint
      clearFleetProgress();
    }

    try {
      await runFleetScanLoop(
        (offset) => api.photoOrientationScanAll(offset),
        resumeFrom,
        {
          onPage: ({ offset, totalScanned, accumulated, newCandidates }) => {
            setFleetScanned(totalScanned);
            if (newCandidates.length) setFleetCandidates([...accumulated]);
            // Checkpoint after every page so the browser can resume if the tab sleeps
            saveFleetProgress(offset, accumulated, totalScanned);
          },
        },
      );
      clearFleetProgress();
      setFleetScanState('done');
    } catch (err) {
      // Progress is already checkpointed up to the last successful page
      setFleetResumable(true);
      setFleetError('Scan interrupted: ' + err.message);
      setFleetScanState('error');
    }
  };

  const runFleetFix = async () => {
    if (!fleetCandidates.length) return;
    // Snapshot the list at start so we iterate a stable copy even as state updates.
    const list = [...fleetCandidates];
    const totalTrucks = new Set(list.map((c) => c.quoteId)).size;
    setFleetScanState('fixing');
    setFleetFixProgress({ done: 0, total: list.length, currentQuoteId: list[0]?.quoteId || '' });
    setFleetError('');
    let fixed = 0;
    try {
      for (let i = 0; i < list.length; i++) {
        const ph = list[i];
        const resp = await fetch(`/api/quoter/photo?id=${encodeURIComponent(ph.id)}`);
        if (!resp.ok) throw new Error(`Could not fetch photo ${ph.id} (${resp.status})`);
        const blob = await resp.blob();
        const dataUrl = await orientedJpegDataUrl(blob, 1600, 0.8);
        await api.putQuotePhoto({ id: ph.id, quoteId: ph.quoteId, slot: ph.slot || '', dataUrl });
        // Remove this photo immediately after it's confirmed uploaded so an
        // interruption leaves only unprocessed photos in fleetCandidates.
        setFleetCandidates((prev) => prev.filter((c) => c.id !== ph.id));
        fixed += 1;
        setFleetFixProgress({ done: fixed, total: list.length, currentQuoteId: list[i + 1]?.quoteId || ph.quoteId });
      }
      setFleetScanState('fixed');
      showToast(`Fixed ${fixed} photo${fixed === 1 ? '' : 's'} across ${totalTrucks} truck${totalTrucks === 1 ? '' : 's'} ✓`);
    } catch (err) {
      setFleetError('Fix failed: ' + err.message);
      setFleetScanState('error');
    }
    // PAGE-RELOAD SAFETY: No sessionStorage "fixed IDs" set is needed here.
    // orientedJpegDataUrl() produces a canvas.toDataURL() JPEG, which carries
    // no EXIF APP1 segment. The server stores those raw bytes, so the next scan
    // calls readJpegExifOrientation() on the new data and gets null (no tag).
    // The scan filter is `orientation !== null && orientation !== 1`, so null
    // is excluded — already-fixed photos never reappear as candidates after a
    // page reload + re-scan, even if fleetCandidates was reset to [] by React.
  };

  const runFleetFixOne = async (quoteId) => {
    // Take a snapshot of this truck's candidates at the start. The truck row
    // is removed from fleetCandidates one photo at a time as each upload
    // succeeds. If the fix is interrupted mid-way the unprocessed photos
    // remain in fleetCandidates, keeping the truck row visible so the admin
    // can retry without re-processing photos that already succeeded.
    const candidates = fleetCandidates.filter((c) => c.quoteId === quoteId);
    if (!candidates.length) return;
    setFleetTruckBusy((prev) => new Set([...prev, quoteId]));
    setFleetError('');
    let fixed = 0;
    try {
      for (const ph of candidates) {
        const resp = await fetch(`/api/quoter/photo?id=${encodeURIComponent(ph.id)}`);
        if (!resp.ok) throw new Error(`Could not fetch photo ${ph.id} (${resp.status})`);
        const blob = await resp.blob();
        const dataUrl = await orientedJpegDataUrl(blob, 1600, 0.8);
        await api.putQuotePhoto({ id: ph.id, quoteId: ph.quoteId, slot: ph.slot || '', dataUrl });
        // Remove this specific photo immediately after it's confirmed uploaded.
        // On an interruption the remaining photos stay in fleetCandidates so
        // the truck row persists and the admin can resume without redundant work.
        setFleetCandidates((prev) => prev.filter((c) => c.id !== ph.id));
        fixed += 1;
      }
      showToast(`Fixed ${candidates.length} photo${candidates.length === 1 ? '' : 's'} for ${quoteId} ✓`);
    } catch (err) {
      // Some photos may have been fixed before the error; report how many
      // remain so the admin knows the truck row is still there to retry.
      const remaining = candidates.length - fixed;
      setFleetError(`Fix failed for ${quoteId} after ${fixed}/${candidates.length} photos: ${err.message}. ${remaining} photo${remaining === 1 ? '' : 's'} still need fixing — tap Fix again to resume.`);
    } finally {
      setFleetTruckBusy((prev) => { const s = new Set(prev); s.delete(quoteId); return s; });
    }
  };

  const [unlockBusy, setUnlockBusy] = useState(false);
  const runUnlockQuotes = () => {
    if (unlockBusy) return;
    setUnlockBusy(true);
    api
      .unlockQuotes()
      .then((r) => showToast(r.unlocked === 0 ? 'All quotes are already unlocked ✓' : `Unlocked ${r.unlocked} quote${r.unlocked === 1 ? '' : 's'} for editing ✓`))
      .catch((err) => showToast('Unlock failed: ' + err.message))
      .finally(() => setUnlockBusy(false));
  };

  const addEmployee = () => {
    const email = newEmail.trim().toLowerCase();
    if (!email.endsWith('@truckranch.com')) {
      showToast('Only @truckranch.com emails can be approved');
      return;
    }
    setBusyId('new');
    api
      .addEmployee({ email, name: newName.trim(), title: newTitle.trim() || 'Inspector' })
      .then((row) => {
        setEmployees((prev) => (prev ? prev.concat([row]) : [row]));
        setAdding(false);
        setNewEmail(''); setNewName(''); setNewTitle('');
        showToast('Employee pre-approved ✓');
      })
      .catch((err) => showToast(err.message))
      .finally(() => setBusyId(null));
  };

  // Split full-backup photos into ~25 MB requests so a 400+ MB backup never
  // exceeds the server's request-size limit; totals are merged for the toast.
  const PHOTO_BATCH_BYTES = 25 * 1024 * 1024;
  const photoBatches = (photos) => {
    const batches = [];
    let cur = [];
    let size = 0;
    for (const p of photos) {
      const n = (p.b64 || '').length;
      if (cur.length && size + n > PHOTO_BATCH_BYTES) {
        batches.push(cur);
        cur = [];
        size = 0;
      }
      cur.push(p);
      size += n;
    }
    if (cur.length) batches.push(cur);
    return batches;
  };

  const runImport = async (payload, source) => {
    setImporting(true);
    try {
      const { quoterPhotos, ...main } = payload;
      const total = await api.importLegacy(main);
      for (const batch of photoBatches(quoterPhotos || [])) {
        const r = await api.importLegacy({ quoterPhotos: batch });
        total.quoter = total.quoter || {};
        total.quoter.photosAdded = (total.quoter.photosAdded || 0) + (r.quoter?.photosAdded || 0);
        total.quoter.photosSkipped = (total.quoter.photosSkipped || 0) + (r.quoter?.photosSkipped || 0);
      }
      const q = total.quoter || {};
      const parts = [`${total.imported} inspection${total.imported === 1 ? '' : 's'} added`];
      if (total.skipped) parts.push(`${total.skipped} duplicate${total.skipped === 1 ? '' : 's'} skipped`);
      if (total.employeesAdded) parts.push(`${total.employeesAdded} employee${total.employeesAdded === 1 ? '' : 's'} added`);
      const quoterAdds = [
        q.quotesAdded && `${q.quotesAdded} quote${q.quotesAdded === 1 ? '' : 's'}`,
        q.intakesAdded && `${q.intakesAdded} intake${q.intakesAdded === 1 ? '' : 's'}`,
        q.correctionsAdded && `${q.correctionsAdded} correction${q.correctionsAdded === 1 ? '' : 's'}`,
        q.trackerRowsAdded && `${q.trackerRowsAdded} tracker row${q.trackerRowsAdded === 1 ? '' : 's'}`,
        q.photosAdded && `${q.photosAdded} photo${q.photosAdded === 1 ? '' : 's'}`,
      ].filter(Boolean);
      if (quoterAdds.length) parts.push(`Quoter: ${quoterAdds.join(', ')} added`);
      showToast(`Import complete: ${parts.join(' · ')} ✓`);
      if (source === 'legacy') {
        markLegacyImported();
        setLegacyPresent(false);
      }
      onImported();
    } catch (err) {
      showToast('Import failed: ' + err.message);
    } finally {
      setImporting(false);
    }
  };

  const onImportLegacy = () => {
    const data = loadLegacyData();
    if (!data.inspections.length) {
      showToast('No inspections found on this device');
      markLegacyImported();
      setLegacyPresent(false);
      return;
    }
    if (!window.confirm(`Import ${data.inspections.length} inspection${data.inspections.length === 1 ? '' : 's'} from this device into the shared database?\nRecords already in the database are skipped — nothing is overwritten.`)) return;
    runImport({ inspections: data.inspections, seq: data.seq }, 'legacy');
  };

  const onImportFile = (file) => {
    parseBackupFile(file)
      .then((data) => {
        if (data.oldRecon) {
          const { inspections, skippedInProgress } = convertOldReconBackup(data.records);
          if (!inspections.length) {
            showToast('No completed inspections found in that file' + (skippedInProgress ? ` (${skippedInProgress} unfinished/unreadable skipped)` : ''));
            return;
          }
          const extra = skippedInProgress ? `\n${skippedInProgress} unfinished or unreadable inspection${skippedInProgress === 1 ? '' : 's'} will be skipped.` : '';
          if (!window.confirm(`This looks like a backup from the old Truck Recon Checklist app.\nImport ${inspections.length} completed inspection${inspections.length === 1 ? '' : 's'}? Each gets a new FQ number automatically.${extra}\nNothing already in the database is overwritten.`)) return;
          runImport({ inspections }, 'file');
          return;
        }
        const empNote = isAdmin && Array.isArray(data.employees) && data.employees.length
          ? `\nMissing employees from the backup's allowlist are added too (existing employees are never changed).`
          : '';
        const quoterNote = isAdmin && (data.quoter || (data.quoterPhotos || []).length)
          ? `\nQuoter data in this backup (quotes, intakes, corrections, tracker${(data.quoterPhotos || []).length ? ', photos' : ''}) is restored additively too.`
          : '';
        if (!window.confirm(`Import ${data.inspections.length} inspection${data.inspections.length === 1 ? '' : 's'} from this backup into the shared database?\nRecords already in the database are skipped — nothing is overwritten.${empNote}${quoterNote}`)) return;
        const payload = { inspections: data.inspections, seq: data.seq };
        // Only admins may restore the employee allowlist / Quoter data; the server enforces this.
        if (isAdmin && Array.isArray(data.employees)) payload.employees = data.employees;
        if (isAdmin && data.quoter && typeof data.quoter === 'object') payload.quoter = data.quoter;
        if (isAdmin && Array.isArray(data.quoterPhotos)) payload.quoterPhotos = data.quoterPhotos;
        runImport(payload, 'file');
      })
      .catch((err) => showToast(err.message));
  };

  const photoCount = recs.reduce((a, r) => {
    let n = 0;
    CATS.forEach((c) => ((r.items && r.items[c.k]) || []).forEach((it) => { n += (it.photos || []).length; }));
    (r.rechecks || []).forEach((cy) => cy.items.forEach((it) => { n += (it.photos || []).length; }));
    return a + n;
  }, 0);

  const backupMeta = `${recs.length} inspection${recs.length === 1 ? '' : 's'} · ${photoCount} photo${photoCount === 1 ? '' : 's'} · next ID FQ-${nextQc}`;

  // Admins see the authoritative team-wide time (server audit log — exports
  // from any device count); non-admins still see this device's local record.
  // serverBackupAt: undefined = still loading, null = no export ever.
  const usingServerTime = isAdmin && serverBackupAt !== undefined;
  const effectiveBackupAt = usingServerTime ? serverBackupAt : lastBackupAt;
  const daysSinceBackup = effectiveBackupAt ? Math.floor((Date.now() - effectiveBackupAt) / 86400000) : null;
  const backupStale = daysSinceBackup == null || daysSinceBackup >= 7;
  const scopeSuffix = usingServerTime ? ' (whole team, any device)' : ' on this device';
  const backupStatusLabel =
    daysSinceBackup == null
      ? usingServerTime
        ? 'No server backup has ever been exported.'
        : 'Never backed up on this device.'
      : daysSinceBackup === 0
      ? `Last backup: today (${fmtDT(effectiveBackupAt)})${scopeSuffix}.`
      : `Last backup: ${daysSinceBackup} day${daysSinceBackup === 1 ? '' : 's'} ago (${fmtDT(effectiveBackupAt)})${scopeSuffix}.`;

  const canAdd = newEmail.trim().toLowerCase().endsWith('@truckranch.com');

  return (
    <div className="screen">
      <div className="screen-topbar" style={{ padding: '8px 16px 12px' }}>
        <span className="screen-title">Settings</span>
      </div>
      <div className="screen-body" style={{ gap: 9 }}>
        <div className="card">
          <div className="card-title">SIGNED IN</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 9 }}>
            <span style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--brown)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Oswald, sans-serif', fontSize: 11, fontWeight: 600, flex: '0 0 auto' }}>
              {initials(me.name)}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 700 }}>{me.name}</span>
                {isAdmin && <span style={{ fontSize: 8, fontWeight: 700, color: '#fff', background: 'var(--brown)', padding: '2px 6px', borderRadius: 4 }}>ADMIN</span>}
              </div>
              <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 1 }}>{me.title} · {me.email}</div>
            </div>
            <a href="/api/logout" style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--red)', textDecoration: 'none', border: '1px solid var(--border)', borderRadius: 7, padding: '8px 11px', background: 'var(--panel)' }}>
              Sign out
            </a>
          </div>
          <div style={{ fontSize: 9, color: 'var(--muted)', marginTop: 9, lineHeight: 1.5 }}>
            Every inspection and re-check you commit is recorded under this account.
          </div>
        </div>

        {isAdmin && (
          <div className="card">
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <div className="card-title" style={{ flex: 1 }}>EMPLOYEES</div>
              <div style={{ background: 'var(--red)', color: '#fff', fontSize: 11, fontWeight: 700, borderRadius: 8, padding: '9px 13px', cursor: 'pointer' }} onClick={() => setAdding(true)}>+ Approve email</div>
            </div>
            {empError && (
              <div style={{ fontSize: 10.5, color: 'var(--red)', marginTop: 8 }}>
                Could not load employees. <span style={{ fontWeight: 700, cursor: 'pointer', textDecoration: 'underline' }} onClick={loadEmployees}>Retry</span>
              </div>
            )}
            {employees == null && !empError && <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 8 }}>Loading…</div>}
            <div style={{ display: 'flex', flexDirection: 'column', marginTop: 6 }}>
              {(employees || []).map((u) => {
                const sm = STATUS_META[u.status] || STATUS_META.pending;
                const isSelf = u.id === me.id;
                const busy = busyId === u.id;
                return (
                  <div key={u.id} style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 9, padding: '10px 0', borderTop: '1px solid #F5F1EC' }}>
                    <span style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--brown)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Oswald, sans-serif', fontSize: 11, fontWeight: 600, flex: '0 0 auto' }}>
                      {initials(u.name || u.email)}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 13, fontWeight: 700 }}>{u.name || u.email.split('@')[0]}</span>
                        <span style={{ fontSize: 8, fontWeight: 700, color: '#fff', background: sm.bg, padding: '2px 6px', borderRadius: 4 }}>{sm.label}</span>
                        {u.isAdmin && <span style={{ fontSize: 8, fontWeight: 700, color: '#fff', background: 'var(--brown)', padding: '2px 6px', borderRadius: 4 }}>ADMIN</span>}
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 1 }}>{u.title} · {u.email}</div>
                    </div>
                    {!isSelf && u.status !== 'active' && (
                      <div style={{ fontSize: 9.5, fontWeight: 700, color: '#fff', background: 'var(--green)', cursor: busy ? 'wait' : 'pointer', borderRadius: 7, padding: '8px 11px', opacity: busy ? 0.6 : 1 }} onClick={() => !busy && patchEmployee(u, { status: 'active' }, (u.status === 'pending' ? 'Approved' : 'Reactivated') + ' ✓')}>
                        {u.status === 'pending' ? 'Approve' : 'Reactivate'}
                      </div>
                    )}
                    {!isSelf && u.status === 'active' && (
                      <div style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--red)', cursor: busy ? 'wait' : 'pointer', border: '1px solid var(--border)', borderRadius: 7, padding: '8px 11px', background: 'var(--panel)', opacity: busy ? 0.6 : 1 }} onClick={() => !busy && window.confirm(`Deactivate ${u.email}? They immediately lose access. Their past inspections are kept.`) && patchEmployee(u, { status: 'inactive' }, 'Deactivated')}>
                        Deactivate
                      </div>
                    )}

                    {/* ---- sign-off controls: PIN, override, signer-list active ---- */}
                    <div style={{ flexBasis: '100%', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 7, marginTop: 2 }}>
                      <span style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: 0.6, color: 'var(--muted)' }}>SIGN-OFF</span>
                      <div
                        className={'pill-btn' + (u.active !== false ? ' on green' : '')}
                        style={{ height: 30, fontSize: 9.5, cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.6 : 1 }}
                        onClick={() => !busy && patchEmployee(u, { active: u.active === false }, u.active === false ? 'In signer list ✓' : 'Removed from signer list')}
                      >
                        {u.active !== false ? '✓ In signer list' : 'Not signing'}
                      </div>
                      <div
                        className={'pill-btn' + (u.canOverride ? ' on amber' : '')}
                        style={{ height: 30, fontSize: 9.5, cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.6 : 1 }}
                        onClick={() => !busy && patchEmployee(u, { canOverride: !u.canOverride }, u.canOverride ? 'Override off' : 'Override on ✓')}
                      >
                        {u.canOverride ? '★ Can override' : 'No override'}
                      </div>
                      <div
                        className="pill-btn"
                        style={{ height: 30, fontSize: 9.5 }}
                        onClick={() => { setPinFor(pinFor === u.id ? null : u.id); setPinVal(''); }}
                      >
                        {u.hasPin ? '🔑 Reset PIN' : '🔑 Set PIN'}
                      </div>
                    </div>
                    {pinFor === u.id && (
                      <div style={{ flexBasis: '100%', display: 'flex', alignItems: 'center', gap: 7, marginTop: 2 }}>
                        <input
                          className="input mono"
                          style={{ height: 40, width: 110, textAlign: 'center', letterSpacing: 6 }}
                          type="password"
                          inputMode="numeric"
                          maxLength={4}
                          placeholder="••••"
                          value={pinVal}
                          onChange={(e) => setPinVal(e.target.value.replace(/\D/g, '').slice(0, 4))}
                        />
                        <div className={'btn' + (/^\d{4}$/.test(pinVal) ? ' btn-green' : ' disabled')} style={{ flex: 1, height: 40, fontSize: 11, opacity: /^\d{4}$/.test(pinVal) ? 1 : 0.6 }} onClick={() => savePin(u)}>Save PIN</div>
                        <div className="btn btn-outline" style={{ flex: '0 0 auto', width: 'auto', height: 40, padding: '0 12px', fontSize: 11 }} onClick={() => { setPinFor(null); setPinVal(''); }}>Cancel</div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {adding && (
              <div style={{ marginTop: 10, border: '1.5px solid var(--brown)', borderRadius: 10, padding: 11, background: '#FDFCFB', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 0.8, color: 'var(--brown)' }}>PRE-APPROVE AN EMPLOYEE EMAIL</div>
                <input className="input" style={{ background: '#fff', height: 44, fontWeight: 400 }} type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="name@truckranch.com" />
                <input className="input" style={{ background: '#fff', height: 44 }} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Name (optional — filled from their login)" />
                <input className="input" style={{ background: '#fff', height: 44, fontWeight: 400 }} value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Position title (e.g. VRA)" />
                <div style={{ display: 'flex', gap: 7 }}>
                  <div className="btn btn-outline" style={{ flex: '0 0 auto', width: 'auto', height: 44, padding: '0 14px', fontSize: 11.5 }} onClick={() => setAdding(false)}>Cancel</div>
                  <div className={'btn' + (canAdd ? ' btn-green' : ' disabled')} style={{ flex: 1, height: 44, fontSize: 12 }} onClick={() => canAdd && busyId !== 'new' && addEmployee()}>
                    {canAdd ? 'Approve' : '@truckranch.com email required'}
                  </div>
                </div>
              </div>
            )}
            <div style={{ fontSize: 9, color: 'var(--muted)', marginTop: 9, lineHeight: 1.5 }}>
              Employees sign in with their @truckranch.com account. New sign-ins appear here as PENDING until an admin approves them.
            </div>
          </div>
        )}

        {isAdmin && (
          <div className="card">
            <div className="card-title">PRODUCTION TRACKER SNAPSHOTS</div>
            <div style={{ fontSize: 9, color: 'var(--muted)', marginTop: 7, lineHeight: 1.5 }}>
              Freeze a closed month from the VPC Production Tracker sheet. Reporting reads frozen months from here; the current month stays live. Re-snapshotting a month overwrites its rows — that’s the correction path.
            </div>
            {snapError && (
              <div style={{ fontSize: 10.5, color: 'var(--red)', marginTop: 8 }}>
                Could not load snapshots. <span style={{ fontWeight: 700, cursor: 'pointer', textDecoration: 'underline' }} onClick={loadSnapshots}>Retry</span>
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 9, flexWrap: 'wrap' }}>
              <select
                className="input"
                style={{ height: 44, width: 'auto', flex: '0 0 auto', minWidth: 120 }}
                value={snapMonth}
                onChange={(e) => setSnapMonth(e.target.value)}
              >
                {recentMonths.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
              <div
                className={'btn btn-brown' + (snapBusy || !snapMonth ? ' disabled' : '')}
                style={{ flex: 1, height: 44, fontSize: 12, opacity: snapBusy || !snapMonth ? 0.6 : 1 }}
                onClick={runSnapshot}
              >
                {snapBusy ? 'Snapshotting…' : '❄ Snapshot month'}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', marginTop: 4 }}>
              {snapshots == null && !snapError && (
                <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 8 }}>Loading…</div>
              )}
              {snapshots != null && snapshots.length === 0 && (
                <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 8 }}>No months frozen yet.</div>
              )}
              {(snapshots || []).map((s) => (
                <div key={s.month} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '9px 0', borderTop: '1px solid #F5F1EC' }}>
                  <span style={{ fontSize: 12, fontWeight: 700, flex: '0 0 auto', minWidth: 66 }}>{s.month}</span>
                  <span style={{ fontSize: 8, fontWeight: 700, color: '#fff', background: 'var(--brown)', padding: '2px 6px', borderRadius: 4 }}>
                    {s.rows} ROW{s.rows === 1 ? '' : 'S'}
                  </span>
                  <span style={{ flex: 1, minWidth: 0, textAlign: 'right', fontSize: 9.5, color: 'var(--muted)' }}>
                    {s.snapshotAt ? fmtDT(new Date(s.snapshotAt).getTime()) : '—'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {isAdmin && (
          <div className="card">
            <div className="card-title">UNLOCK BODY QUOTES</div>
            <div style={{ fontSize: 9, color: 'var(--muted)', marginTop: 7, lineHeight: 1.5 }}>
              Quotes signed off with the old “Commit quote” button are still locked, so adjustments silently don’t save. The intake SAVE is the only sign-off now — this unlocks all quotes so adjustments and photos can be edited again. Safe to run more than once.
            </div>
            <div
              className={'btn btn-brown' + (unlockBusy ? ' disabled' : '')}
              style={{ marginTop: 9, height: 44, fontSize: 12, opacity: unlockBusy ? 0.6 : 1 }}
              onClick={runUnlockQuotes}
            >
              {unlockBusy ? 'Unlocking…' : '🔓 Unlock body quotes'}
            </div>
          </div>
        )}

        {isAdmin && (
          <div className="card">
            <div className="card-title">REPAIR SIDEWAYS PHOTOS</div>
            <div style={{ fontSize: 9, color: 'var(--muted)', marginTop: 7, lineHeight: 1.5 }}>
              Phones embed an EXIF orientation tag instead of storing pixels upright. Photos taken before the orientation fix shipped may appear sideways.
            </div>

            {/* Mode toggle */}
            <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
              <div
                onClick={() => { setPhotoRepairMode('single'); setPhotoRepairScanState('idle'); setPhotoRepairCandidates(null); setPhotoRepairError(''); }}
                style={{ flex: 1, textAlign: 'center', padding: '7px 0', borderRadius: 7, fontSize: 10.5, fontWeight: 700, cursor: 'pointer', border: '1.5px solid var(--brown)', background: photoRepairMode === 'single' ? 'var(--brown)' : 'transparent', color: photoRepairMode === 'single' ? '#fff' : 'var(--brown)', transition: 'background 0.15s' }}
              >
                One truck
              </div>
              <div
                onClick={() => { setPhotoRepairMode('fleet'); setFleetScanState('idle'); setFleetCandidates([]); setFleetScanned(0); setFleetError(''); setFleetResumable(!!loadFleetProgress()); }}
                style={{ flex: 1, textAlign: 'center', padding: '7px 0', borderRadius: 7, fontSize: 10.5, fontWeight: 700, cursor: 'pointer', border: '1.5px solid var(--brown)', background: photoRepairMode === 'fleet' ? 'var(--brown)' : 'transparent', color: photoRepairMode === 'fleet' ? '#fff' : 'var(--brown)', transition: 'background 0.15s' }}
              >
                Scan all trucks
              </div>
            </div>

            {/* --- Single-truck mode --- */}
            {photoRepairMode === 'single' && (
              <>
                <div style={{ fontSize: 9, color: 'var(--muted)', marginTop: 8, lineHeight: 1.5 }}>
                  Enter a truck ID (e.g. BC23092) to scan and straighten its photos without retaking them.
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 9, alignItems: 'center' }}>
                  <input
                    value={photoRepairQuoteId}
                    onChange={(e) => {
                      setPhotoRepairQuoteId(e.target.value.toUpperCase());
                      setPhotoRepairScanState('idle');
                      setPhotoRepairCandidates(null);
                      setPhotoRepairError('');
                    }}
                    placeholder="Truck ID"
                    style={{ flex: 1, height: 36, padding: '0 10px', border: '1.5px solid var(--border)', borderRadius: 6, fontSize: 13, fontFamily: 'inherit', textTransform: 'uppercase' }}
                    maxLength={30}
                    disabled={photoRepairScanState === 'scanning' || photoRepairScanState === 'fixing'}
                  />
                  <div
                    className={'btn btn-brown' + (photoRepairScanState === 'scanning' || !photoRepairQuoteId.trim() ? ' disabled' : '')}
                    style={{ height: 36, fontSize: 12, paddingInline: 14, opacity: (photoRepairScanState === 'scanning' || !photoRepairQuoteId.trim()) ? 0.6 : 1, whiteSpace: 'nowrap' }}
                    onClick={photoRepairScanState !== 'scanning' ? runPhotoScan : undefined}
                  >
                    {photoRepairScanState === 'scanning' ? 'Scanning…' : '🔍 Scan'}
                  </div>
                </div>
                {photoRepairScanState === 'done' && photoRepairCandidates !== null && (
                  <div style={{ marginTop: 10 }}>
                    {photoRepairCandidates.length === 0 ? (
                      <div style={{ fontSize: 10.5, color: 'var(--green)', fontWeight: 600 }}>All photos are already upright ✓</div>
                    ) : (
                      <>
                        <div style={{ fontSize: 10.5, color: 'var(--brown)', marginBottom: 7 }}>
                          {photoRepairCandidates.length} sideways photo{photoRepairCandidates.length === 1 ? '' : 's'} found — fix will re-encode each one upright.
                        </div>
                        <div
                          className="btn btn-brown"
                          style={{ height: 40, fontSize: 12 }}
                          onClick={() => runPhotoFix()}
                        >
                          ↻ Fix {photoRepairCandidates.length} photo{photoRepairCandidates.length === 1 ? '' : 's'}
                        </div>
                      </>
                    )}
                  </div>
                )}
                {photoRepairScanState === 'fixing' && (
                  <div style={{ marginTop: 10, fontSize: 10.5, color: 'var(--brown)' }}>
                    Fixing {photoRepairProgress.done} / {photoRepairProgress.total}…
                  </div>
                )}
                {photoRepairScanState === 'fixed' && (
                  <div style={{ marginTop: 10, fontSize: 10.5, color: 'var(--green)', fontWeight: 600 }}>
                    Done — {photoRepairProgress.total} photo{photoRepairProgress.total === 1 ? '' : 's'} corrected ✓
                  </div>
                )}
                {photoRepairError && (
                  <div style={{ marginTop: 8, fontSize: 10.5, color: 'var(--red, #c0392b)' }}>{photoRepairError}</div>
                )}
              </>
            )}

            {/* --- Fleet scan mode --- */}
            {photoRepairMode === 'fleet' && (
              <>
                <div style={{ fontSize: 9, color: 'var(--muted)', marginTop: 8, lineHeight: 1.5 }}>
                  Pages through every photo in the database to find sideways ones. Large photo libraries may take a minute to scan. For best results, run from a desktop browser — mobile browsers may suspend the tab mid-scan. If the scan is interrupted, use the Resume button to pick up where it left off.
                </div>

                {fleetScanState === 'idle' && (
                  <div style={{ display: 'flex', gap: 7, marginTop: 10 }}>
                    <div
                      className="btn btn-brown"
                      style={{ flex: 1, height: 40, fontSize: 12 }}
                      onClick={() => runFleetScan(null)}
                    >
                      🔍 Scan all trucks
                    </div>
                    {fleetResumable && (() => {
                      const saved = loadFleetProgress();
                      const n = saved?.totalScanned ?? 0;
                      const c = saved?.accumulated?.length ?? 0;
                      return (
                        <div
                          className="btn btn-brown"
                          style={{ flex: 1, height: 40, fontSize: 12 }}
                          onClick={() => runFleetScan(saved)}
                        >
                          ↩ Resume scan ({n} photo{n === 1 ? '' : 's'} checked{c > 0 ? `, ${c} sideways` : ''})
                        </div>
                      );
                    })()}
                  </div>
                )}

                {fleetScanState === 'scanning' && (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontSize: 10.5, color: 'var(--brown)', marginBottom: 6 }}>
                      Scanning… {fleetScanned} photo{fleetScanned === 1 ? '' : 's'} checked
                      {fleetCandidates.length > 0 && ` · ${fleetCandidates.length} sideways found so far`}
                    </div>
                    <div style={{ height: 4, borderRadius: 2, background: 'var(--border)', overflow: 'hidden' }}>
                      <div style={{ height: '100%', borderRadius: 2, background: 'var(--brown)', width: '100%', opacity: 0.35 }} />
                    </div>
                  </div>
                )}

                {(fleetScanState === 'done' || fleetScanState === 'fixing' || fleetScanState === 'fixed') && (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontSize: 10.5, color: 'var(--muted)', marginBottom: 6 }}>
                      {fleetScanned} photo{fleetScanned === 1 ? '' : 's'} scanned
                      {fleetScanState === 'done' && fleetCandidates.length === 0 && ' — all upright ✓'}
                    </div>

                    {fleetCandidates.length > 0 && (
                      <>
                        {/* Truck list */}
                        <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', marginBottom: 10 }}>
                          <div style={{ padding: '7px 11px', background: 'var(--panel)', fontSize: 9, fontWeight: 700, letterSpacing: 0.6, color: 'var(--muted)', borderBottom: '1px solid var(--border)' }}>
                            {fleetByTruck.length} TRUCK{fleetByTruck.length === 1 ? '' : 'S'} AFFECTED · {fleetCandidates.length} PHOTO{fleetCandidates.length === 1 ? '' : 'S'}
                          </div>
                          <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                            {fleetByTruck.map(({ quoteId, count }) => {
                              const truckBusy = fleetTruckBusy.has(quoteId);
                              const fixAllRunning = fleetScanState === 'fixing';
                              return (
                                <div key={quoteId} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 11px', borderTop: '1px solid var(--border)', fontSize: 11 }}>
                                  <span style={{ fontFamily: 'monospace', fontWeight: 700, flex: 1 }}>{quoteId}</span>
                                  <span style={{ fontSize: 9.5, color: 'var(--brown)', fontWeight: 600 }}>{count} photo{count === 1 ? '' : 's'}</span>
                                  {fleetScanState === 'done' && (
                                    <div
                                      onClick={() => !truckBusy && !fixAllRunning && runFleetFixOne(quoteId)}
                                      style={{
                                        fontSize: 9.5, fontWeight: 700, color: '#fff',
                                        background: truckBusy || fixAllRunning ? 'var(--muted)' : 'var(--brown)',
                                        borderRadius: 6, padding: '4px 9px',
                                        cursor: truckBusy || fixAllRunning ? 'wait' : 'pointer',
                                        whiteSpace: 'nowrap', opacity: truckBusy || fixAllRunning ? 0.6 : 1,
                                        flexShrink: 0,
                                      }}
                                    >
                                      {truckBusy ? '…' : '↻ Fix'}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>

                        {fleetScanState === 'done' && (
                          <div
                            className={'btn btn-brown' + (fleetTruckBusy.size > 0 ? ' disabled' : '')}
                            style={{ height: 44, fontSize: 12, opacity: fleetTruckBusy.size > 0 ? 0.6 : 1 }}
                            onClick={() => fleetTruckBusy.size === 0 && runFleetFix()}
                          >
                            ↻ Fix all {fleetCandidates.length} photo{fleetCandidates.length === 1 ? '' : 's'} ({fleetByTruck.length} truck{fleetByTruck.length === 1 ? '' : 's'})
                          </div>
                        )}

                        {fleetScanState === 'fixing' && (
                          <div style={{ marginTop: 2 }}>
                            <div style={{ fontSize: 10.5, color: 'var(--brown)', marginBottom: 5 }}>
                              Fixing {fleetFixProgress.done} / {fleetFixProgress.total}
                              {fleetFixProgress.currentQuoteId ? ` — ${fleetFixProgress.currentQuoteId}` : ''}…
                            </div>
                            <div style={{ height: 6, borderRadius: 3, background: 'var(--border)', overflow: 'hidden' }}>
                              <div style={{ height: '100%', borderRadius: 3, background: 'var(--brown)', width: `${Math.round((fleetFixProgress.done / fleetFixProgress.total) * 100)}%`, transition: 'width 0.3s' }} />
                            </div>
                          </div>
                        )}

                        {fleetScanState === 'fixed' && (
                          <div style={{ fontSize: 10.5, color: 'var(--green)', fontWeight: 600 }}>
                            Done — {fleetCandidates.length} photo{fleetCandidates.length === 1 ? '' : 's'} corrected across {fleetByTruck.length} truck{fleetByTruck.length === 1 ? '' : 's'} ✓
                          </div>
                        )}
                      </>
                    )}

                    {fleetScanState === 'done' && fleetCandidates.length === 0 && (
                      <div style={{ fontSize: 10.5, color: 'var(--green)', fontWeight: 600 }}>All photos are already upright ✓</div>
                    )}
                  </div>
                )}

                {fleetScanState === 'error' && (
                  <>
                    <div style={{ marginTop: 8, fontSize: 10.5, color: 'var(--red, #c0392b)' }}>{fleetError}</div>
                    {fleetResumable && fleetScanned > 0 && (
                      <div style={{ marginTop: 4, fontSize: 9.5, color: 'var(--muted)' }}>
                        Progress saved — {fleetScanned} photo{fleetScanned === 1 ? '' : 's'} already checked{fleetCandidates.length > 0 ? `, ${fleetCandidates.length} sideways found` : ''}.
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 7, marginTop: 8 }}>
                      {fleetResumable && (
                        <div
                          className="btn btn-brown"
                          style={{ flex: 1, height: 36, fontSize: 11 }}
                          onClick={() => runFleetScan(loadFleetProgress())}
                        >
                          ↩ Resume scan
                        </div>
                      )}
                      <div
                        className="btn btn-outline"
                        style={{ flex: 1, height: 36, fontSize: 11 }}
                        onClick={() => { clearFleetProgress(); setFleetScanned(0); setFleetCandidates([]); runFleetScan(null); }}
                      >
                        ↺ Restart from beginning
                      </div>
                    </div>
                  </>
                )}

                {fleetError && fleetScanState !== 'error' && (
                  <div style={{ marginTop: 8, fontSize: 10.5, color: 'var(--red, #c0392b)' }}>{fleetError}</div>
                )}
              </>
            )}
          </div>
        )}

        {isAdmin && (
          <div className="card">
            <div className="card-title">REPAIR MIGRATED RE-CHECKS</div>
            <div style={{ fontSize: 9, color: 'var(--muted)', marginTop: 7, lineHeight: 1.5 }}>
              Re-checks brought over from the old app are missing their open-items list, so they can’t be completed. This rebuilds the list from the saved checklist; migrated trucks with no failed items are marked cleared. Safe to run more than once.
            </div>
            <div
              className={'btn btn-brown' + (repairBusy ? ' disabled' : '')}
              style={{ marginTop: 9, height: 44, fontSize: 12, opacity: repairBusy ? 0.6 : 1 }}
              onClick={runRepair}
            >
              {repairBusy ? 'Repairing…' : '🔧 Repair migrated re-checks'}
            </div>
          </div>
        )}

        {isAdmin && (
          <div className="card">
            <div className="card-title">ARCHIVE IMPORTED (OLD APP) UNITS</div>
            <div style={{ fontSize: 9, color: 'var(--muted)', marginTop: 7, lineHeight: 1.5 }}>
              Marks every unit imported from the old app as archived. Archived units stay fully viewable in Records, but no longer count in any dashboard or report number (including the Blocked list). Safe to run more than once; individual units can be unarchived from their record page.
            </div>
            <div
              className={'btn btn-brown' + (archiveBusy ? ' disabled' : '')}
              style={{ marginTop: 9, height: 44, fontSize: 12, opacity: archiveBusy ? 0.6 : 1 }}
              onClick={runArchiveImported}
            >
              {archiveBusy ? 'Archiving…' : '🗄 Archive imported units'}
            </div>
          </div>
        )}

        {isAdmin && (
          <div className="card">
            <div className="card-title">QUOTE PRICING ACCURACY (DATA COLLECTION)</div>
            <div style={{ fontSize: 9, color: 'var(--muted)', marginTop: 7, lineHeight: 1.5 }}>
              Every PIN-committed quote is snapshotted, and lines where the estimator changed the calculated hours are logged. Read-only — nothing here changes pricing.
            </div>
            {accReport && (
              <div style={{ marginTop: 9, fontSize: 10.5, color: 'var(--brown)', lineHeight: 1.6 }}>
                <div>Committed quotes: <b>{accReport.committedQuotes}</b> · Billable lines: <b>{accReport.billableLines}</b></div>
                <div>Overridden lines: <b>{accReport.overriddenLines}</b> ({accReport.overrideRate}%)</div>
                <div>Calculated total: <b>${accReport.calcUsdTotal.toLocaleString()}</b> · Approved total: <b>${accReport.finalUsdTotal.toLocaleString()}</b></div>
                {(accReport.byPanel || []).length > 0 && (
                  <div style={{ marginTop: 6 }}>
                    <div style={{ fontSize: 9, color: 'var(--muted)' }}>MOST-CORRECTED PANELS</div>
                    {accReport.byPanel.slice(0, 6).map((p) => (
                      <div key={p.panel}>
                        {String(p.panel).replace(/_/g, ' ')}: {p.n}× · body {Number(p.avg_calc_b).toFixed(1)}h → {Number(p.avg_final_b).toFixed(1)}h · avg {p.avg_usd_delta >= 0 ? '+' : '−'}${Math.abs(Math.round(p.avg_usd_delta))}
                      </div>
                    ))}
                  </div>
                )}
                {(accReport.bySeverity || []).length > 0 && (
                  <div style={{ marginTop: 6 }}>
                    <div style={{ fontSize: 9, color: 'var(--muted)' }}>BY SEVERITY</div>
                    {accReport.bySeverity.map((s) => (
                      <div key={s.severity}>
                        {s.severity}: {s.n}× · body {Number(s.avg_calc_b).toFixed(1)}h → {Number(s.avg_final_b).toFixed(1)}h · avg {s.avg_usd_delta >= 0 ? '+' : '−'}${Math.abs(Math.round(s.avg_usd_delta))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div
              className={'btn btn-brown' + (accBusy ? ' disabled' : '')}
              style={{ marginTop: 9, height: 44, fontSize: 12, opacity: accBusy ? 0.6 : 1 }}
              onClick={loadAccuracy}
            >
              {accBusy ? 'Loading…' : accReport ? '↻ Refresh accuracy report' : '📊 Load accuracy report'}
            </div>
          </div>
        )}

        {legacyPresent && (
          <div className="card" style={{ border: '1.5px solid var(--amber)' }}>
            <div className="card-title" style={{ color: 'var(--amber)' }}>ONE-TIME IMPORT — DATA FOUND ON THIS DEVICE</div>
            <div style={{ fontSize: 10.5, color: 'var(--brown)', marginTop: 7, lineHeight: 1.5 }}>
              Inspections from the old on-device version were found in this browser. Import them once into the shared database — duplicates are skipped and nothing on this device is deleted.
            </div>
            <div className={'btn btn-brown' + (importing ? ' disabled' : '')} style={{ height: 48, fontSize: 12, marginTop: 9 }} onClick={() => !importing && onImportLegacy()}>
              {importing ? 'Importing…' : '⬆ Import this device’s inspections'}
            </div>
          </div>
        )}

        <div className="card">
          <div className="card-title">DATA &amp; BACKUP</div>
          <div style={{ fontSize: 10.5, color: 'var(--brown)', marginTop: 7, lineHeight: 1.5 }}>{backupMeta}</div>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: backupStale ? 'var(--amber)' : 'var(--muted)', marginTop: 5, lineHeight: 1.5 }}>
            {backupStale ? '● ' : ''}{backupStatusLabel}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 9, flexWrap: 'wrap' }}>
            <div className="btn btn-brown" style={{ height: 48, fontSize: 12 }} onClick={() => onExportBackup()}>⬇ Export backup</div>
            {isAdmin && (
              <div
                className="btn btn-outline-brown"
                style={{ height: 48, fontSize: 12 }}
                title="Includes every Quoter photo — several hundred MB"
                onClick={() => onExportBackup({ full: true })}
              >
                ⬇ Full export (photos)
              </div>
            )}
            <div
              className={'btn btn-outline-brown' + (importing ? ' disabled' : '')}
              style={{ height: 48, fontSize: 12 }}
              onClick={() => {
                if (importing) return;
                if (importRef.current) {
                  importRef.current.value = '';
                  importRef.current.click();
                }
              }}
            >
              ⬆ Import backup
            </div>
          </div>
          <div style={{ fontSize: 9, color: 'var(--muted)', marginTop: 7, lineHeight: 1.5 }}>
            All inspections now live in the shared Truck Ranch database — every approved employee sees the same records. Export a JSON backup any time; importing a backup adds missing records and never overwrites existing ones.
          </div>
          <input
            ref={importRef}
            type="file"
            accept=".json,application/json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files && e.target.files[0];
              if (f) onImportFile(f);
            }}
          />
        </div>

        <div style={{ textAlign: 'center', fontSize: 9, color: 'var(--muted)', padding: '4px 0 8px' }}>
          <span style={{ fontFamily: 'Rye, serif', color: 'var(--brown)', fontSize: 10 }}>TRUCK RANCH</span> &nbsp;·&nbsp; Intake &amp; QC · shared team database
        </div>
      </div>
    </div>
  );
}
