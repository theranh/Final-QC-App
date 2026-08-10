const STROKE = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round' };

const ICONS = {
  // Speedometer / gauge
  dash: (
    <svg viewBox="0 0 24 24" {...STROKE}>
      <path d="M4.5 17.5a8.5 8.5 0 1 1 15 0" />
      <path d="M12 13.5 15.5 9" />
      <circle cx="12" cy="14.5" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  ),
  // Pickup truck
  vehicles: (
    <svg viewBox="0 0 24 24" {...STROKE}>
      <path d="M2.5 15.5V9.5h8l2-3.5h4.5l2.5 4.5h2v5" />
      <path d="M10.5 9.5V6" />
      <circle cx="7" cy="16.5" r="2" />
      <circle cx="17.5" cy="16.5" r="2" />
      <path d="M9 16.5h6.5M2.5 15.5h2.5M19.5 16.5h2" />
    </svg>
  ),
  // Clipboard with plus
  intake: (
    <svg viewBox="0 0 24 24" {...STROKE}>
      <rect x="5" y="4.5" width="14" height="17" rx="2.5" />
      <path d="M9 4.5V3.5h6v1" />
      <path d="M12 10v6M9 13h6" />
    </svg>
  ),
  // Shield with checkmark
  inspect: (
    <svg viewBox="0 0 24 24" {...STROKE}>
      <path d="M12 2.8 4.5 5.6v6c0 4.8 3.2 8 7.5 9.6 4.3-1.6 7.5-4.8 7.5-9.6v-6L12 2.8Z" />
      <path d="m8.8 12 2.3 2.4 4.2-4.6" />
    </svg>
  ),
  // Bar chart
  reports: (
    <svg viewBox="0 0 24 24" {...STROKE}>
      <path d="M4 20h16" />
      <path d="M7 20v-6M12 20V8M17 20v-9" />
    </svg>
  ),
};

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
              {ICONS[k]}
              {k === 'dash' && openRecheckCount > 0 && <span className="nav-badge">{openRecheckCount}</span>}
            </span>
            <span className="nav-tab-label">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
