// Vehicles tab — every vehicle with an inspection, searchable by stock # or VIN,
// filterable by the same four statuses as the Dash status rows. All figures come
// from /api/dashboard (server-computed); this screen only renders.

const FILTERS = [
  ['all', 'All'],
  ['awaitingFinalQc', 'Awaiting QC'],
  ['openRecheck', 'Open re-check'],
  ['frontlineReady', 'Frontline ready'],
  ['released', 'Released'],
];

const STATUS_META = {
  openRecheck: { label: 'OPEN RE-CHECK', bg: 'var(--amber)' },
  frontlineReady: { label: 'FRONTLINE READY', bg: 'var(--green)' },
  released: { label: 'RELEASED', bg: 'var(--muted)' },
};

const usd = (v) =>
  v == null ? null : '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 });

export default function VehiclesScreen({ dash, filter, onFilter, q, onQ, onOpenVehicle }) {
  const vehicles = dash?.vehicles || [];
  const needle = q.trim().toUpperCase();
  const list = vehicles.filter((v) => {
    if (filter !== 'all' && v.statusKey !== filter) return false;
    if (!needle) return true;
    return (v.stock || '').toUpperCase().includes(needle) || (v.vin || '').toUpperCase().includes(needle);
  });

  return (
    <div className="screen">
      <div className="screen-topbar" style={{ padding: '8px 14px 10px' }}>
        <div className="screen-title-row">
          <span className="screen-title">Vehicles</span>
          <span className="mono" style={{ fontSize: 9.5, color: 'var(--muted)' }}>{list.length} shown</span>
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
            <span key={k} className={'pill-btn' + (filter === k ? ' on red' : '')} onClick={() => onFilter(k)} style={{ whiteSpace: 'nowrap' }}>
              {label}
            </span>
          ))}
        </div>
      </div>
      <div className="screen-body">
        {!dash && <div className="empty-note">Loading vehicles…</div>}
        {dash && filter === 'awaitingFinalQc' && (
          <div className="empty-note">
            {dash.byStatus?.awaitingFinalQc == null
              ? 'The Body Quoter is unreachable — awaiting-QC vehicles can’t be listed right now.'
              : `${dash.byStatus.awaitingFinalQc} vehicle${dash.byStatus.awaitingFinalQc === 1 ? ' has' : 's have'} an intake and no Final QC yet. They appear here once inspected — start one from the Final QC tab.`}
          </div>
        )}
        {dash && filter !== 'awaitingFinalQc' && list.length === 0 && (
          <div className="empty-note">No vehicles match.</div>
        )}
        {filter !== 'awaitingFinalQc' &&
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
