import { useMemo } from 'react';
import { CATS, chipStyle } from '../lib/constants';
import { initials } from '../lib/format';
import { curPeriod, computeStats, periodDefs } from '../lib/stats';

export default function ReportsScreen({ recs, period, onPeriod, onExportCsv, onExportPdf }) {
  const defs = useMemo(() => periodDefs(recs), [recs]);
  const p = useMemo(() => curPeriod(recs, period), [recs, period]);
  const st = useMemo(() => computeStats(recs, p), [recs, p]);

  const rTiles = [
    { label: 'INSPECTIONS', value: String(st.total), accent: 'var(--brown)' },
    { label: 'FIRST-PASS', value: String(st.pass), accent: 'var(--green)' },
    { label: 'FAIL', value: String(st.fail), accent: 'var(--red)' },
    { label: 'FINAL QC RATE', value: st.rate == null ? '—' : st.rate + '%', accent: st.rate == null ? 'var(--muted)' : st.rate >= 90 ? 'var(--green)' : st.rate >= 75 ? 'var(--amber)' : 'var(--red)' },
  ];
  const rcTiles = [
    { label: 'OPEN RE-CHECKS', value: String(st.openNow), accent: st.openNow ? 'var(--amber)' : 'var(--muted)' },
    { label: 'CLEARED IN PERIOD', value: String(st.cleared), accent: st.cleared ? 'var(--green)' : 'var(--muted)' },
    { label: 'AVG FAIL → CLEARED', value: st.avgClear == null ? '—' : st.avgClear + 'd', accent: 'var(--gold)' },
  ];
  const maxCat = Math.max(1, ...CATS.map((c) => st.catFails[c.k] || 0));
  const catRows = CATS.map((c) => {
    const n = st.catFails[c.k] || 0;
    return { c, count: n, w: (n ? Math.max(5, Math.round((n / maxCat) * 100)) : 0) + '%', barColor: n ? 'var(--red)' : 'var(--panel2)' };
  });
  const topFails = st.top;
  const inspRows = st.insp.map((r) => ({ ...r, pct: r.total ? Math.round(((r.total - r.fails) / r.total) * 100) : 0 }));

  return (
    <div className="screen">
      <div className="screen-topbar" style={{ padding: '8px 14px 10px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 9 }}>
          <span className="screen-title">Reports</span>
          <span className="mono" style={{ fontSize: 9.5, color: 'var(--muted)' }}>{p.rangeLabel}</span>
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 9, overflowX: 'auto', paddingBottom: 4 }}>
          {defs.map((pd) => (
            <span key={pd.k} className={'pill-btn' + (pd.k === p.k ? ' on red' : '')} onClick={() => onPeriod(pd.k)}>
              {pd.label}
            </span>
          ))}
        </div>
      </div>
      <div className="screen-body" style={{ gap: 9 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 7 }}>
          {rTiles.map((t) => (
            <div key={t.label} style={{ background: '#fff', border: '1px solid var(--border)', borderLeft: `3px solid ${t.accent}`, borderRadius: 10, padding: '8px 9px' }}>
              <div style={{ fontSize: 7.5, fontWeight: 700, letterSpacing: 0.5, color: 'var(--muted)' }}>{t.label}</div>
              <div className="oswald" style={{ fontWeight: 600, fontSize: 18, marginTop: 2, color: t.accent }}>{t.value}</div>
            </div>
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 7 }}>
          {rcTiles.map((t) => (
            <div key={t.label} style={{ background: '#fff', border: '1px solid var(--border)', borderLeft: `3px solid ${t.accent}`, borderRadius: 10, padding: '8px 9px' }}>
              <div style={{ fontSize: 7.5, fontWeight: 700, letterSpacing: 0.5, color: 'var(--muted)' }}>{t.label}</div>
              <div className="oswald" style={{ fontWeight: 600, fontSize: 16, marginTop: 2, color: t.accent }}>{t.value}</div>
            </div>
          ))}
        </div>

        {st.total > 0 ? (
          <>
            <div className="card">
              <div className="card-title" style={{ marginBottom: 8 }}>FAILS BY TYPE — FAILED ITEMS (FIRST INSPECTION)</div>
              {catRows.map(({ c, count, w, barColor }) => (
                <div key={c.k} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0' }}>
                  <span style={chipStyle(c.k)}>{c.seg}</span>
                  <span style={{ fontSize: 11.5, fontWeight: 600, flex: '0 0 108px' }}>{c.label}</span>
                  <div style={{ flex: 1, height: 8, background: 'var(--panel2)', borderRadius: 4, overflow: 'hidden' }}>
                    <div style={{ width: w, height: '100%', background: barColor, borderRadius: 4 }} />
                  </div>
                  <span className="mono" style={{ fontSize: 11, minWidth: 20, textAlign: 'right' }}>{count}</span>
                </div>
              ))}
            </div>
            {topFails.length > 0 && (
              <div className="card">
                <div className="card-title" style={{ marginBottom: 6 }}>MOST-FAILED ITEMS</div>
                {topFails.map((tf, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderTop: '1px solid #F5F1EC' }}>
                    <span style={chipStyle(tf.k)}>{tf.seg}</span>
                    <span style={{ fontSize: 12, fontWeight: 600, flex: 1 }}>{tf.item}</span>
                    <span className="count-pill">{tf.count}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="card">
              <div className="card-title" style={{ marginBottom: 6 }}>BY INSPECTOR</div>
              {inspRows.map((ir, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 0', borderTop: '1px solid #F5F1EC' }}>
                  <span style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--brown)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Oswald, sans-serif', fontSize: 10, fontWeight: 600, flex: '0 0 auto' }}>
                    {initials(ir.name)}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 700 }}>{ir.name}</div>
                    <div style={{ fontSize: 9.5, color: 'var(--muted)' }}>{ir.title}</div>
                  </div>
                  <span className="mono" style={{ fontSize: 11 }}>{ir.total} insp · {ir.pct}% first-pass</span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="empty-note">No inspections in this period yet.</div>
        )}

        <div className="card">
          <div className="card-title">EXPORT THIS PERIOD</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 9 }}>
            <div className="btn btn-green" style={{ height: 48, fontSize: 12.5 }} onClick={onExportCsv}>⬇ Excel (CSV)</div>
            <div className="btn btn-dark" style={{ height: 48, fontSize: 12.5 }} onClick={onExportPdf}>⬇ PDF Report</div>
          </div>
          <div style={{ fontSize: 9, color: 'var(--muted)', marginTop: 7, lineHeight: 1.5 }}>
            CSV opens directly in Excel with a summary block + one row per inspection (status + re-check dates included). PDF opens a print-ready report — use your browser&rsquo;s Print → Save as PDF.
          </div>
        </div>
      </div>
    </div>
  );
}
