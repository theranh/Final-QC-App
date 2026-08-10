const TITLES = {
  dash: 'DASHBOARD',
  vehicles: 'VEHICLES',
  intake: 'INTAKE',
  inspect: 'FINAL QC',
  records: 'QC RECORDS',
  reports: 'REPORTS',
  settings: 'SETTINGS',
};

export default function Header({ tab, onSettings }) {
  return (
    <div className="app-header noprint">
      <span className="logo-sq">TR</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="head-title">{TITLES[tab] || 'INTAKE & QC'}</div>
        <div className="head-sub">Truck Ranch — Intake &amp; QC</div>
      </div>
      <span className="wordmark">TRUCK RANCH</span>
      {onSettings && (
        <button
          aria-label="Settings"
          onClick={onSettings}
          style={{
            width: 44, height: 44, border: 'none', background: 'transparent', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 19,
            color: tab === 'settings' ? 'var(--red)' : 'var(--muted)', padding: 0, marginLeft: 2,
          }}
        >
          ⚙
        </button>
      )}
    </div>
  );
}
