const TABS = [
  ['dash', 'Dash'],
  ['vehicles', 'Vehicles'],
  ['intake', 'Intake'],
  ['inspect', 'Final QC'],
  ['reports', 'Reports'],
];

export default function BottomNav({ tab, onChange, openRecheckCount }) {
  return (
    <div className="bottom-nav noprint">
      {TABS.map(([k, label]) => {
        const active = tab === k;
        return (
          <button key={k} className={'nav-tab' + (active ? ' active' : '')} onClick={() => onChange(k)}>
            <span className={'nav-tab-icon ' + k}>
              {k === 'dash' && openRecheckCount > 0 && <span className="nav-badge">{openRecheckCount}</span>}
            </span>
            <span className="nav-tab-label">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
