const TITLES = {
  dash: 'DASHBOARD',
  vehicles: 'VEHICLES',
  intake: 'INTAKE',
  inspect: 'FINAL QC',
  records: 'QC RECORDS',
  reports: 'REPORTS',
  settings: 'SETTINGS',
};

const FLOW_LABELS = {
  form: 'Vehicle details',
  sheet: 'Inspection checklist',
  result: 'Review & commit',
  recheck: 'Re-check',
};

export default function Header({ tab, onSettings, workflow }) {
  return (
    <>
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
      {workflow && (
        <div className="workflow-context noprint" aria-label={`Current workflow: ${FLOW_LABELS[workflow.stage] || 'In progress'}`}>
          <div className="workflow-context-copy">
            <span className="workflow-context-kicker">{FLOW_LABELS[workflow.stage] || 'Work in progress'}</span>
            <strong>{workflow.stock || 'NEW FINAL QC'}{workflow.vehicle ? ` · ${workflow.vehicle}` : ''}</strong>
            {workflow.vin && <span className="workflow-context-vin">{workflow.vin}</span>}
          </div>
          <div className="workflow-steps" aria-hidden="true">
            {['form', 'sheet', 'result'].map((step, i) => (
              <span key={step} className={'workflow-step ' + (workflow.stage === 'recheck' || i <= ['form', 'sheet', 'result'].indexOf(workflow.stage) ? 'done' : '')} />
            ))}
          </div>
        </div>
      )}
    </>
  );
}
