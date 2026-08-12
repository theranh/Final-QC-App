import { useState } from 'react';
import { chipStyle, catByKey } from '../lib/constants';
import { fmtDT, fmtShort } from '../lib/format';
import { statusMeta } from '../lib/records';

const matches = (r, needle) => `${r.stock} ${r.vehicle} ${r.vin || ''} ${r.inspector || ''} ${r.id}`.toLowerCase().includes(needle);

export default function HomeScreen({ recs, openRecs, onNewInspection, onOpenRecheck, onOpenRecord, onGoRecords }) {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  // With a search active, look through ALL records (done or awaiting
  // re-check), not just the recent-history slice.
  const shownOpen = needle ? openRecs.filter((r) => matches(r, needle)) : openRecs;
  const historyRows = needle ? recs.filter((r) => matches(r, needle)).slice(0, 25) : recs.slice(0, 10);

  return (
    <div className="screen">
      <div className="screen-topbar">
        <div className="screen-title-row">
          <span className="screen-title">Final QC</span>
          {openRecs.length > 0 && <span className="count-pill amber">{openRecs.length}</span>}
        </div>
        <input
          className="input"
          style={{ marginTop: 8 }}
          placeholder="Search stock #, VIN, or FQ number…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div className="screen-body">
        <div className="btn btn-red" style={{ flex: '0 0 auto', height: 56 }} onClick={onNewInspection}>
          + New Inspection
        </div>

        {needle && shownOpen.length === 0 && historyRows.length === 0 && (
          <div className="empty-note">No QC records match “{q.trim()}”.</div>
        )}

        {shownOpen.length > 0 && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 2px 0' }}>
              <span className="oswald" style={{ fontWeight: 600, fontSize: 15 }}>Re-checks</span>
              <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--amber)' }}>OPEN — AWAITING RE-CHECK</span>
            </div>
            {shownOpen.map((r) => {
              const cats = [...new Set((r.openItems || []).map((x) => x.cat))];
              return (
                <div key={r.id} style={{ background: '#fff', border: '1px solid var(--border)', borderLeft: '4px solid var(--amber)', borderRadius: 11, padding: '11px 12px' }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        <span className="mono" style={{ fontSize: 10, fontWeight: 600 }}>{r.id}</span>
                        <span className="oswald" style={{ fontWeight: 600, fontSize: 14 }}>{r.stock} · {r.vehicle}</span>
                      </div>
                      <div style={{ display: 'flex', gap: 4, marginTop: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                        {cats.map((k) => (
                          <span key={k} style={chipStyle(k)}>{catByKey(k).seg}</span>
                        ))}
                        <span style={{ fontSize: 9, color: 'var(--muted)', fontWeight: 600 }}>
                          {(r.openItems || []).length} item{(r.openItems || []).length === 1 ? '' : 's'} · failed {fmtShort(r.ts)}
                        </span>
                      </div>
                    </div>
                    <div className="btn-brown" style={{ fontWeight: 700, fontSize: 12, borderRadius: 9, padding: '13px 15px', cursor: 'pointer', flex: '0 0 auto' }} onClick={() => onOpenRecheck(r.id)}>
                      Re-check
                    </div>
                  </div>
                </div>
              );
            })}
          </>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 2px 0' }}>
          <span className="oswald" style={{ fontWeight: 600, fontSize: 15 }}>History</span>
          <span style={{ flex: 1 }} />
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--red)', cursor: 'pointer', padding: '6px 2px' }} onClick={onGoRecords}>
            All records ›
          </div>
        </div>
        {historyRows.map((r) => {
          const sm = statusMeta(r);
          return (
            <div key={r.id} style={{ background: '#fff', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px', cursor: 'pointer' }} onClick={() => onOpenRecord(r.id)}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <span className="mono" style={{ fontSize: 10.5, fontWeight: 600 }}>{r.id}</span>
                <span style={{ fontSize: 8.5, fontWeight: 700, color: '#fff', background: sm.bg, padding: '2px 7px', borderRadius: 4 }}>{sm.label}</span>
                <span style={{ flex: 1 }} />
                <span className="mono" style={{ fontSize: 9, color: 'var(--muted)' }}>{fmtDT(r.ts)}</span>
              </div>
              <div style={{ fontSize: 12, fontWeight: 600, marginTop: 4 }}>{r.stock} · {r.vehicle}</div>
              <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>
                {r.inspector} — {r.title}
                {r.failCount
                  ? ` · ${r.failCount} fail${r.failCount === 1 ? '' : 's'}${r.status === 'cleared' ? ' · cleared ' + fmtShort(r.clearedTs) : ''}`
                  : ' · clean pass'}
              </div>
            </div>
          );
        })}
        {recs.length === 0 && <div className="empty-note">No inspections yet — start your first Final QC above.</div>}
      </div>
    </div>
  );
}
