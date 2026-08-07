import { useCallback, useEffect, useRef, useState } from 'react';
import { CATS } from '../lib/constants';
import { initials, fmtDT } from '../lib/format';
import { loadLegacyData, hasLegacyData, markLegacyImported, legacyImportDone } from '../lib/storage';
import { parseBackupFile, convertOldReconBackup } from '../lib/exports';
import { api } from '../lib/api';

const STATUS_META = {
  pending: { label: 'PENDING', bg: 'var(--amber)' },
  active: { label: 'ACTIVE', bg: 'var(--green)' },
  inactive: { label: 'DEACTIVATED', bg: 'var(--muted)' },
};

export default function SettingsScreen({ me, lastBackupAt, recs, nextQc, onExportBackup, onImported, showToast }) {
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

  const daysSinceBackup = lastBackupAt ? Math.floor((Date.now() - lastBackupAt) / 86400000) : null;
  const backupStale = daysSinceBackup == null || daysSinceBackup >= 7;
  const backupStatusLabel =
    daysSinceBackup == null
      ? 'Never backed up on this device.'
      : daysSinceBackup === 0
      ? `Last backup: today (${fmtDT(lastBackupAt)}).`
      : `Last backup: ${daysSinceBackup} day${daysSinceBackup === 1 ? '' : 's'} ago (${fmtDT(lastBackupAt)}).`;

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
          <span style={{ fontFamily: 'Rye, serif', color: 'var(--brown)', fontSize: 10 }}>TRUCK RANCH</span> &nbsp;·&nbsp; Final QC · FRPS · shared team database
        </div>
      </div>
    </div>
  );
}
