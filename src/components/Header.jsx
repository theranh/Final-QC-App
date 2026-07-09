const TITLES = { inspect: 'FINAL QC', records: 'QC RECORDS', reports: 'QC REPORTS', settings: 'SETTINGS' };

export default function Header({ tab }) {
  return (
    <div className="app-header noprint">
      <span className="logo-sq">TR</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="head-title">{TITLES[tab] || 'FINAL QC'}</div>
        <div className="head-sub">FRPS</div>
      </div>
      <span className="wordmark">TRUCK RANCH</span>
    </div>
  );
}
