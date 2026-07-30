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
  const [adding, setAdding] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [importing, setImporting] = useState(false);
  const [legacyPresent, setLegacyPresent] = useState(() => hasLegacyData() && !legacyImportDone());

  const isAdmin = !!me.isAdmin;

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

  const runImport = (payload, source) => {
    setImporting(true);
    api
      .importLegacy(payload)
      .then((r) => {
        showToast(`Imported ${r.imported} inspection${r.imported === 1 ? '' : 's'}${r.skipped ? ` · ${r.skipped} duplicate${r.skipped === 1 ? '' : 's'} skipped` : ''} ✓`);
        if (source === 'legacy') {
          markLegacyImported();
          setLegacyPresent(false);
        }
        onImported();
      })
      .catch((err) => showToast('Import failed: ' + err.message))
      .finally(() => setImporting(false));
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
        if (!window.confirm(`Import ${data.inspections.length} inspection${data.inspections.length === 1 ? '' : 's'} from this backup into the shared database?\nRecords already in the database are skipped — nothing is overwritten.`)) return;
        runImport({ inspections: data.inspections, seq: data.seq }, 'file');
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
                  <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 0', borderTop: '1px solid #F5F1EC' }}>
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
          <div style={{ display: 'flex', gap: 8, marginTop: 9 }}>
            <div className="btn btn-brown" style={{ height: 48, fontSize: 12 }} onClick={onExportBackup}>⬇ Export backup</div>
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
