import { fmtDT } from '../lib/format';
import { filterRecords, statusMeta } from '../lib/records';

const RES_CHIPS = [
  ['all', 'All'],
  ['pass', 'Pass'],
  ['fail', 'Fail / open'],
];

export default function RecordsList({ recs, q, onQ, fRes, onFRes, fFrom, onFFrom, fTo, onFTo, onOpenRecord }) {
  const filtered = filterRecords(recs, { q, fRes, fFrom, fTo });

  return (
    <div className="screen">
      <div className="screen-topbar" style={{ padding: '8px 14px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 9 }}>
          <span className="screen-title">Records</span>
          <span className="count-pill">{filtered.length}</span>
        </div>
        <input className="input" value={q} onChange={(e) => onQ(e.target.value)} placeholder="Search stock #, vehicle, VIN, inspector…" style={{ height: 44, fontSize: 12.5, marginTop: 9 }} />
        <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center' }}>
          {RES_CHIPS.map(([k, label]) => {
            const on = fRes === k;
            const cls = k === 'fail' ? 'amber' : k === 'pass' ? 'green' : '';
            return (
              <span key={k} className={'pill-btn' + (on ? ' on ' + cls : '')} onClick={() => onFRes(k)}>
                {label}
              </span>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--muted)', flex: '0 0 auto' }}>FROM</span>
          <input type="date" value={fFrom} onChange={(e) => onFFrom(e.target.value)} style={{ flex: 1, minWidth: 0, height: 38, border: '1px solid var(--border)', borderRadius: 8, background: '#fff', fontSize: 11, color: 'var(--brown)', padding: '0 8px', outline: 'none', boxSizing: 'border-box' }} />
          <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--muted)', flex: '0 0 auto' }}>TO</span>
          <input type="date" value={fTo} onChange={(e) => onFTo(e.target.value)} style={{ flex: 1, minWidth: 0, height: 38, border: '1px solid var(--border)', borderRadius: 8, background: '#fff', fontSize: 11, color: 'var(--brown)', padding: '0 8px', outline: 'none', boxSizing: 'border-box' }} />
        </div>
      </div>
      <div className="screen-body">
        {filtered.map((r) => {
          const sm = statusMeta(r);
          return (
            <div key={r.id} style={{ background: '#fff', border: '1px solid var(--border)', borderRadius: 10, padding: '11px 12px', cursor: 'pointer' }} onClick={() => onOpenRecord(r.id)}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <span className="mono" style={{ fontSize: 10.5, fontWeight: 600 }}>{r.id}</span>
                <span style={{ fontSize: 8.5, fontWeight: 700, color: '#fff', background: sm.bg, padding: '2px 7px', borderRadius: 4 }}>{sm.label}</span>
                <span style={{ flex: 1 }} />
                <span className="mono" style={{ fontSize: 9, color: 'var(--muted)' }}>{fmtDT(r.ts)}</span>
              </div>
              <div style={{ fontSize: 12.5, fontWeight: 600, marginTop: 4 }}>{r.stock} · {r.vehicle}</div>
              <div className="mono" style={{ fontSize: 9.5, color: 'var(--muted)', marginTop: 2 }}>VIN {r.vin || '—'}</div>
              <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>
                {r.inspector} — {r.title}
                {r.failCount ? ` · ${r.failCount} fail${r.failCount === 1 ? '' : 's'}${(r.rechecks || []).length ? ` · ${r.rechecks.length} re-check${r.rechecks.length === 1 ? '' : 's'}` : ''}` : ' · clean pass'}
              </div>
            </div>
          );
        })}
        {filtered.length === 0 && (
          <div className="empty-note">{recs.length === 0 ? 'No inspections yet — run your first Final QC from the Inspect tab.' : 'No records match these filters.'}</div>
        )}
      </div>
    </div>
  );
}
