import { useMemo } from 'react';
import { CATS, chipStyle } from '../lib/constants';
import { initials } from '../lib/format';
import { curPeriod, periodDefs } from '../lib/stats';
import ManagerAnalytics from './ManagerAnalytics';

const usd = (v) => (v == null ? null : '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 }));
const unavailable = <span style={{ color: 'var(--muted)', fontStyle: 'italic' }}>unavailable</span>;
const pctFmt = (v) => (v == null ? '—' : Math.round(v * 1000) / 10 + '%');

export default function ReportsScreen({
  recs,
  period,
  onPeriod,
  onExportCsv,
  onExportPdf,
  dash,
  onOpenVehicle,
  isAdmin,
  managerData,
  managerLoading,
  managerError,
  managerFilters,
  onManagerFilters,
  onManagerRetry,
  onManagerPrint,
  onManagerShare,
}) {
  const defs = useMemo(() => periodDefs(recs), [recs]);
  const p = useMemo(() => curPeriod(recs, period), [recs, period]);

  // Every figure on this screen comes from the server's /api/dashboard payload
  // for this range — nothing is recomputed on the client.
  const kpi = dash?.kpi;
  const passRate = kpi && kpi.inspections ? Math.round((kpi.firstPass / kpi.inspections) * 1000) / 10 : null;
  const rTiles = kpi
    ? [
        { label: 'INSPECTIONS', value: String(kpi.inspections), accent: 'var(--brown)' },
        { label: 'FIRST-PASS', value: String(kpi.firstPass), accent: 'var(--green)' },
        { label: 'FAIL', value: String(kpi.failedFirst), accent: 'var(--red)' },
        { label: 'FINAL QC RATE', value: passRate == null ? '—' : passRate + '%', accent: passRate == null ? 'var(--muted)' : passRate >= 90 ? 'var(--green)' : passRate >= 75 ? 'var(--amber)' : 'var(--red)' },
      ]
    : [];
  const rcTiles = kpi
    ? [
        { label: 'OPEN RE-CHECKS', value: String(kpi.openRechecks), accent: kpi.openRechecks ? 'var(--amber)' : 'var(--muted)' },
        { label: 'CLEARED IN PERIOD', value: String(kpi.clearedInRange), accent: kpi.clearedInRange ? 'var(--green)' : 'var(--muted)' },
        { label: 'AVG FAIL → CLEARED', value: kpi.avgFailToClearDays == null ? '—' : Math.round(kpi.avgFailToClearDays * 10) / 10 + 'd', accent: 'var(--gold)' },
      ]
    : [];
  const deptBySeg = useMemo(() => {
    const m = {};
    (dash?.deptFailRate || []).forEach((d) => { m[d.segment] = d; });
    return m;
  }, [dash]);
  const maxCat = Math.max(1, ...CATS.map((c) => deptBySeg[c.k]?.failedItems || 0));
  const catRows = CATS.map((c) => {
    const n = deptBySeg[c.k]?.failedItems || 0;
    return { c, count: n, w: (n ? Math.max(5, Math.round((n / maxCat) * 100)) : 0) + '%', barColor: n ? 'var(--red)' : 'var(--panel2)' };
  });
  const topFails = (dash?.topFailedItems || []).map((t) => ({ k: t.segment, seg: (CATS.find((c) => c.k === t.segment)?.seg) || t.segment.toUpperCase(), item: t.item, count: t.count }));
  const inspRows = (dash?.byInspector || []).map((r) => ({ ...r, pct: r.firstPassPct ?? 0 }));

  return (
    <div className="screen">
      <div className="screen-topbar" style={{ padding: '8px 14px 10px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 9 }}>
          <span className="screen-title">Reports</span>
          <span className="mono" style={{ fontSize: 9.5, color: 'var(--muted)' }}>{dash?.range ? `${dash.range.from} – ${dash.range.to}` : p.rangeLabel}</span>
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
        {isAdmin && (
          <ManagerAnalytics
            data={managerData}
            loading={managerLoading}
            error={managerError}
            filters={managerFilters}
            onFilters={onManagerFilters}
            onRetry={onManagerRetry}
            onOpenVehicle={onOpenVehicle}
            onPrint={onManagerPrint}
            onShare={onManagerShare}
          />
        )}

        {/* Month summary — QC KPIs server-computed for this range; money figures
            read from the VPC Production Tracker sheet as typed, never recomputed.
            When the sheet is unreachable they show as unavailable, never $0. */}
        <div className="card">
          <div className="card-title">MONTH SUMMARY</div>
          {!dash && <div className="empty-note" style={{ padding: '8px 0 2px' }}>Loading…</div>}
          {dash && (
            <div style={{ marginTop: 4 }}>
              {[
                ['Vehicles completed', dash.monthSummary ? dash.monthSummary.completed : null],
                ['Avg days in production', dash.kpi.avgDaysInProduction == null ? null : Math.round(dash.kpi.avgDaysInProduction * 10) / 10 + 'd'],
                ['QC inspections on record', dash.kpi.inspections],
                ['Fail rate', dash.kpi.failRate == null ? '—' : pctFmt(dash.kpi.failRate)],
                ['Retail plan $', usd(dash.monthSummary?.retailPlan)],
                ['Closed RO $', usd(dash.monthSummary?.closedRO)],
                ['Variance $', usd(dash.monthSummary?.variance)],
                ['Variance %', dash.monthSummary?.variancePct == null ? null : dash.monthSummary.variancePct + '%'],
              ].map(([label, value]) => (
                <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '5px 0', borderTop: '1px solid #F5F1EC' }}>
                  <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>{label}</span>
                  <span className="mono" style={{ fontSize: 11.5, fontWeight: 700 }}>{value ?? unavailable}</span>
                </div>
              ))}
              {dash.trackerSource !== 'live' && (
                <div style={{ fontSize: 9, color: 'var(--amber)', fontWeight: 700, marginTop: 6 }}>
                  Production tracker sheet unreachable — money figures unavailable.
                </div>
              )}
            </div>
          )}
        </div>

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

        {!dash ? (
          <div className="empty-note">Loading report…</div>
        ) : kpi.inspections > 0 ? (
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

        {/* Every vehicle in the range — one row each, horizontally scrollable. */}
        {dash && (
          <div className="card">
            <div className="card-title">EVERY VEHICLE</div>
            {(() => {
              const inRange = (dash.vehicles || []).filter((v) => v.day >= dash.range.from && v.day <= dash.range.to);
              if (!inRange.length) return <div className="empty-note" style={{ padding: '8px 0 2px' }}>No vehicles in this range.</div>;
              const cell = { padding: '7px 9px', fontSize: 10.5, whiteSpace: 'nowrap', borderTop: '1px solid #F5F1EC', textAlign: 'left' };
              return (
                <div style={{ overflowX: 'auto', margin: '6px -6px 0', padding: '0 6px' }}>
                  <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                    <thead>
                      <tr>
                        {['VIN', 'Completed', 'Days', 'Plan $', 'Closed $', 'QC result'].map((h) => (
                          <th key={h} style={{ ...cell, borderTop: 'none', fontSize: 8.5, fontWeight: 700, color: 'var(--muted)', letterSpacing: 0.4 }}>{h.toUpperCase()}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {inRange.map((v) => (
                        <tr key={v.qcNumber} onClick={() => onOpenVehicle(v.vin, v.qcNumber)} style={{ cursor: 'pointer' }}>
                          <td className="mono" style={cell}>…{(v.vin || '').slice(-8)}</td>
                          <td className="mono" style={cell}>{v.tracker?.completed ?? '—'}</td>
                          <td className="mono" style={cell}>{v.daysInProduction ?? '—'}</td>
                          <td className="mono" style={cell}>{usd(v.tracker?.retailPlan) ?? '—'}</td>
                          <td className="mono" style={cell}>{usd(v.tracker?.closedRO) ?? '—'}</td>
                          <td style={{ ...cell, fontWeight: 800, color: v.status === 'open' ? 'var(--amber)' : v.result === 'pass' ? 'var(--green)' : v.status === 'cleared' ? 'var(--green)' : 'var(--red)' }}>
                            {v.status === 'open' ? 'OPEN' : v.status === 'cleared' ? 'CLEARED' : v.result.toUpperCase()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })()}
          </div>
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
