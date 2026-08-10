// Vehicles tab — two buckets: In-Take Quotes (completed intake, no inspection yet)
// and Completed QC's (every vehicle with an inspection). Searchable by stock # or
// VIN. All figures come from /api/dashboard (server-computed); this screen only renders.

import { RecentQuoteCard } from './IntakeScreen';

const FILTERS = [
  ['awaitingFinalQc', 'In-Take Quotes'],
  ['completed', "Completed QC's"],
];

const STATUS_META = {
  openRecheck: { label: 'OPEN RE-CHECK', bg: 'var(--amber)' },
  frontlineReady: { label: 'FRONTLINE READY', bg: 'var(--green)' },
  released: { label: 'RELEASED', bg: 'var(--muted)' },
};

const usd = (v) =>
  v == null ? null : '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 });

export default function VehiclesScreen({ dash, filter, onFilter, q, onQ, onOpenVehicle, onStartQc }) {
  // Any non-intake filter value (old saved states like 'all', 'released', …)
  // falls into the Completed QC's bucket.
  const bucket = filter === 'awaitingFinalQc' ? 'awaitingFinalQc' : 'completed';
  const vehicles = dash?.vehicles || [];
  const needle = q.trim().toUpperCase();
  const list = vehicles.filter((v) => {
    if (!needle) return true;
    return (v.stock || '').toUpperCase().includes(needle) || (v.vin || '').toUpperCase().includes(needle);
  });
  // Awaiting Final QC = completed intake, no inspection yet — server-composed
  // list from this app's local intakes table.
  const awaiting = (dash?.awaiting || []).filter((v) => {
    if (!needle) return true;
    return (v.stock || '').toUpperCase().includes(needle) || (v.vin || '').toUpperCase().includes(needle);
  });

  return (
    <div className="screen">
      <div className="screen-topbar" style={{ padding: '8px 14px 10px' }}>
        <div className="screen-title-row">
          <span className="screen-title">Vehicles</span>
          <span className="mono" style={{ fontSize: 9.5, color: 'var(--muted)' }}>
            {(bucket === 'awaitingFinalQc' ? awaiting.length : list.length)} shown
          </span>
        </div>
        <input
          className="input"
          style={{ marginTop: 8 }}
          placeholder="Search stock # or VIN…"
          value={q}
          onChange={(e) => onQ(e.target.value)}
        />
        <div style={{ display: 'flex', gap: 6, marginTop: 8, overflowX: 'auto', paddingBottom: 4 }}>
          {FILTERS.map(([k, label]) => (
            <span key={k} className={'pill-btn' + (bucket === k ? ' on red' : '')} onClick={() => onFilter(k)} style={{ whiteSpace: 'nowrap' }}>
              {label}
            </span>
          ))}
        </div>
      </div>
      <div className="screen-body">
        {!dash && <div className="empty-note">Loading vehicles…</div>}
        {dash && bucket === 'awaitingFinalQc' && awaiting.length === 0 && (
          <div className="empty-note">No in-take quotes are waiting for QC{needle ? ' that match' : ''}.</div>
        )}
        {bucket === 'awaitingFinalQc' &&
          awaiting.map((v) => (
            <RecentQuoteCard
              key={v.vin}
              quote={v}
              onClick={() => onStartQc(v)}
              badge="AWAITING QC"
              footer="Tap to start Final QC →"
            />
          ))}
        {dash && bucket === 'completed' && list.length === 0 && (
          <div className="empty-note">No completed QC's{needle ? ' match' : ' yet'}.</div>
        )}
        {bucket === 'completed' &&
          list.map((v) => {
            const sm = STATUS_META[v.statusKey] || STATUS_META.frontlineReady;
            const money =
              v.tracker && v.tracker.retailPlan != null && v.tracker.closedRO != null
                ? `${usd(v.tracker.retailPlan)} plan · ${usd(v.tracker.closedRO)} closed`
                : v.quote && v.quote.usd != null
                ? `${usd(v.quote.usd)} quoted${v.quote.hrs != null ? ` · ${v.quote.hrs} hrs` : ''}`
                : 'Quote unavailable';
            return (
              <div
                key={v.qcNumber}
                onClick={() => onOpenVehicle(v.vin, v.qcNumber)}
                style={{ background: '#fff', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px', cursor: 'pointer' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span className="oswald" style={{ fontWeight: 600, fontSize: 14, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {v.stock} · {v.vehicle}
                  </span>
                  <span style={{ fontSize: 8.5, fontWeight: 700, color: '#fff', background: sm.bg, padding: '2px 7px', borderRadius: 4, flex: '0 0 auto' }}>{sm.label}</span>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 4, alignItems: 'baseline' }}>
                  <span className="mono" style={{ fontSize: 9.5, color: 'var(--muted)' }}>…{(v.vin || '').slice(-8)}</span>
                  <span className="mono" style={{ fontSize: 9.5, color: 'var(--muted)' }}>{v.qcNumber}</span>
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: 9.5, fontWeight: 600, color: 'var(--muted)' }}>
                    {v.daysInProduction != null ? `${v.daysInProduction}d in production` : 'days n/a'}
                  </span>
                </div>
                <div style={{ fontSize: 10.5, fontWeight: 600, marginTop: 4, color: 'var(--brown)' }}>{money}</div>
              </div>
            );
          })}
      </div>
    </div>
  );
}
