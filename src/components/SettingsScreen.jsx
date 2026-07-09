import { useRef } from 'react';
import { CATS } from '../lib/constants';
import { initials, fmtDT } from '../lib/format';

export default function SettingsScreen({
  users, defaultUid, onMakeDefault,
  editUser, uName, uTitle, uEmail, onUName, onUTitle, onUEmail,
  onAddUser, onEditUser, onSaveUser, onCancelUser, onDeleteUser,
  lastBackupAt, recs, seq, onExportBackup, onImportFile,
}) {
  const importRef = useRef(null);
  const canSaveUser = !!(uName.trim() && uTitle.trim());

  const photoCount = recs.reduce((a, r) => {
    let n = 0;
    CATS.forEach((c) => (r.items[c.k] || []).forEach((it) => { n += (it.photos || []).length; }));
    (r.rechecks || []).forEach((cy) => cy.items.forEach((it) => { n += (it.photos || []).length; }));
    return a + n;
  }, 0);

  const backupMeta = `${recs.length} inspection${recs.length === 1 ? '' : 's'} · ${photoCount} photo${photoCount === 1 ? '' : 's'} · ${users.length} inspector${users.length === 1 ? '' : 's'} · next ID FQ-${seq}`;

  const daysSinceBackup = lastBackupAt ? Math.floor((Date.now() - lastBackupAt) / 86400000) : null;
  const backupStale = daysSinceBackup == null || daysSinceBackup >= 7;
  const backupStatusLabel =
    daysSinceBackup == null
      ? 'Never backed up on this device — export one now.'
      : daysSinceBackup === 0
      ? `Last backup: today (${fmtDT(lastBackupAt)}).`
      : `Last backup: ${daysSinceBackup} day${daysSinceBackup === 1 ? '' : 's'} ago (${fmtDT(lastBackupAt)}).`;

  return (
    <div className="screen">
      <div className="screen-topbar" style={{ padding: '8px 16px 12px' }}>
        <span className="screen-title">Settings</span>
      </div>
      <div className="screen-body" style={{ gap: 9 }}>
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <div className="card-title" style={{ flex: 1 }}>INSPECTORS</div>
            <div style={{ background: 'var(--red)', color: '#fff', fontSize: 11, fontWeight: 700, borderRadius: 8, padding: '9px 13px', cursor: 'pointer' }} onClick={onAddUser}>+ Add inspector</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', marginTop: 6 }}>
            {users.map((u) => {
              const isDefault = u.id === defaultUid;
              return (
                <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 0', borderTop: '1px solid #F5F1EC' }}>
                  <span style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--brown)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Oswald, sans-serif', fontSize: 11, fontWeight: 600, flex: '0 0 auto' }}>
                    {initials(u.name)}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 13, fontWeight: 700 }}>{u.name}</span>
                      {isDefault && <span style={{ fontSize: 8, fontWeight: 700, color: '#fff', background: 'var(--green)', padding: '2px 6px', borderRadius: 4 }}>DEFAULT</span>}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 1 }}>{u.title}{u.email ? ' · ' + u.email : ''}</div>
                  </div>
                  {!isDefault && <div style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--green)', cursor: 'pointer', padding: '8px 4px' }} onClick={() => onMakeDefault(u.id)}>Set default</div>}
                  <div style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--brown)', cursor: 'pointer', border: '1px solid var(--border)', borderRadius: 7, padding: '8px 11px', background: 'var(--panel)' }} onClick={() => onEditUser(u)}>Edit</div>
                </div>
              );
            })}
          </div>
          {editUser != null && (
            <div style={{ marginTop: 10, border: '1.5px solid var(--brown)', borderRadius: 10, padding: 11, background: '#FDFCFB', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 0.8, color: 'var(--brown)' }}>{editUser === 'new' ? 'ADD INSPECTOR' : 'EDIT INSPECTOR'}</div>
              <input className="input" style={{ background: '#fff', height: 44 }} value={uName} onChange={(e) => onUName(e.target.value)} placeholder="Name (e.g. R. Delgado)" />
              <input className="input" style={{ background: '#fff', height: 44, fontWeight: 400 }} value={uTitle} onChange={(e) => onUTitle(e.target.value)} placeholder="Position title (e.g. VRA)" />
              <input className="input" style={{ background: '#fff', height: 44, fontWeight: 400 }} type="email" value={uEmail} onChange={(e) => onUEmail(e.target.value)} placeholder="Company email" />
              <div style={{ display: 'flex', gap: 7 }}>
                <div className="btn btn-outline" style={{ flex: '0 0 auto', width: 'auto', height: 44, padding: '0 14px', fontSize: 11.5 }} onClick={onCancelUser}>Cancel</div>
                {editUser !== 'new' && (
                  <div className="btn btn-outline-red" style={{ flex: '0 0 auto', width: 'auto', height: 44, padding: '0 14px', fontSize: 11.5 }} onClick={onDeleteUser}>Delete</div>
                )}
                <div className={'btn' + (canSaveUser ? ' btn-green' : ' disabled')} style={{ flex: 1, height: 44, fontSize: 12 }} onClick={() => canSaveUser && onSaveUser()}>
                  {canSaveUser ? 'Save' : 'Name + title required'}
                </div>
              </div>
            </div>
          )}
          <div style={{ fontSize: 9, color: 'var(--muted)', marginTop: 9, lineHeight: 1.5 }}>No passwords — the inspector picked on each inspection is recorded with their name and title.</div>
        </div>

        <div className="card">
          <div className="card-title">DATA &amp; BACKUP</div>
          <div style={{ fontSize: 10.5, color: 'var(--brown)', marginTop: 7, lineHeight: 1.5 }}>{backupMeta}</div>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: backupStale ? 'var(--amber)' : 'var(--muted)', marginTop: 5, lineHeight: 1.5 }}>
            {backupStale ? '● ' : ''}{backupStatusLabel}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 9 }}>
            <div className="btn btn-brown" style={{ height: 48, fontSize: 12 }} onClick={onExportBackup}>⬇ Export backup</div>
            <div
              className="btn btn-outline-brown"
              style={{ height: 48, fontSize: 12 }}
              onClick={() => {
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
            Everything (inspections, re-checks, photos, users, ID counter) lives on this device. Export the JSON backup to move data to another phone, then Import it there. Import replaces this device&rsquo;s data.
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
          <span style={{ fontFamily: 'Rye, serif', color: 'var(--brown)', fontSize: 10 }}>TRUCK RANCH</span> &nbsp;·&nbsp; Final QC · FRPS · works offline after first load
        </div>
      </div>
    </div>
  );
}
