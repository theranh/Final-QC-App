import { useMemo } from 'react';
import { CATS } from '../lib/constants';
import { fmtDT } from '../lib/format';
import { failList, statusMeta, recheckDatesLabel } from '../lib/records';
import { curPeriod, computeStats } from '../lib/stats';

export default function PrintReport({ recs, period, onClose, onPrint }) {
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
  const prRows = p.recs
    .slice()
    .sort((a, b) => a.ts - b.ts)
    .map((r) => {
      const fl = failList(r, CATS);
      const sm = statusMeta(r);
      return {
        r, fl, sm,
        recheckDates: (r.rechecks || []).length ? recheckDatesLabel(r, fmtDT) : '—',
      };
    });

  return (
    <div data-screen-label="PDF Report" style={{ minHeight: '100vh', background: '#fff' }}>
      <div className="noprint" style={{ position: 'sticky', top: 0, background: 'var(--ink)', color: '#fff', padding: '12px 18px', display: 'flex', gap: 12, alignItems: 'center', zIndex: 5 }}>
        <div style={{ border: '1px solid rgba(255,255,255,0.35)', borderRadius: 8, padding: '9px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }} onClick={onClose}>‹ Back to app</div>
        <span style={{ flex: 1, fontSize: 11, color: '#C9C1B8' }}>Print-ready — use Print → Save as PDF</span>
        <div style={{ background: 'var(--red)', borderRadius: 8, padding: '9px 16px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }} onClick={onPrint}>Print / Save PDF</div>
      </div>
      <div style={{ maxWidth: 840, margin: '0 auto', padding: '36px 40px 50px', color: 'var(--ink)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, borderBottom: '3px solid var(--red)', paddingBottom: 14 }}>
          <span style={{ width: 40, height: 40, borderRadius: 9, background: 'var(--brown)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Oswald, sans-serif', fontWeight: 700, fontSize: 16 }}>TR</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: 'Rye, serif', fontSize: 13, color: 'var(--brown)' }}>TRUCK RANCH</div>
            <div className="oswald" style={{ fontWeight: 700, fontSize: 22, letterSpacing: 1 }}>FINAL QC REPORT</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="oswald" style={{ fontWeight: 600, fontSize: 15 }}>{p.label}</div>
            <div className="mono" style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>{p.rangeLabel}</div>
            <div className="mono" style={{ fontSize: 9, color: 'var(--muted)', marginTop: 2 }}>generated {fmtDT(Date.now())}</div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10, marginTop: 18 }}>
          {rTiles.map((t) => (
            <div key={t.label} style={{ border: '1px solid var(--border)', borderLeft: `4px solid ${t.accent}`, borderRadius: 8, padding: '10px 12px' }}>
              <div style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: 0.6, color: 'var(--muted)' }}>{t.label}</div>
              <div className="oswald" style={{ fontWeight: 600, fontSize: 24, marginTop: 2, color: t.accent }}>{t.value}</div>
            </div>
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10, marginTop: 10 }}>
          {rcTiles.map((t) => (
            <div key={t.label} style={{ border: '1px solid var(--border)', borderLeft: `4px solid ${t.accent}`, borderRadius: 8, padding: '10px 12px' }}>
              <div style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: 0.6, color: 'var(--muted)' }}>{t.label}</div>
              <div className="oswald" style={{ fontWeight: 600, fontSize: 19, marginTop: 2, color: t.accent }}>{t.value}</div>
            </div>
          ))}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 16 }}>
          <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px' }}>
            <div className="card-title" style={{ marginBottom: 8 }}>FAILS BY TYPE</div>
            {catRows.map(({ c, count, w, barColor }) => (
              <div key={c.k} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                <span style={{ fontSize: 11, fontWeight: 600, flex: '0 0 118px' }}>{c.label}</span>
                <div style={{ flex: 1, height: 8, background: 'var(--panel2)', borderRadius: 4, overflow: 'hidden' }}>
                  <div style={{ width: w, height: '100%', background: barColor, borderRadius: 4 }} />
                </div>
                <span className="mono" style={{ fontSize: 11, minWidth: 18, textAlign: 'right' }}>{count}</span>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px' }}>
              <div className="card-title" style={{ marginBottom: 6 }}>MOST-FAILED ITEMS</div>
              {st.top.map((tf, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', fontSize: 11 }}>
                  <span style={{ fontWeight: 700, color: 'var(--muted)', flex: '0 0 42px' }}>{tf.seg}</span>
                  <span style={{ fontWeight: 600, flex: 1 }}>{tf.item}</span>
                  <span className="mono">{tf.count}</span>
                </div>
              ))}
              {st.top.length === 0 && <div style={{ fontSize: 11, color: 'var(--muted)', fontStyle: 'italic' }}>No failed items in this period.</div>}
            </div>
            <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px' }}>
              <div className="card-title" style={{ marginBottom: 6 }}>BY INSPECTOR</div>
              {st.insp.map((ir, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', fontSize: 11 }}>
                  <span style={{ fontWeight: 700, flex: 1 }}>{ir.name} — {ir.title}</span>
                  <span className="mono">{ir.total} insp · {ir.total ? Math.round(((ir.total - ir.fails) / ir.total) * 100) : 0}% first-pass</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div style={{ marginTop: 18, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
          <div style={{ padding: '9px 12px', background: 'var(--panel)', borderBottom: '1px solid var(--border)', fontSize: 9.5, fontWeight: 700, letterSpacing: 0.8, color: 'var(--muted)' }}>
            INSPECTIONS — {prRows.length} RECORD{prRows.length === 1 ? '' : 'S'}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '52px 62px 116px 52px 1fr 88px 100px 72px', gap: 6, padding: '7px 12px', borderBottom: '1px solid var(--border)', fontSize: 8.5, fontWeight: 700, letterSpacing: 0.4, color: 'var(--muted)' }}>
            <span>ID</span><span>DATE</span><span>VIN</span><span>STOCK</span><span>VEHICLE</span><span>INSPECTOR</span><span>STATUS</span><span>RE-CHECKS</span>
          </div>
          {prRows.map(({ r, fl, sm, recheckDates }) => (
            <div key={r.id} style={{ borderBottom: '1px solid #F0EBE5', padding: '7px 12px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '52px 62px 116px 52px 1fr 88px 100px 72px', gap: 6, fontSize: 10, alignItems: 'center' }}>
                <span className="mono">{r.id}</span>
                <span className="mono">{fmtDT(r.ts)}</span>
                <span className="mono" style={{ fontSize: 8.5, wordBreak: 'break-all' }}>{r.vin || '—'}</span>
                <span style={{ fontWeight: 700 }}>{r.stock}</span>
                <span>{r.vehicle}</span>
                <span>{r.inspector}</span>
                <span style={{ fontWeight: 700, color: r.status === 'open' ? 'var(--amber)' : 'var(--green)' }}>{sm.txt}</span>
                <span className="mono" style={{ fontSize: 9 }}>{recheckDates}</span>
              </div>
              {fl.length > 0 && (
                <div style={{ fontSize: 9.5, color: '#9E3B2E', marginTop: 3, lineHeight: 1.5 }}>
                  Failed: {fl.map((f) => `${f.catLabel} — ${f.item}${f.note ? ' (' + f.note + ')' : ''}`).join('; ')}
                </div>
              )}
            </div>
          ))}
          {prRows.length === 0 && <div style={{ padding: 20, textAlign: 'center', fontSize: 11, color: 'var(--muted)', fontStyle: 'italic' }}>No inspections in this period.</div>}
        </div>
        <div style={{ marginTop: 14 }} className="mono">
          <span style={{ fontSize: 9, color: 'var(--muted)' }}>
            Truck Ranch — Intake &amp; QC · Final QC Rate is first-pass: passed on first inspection ÷ total first inspections. Committed inspections and re-checks are signature-locked.
          </span>
        </div>
      </div>
    </div>
  );
}
