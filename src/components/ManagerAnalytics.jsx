import { useState } from 'react';

const pct = (value) => value == null ? '—' : `${Math.round(Number(value) * 1000) / 10}%`;
const hours = (value) => value == null ? '—' : `${Math.round(Number(value) * 10) / 10}h`;
const duration = (value, precision) => precision === 'calendar_day'
  ? (value == null ? '—' : `${Math.round((Number(value) / 24) * 10) / 10}d`)
  : hours(value);
const shortVin = (vin) => vin ? `…${String(vin).slice(-8)}` : '—';
const scope = (label) => <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: .5, color: 'var(--muted)', background: '#F5F1EC', padding: '3px 6px', borderRadius: 4 }}>{label}</span>;

function Metric({ label, value, sub, accent = 'var(--brown)' }) {
  return <div style={{ background: '#fff', border: '1px solid var(--border)', borderLeft: `3px solid ${accent}`, borderRadius: 9, padding: '8px 9px', minWidth: 0 }}>
    <div style={{ fontSize: 7.5, fontWeight: 700, letterSpacing: .5, color: 'var(--muted)' }}>{label}</div>
    <div className="oswald" style={{ fontSize: 20, fontWeight: 600, color: accent, marginTop: 2 }}>{value}</div>
    {sub && <div style={{ fontSize: 8, color: 'var(--muted)', marginTop: 2 }}>{sub}</div>}
  </div>;
}

function RangeState({ loading, error, onRetry, children }) {
  if (loading) return <div className="card" aria-label="Loading manager analytics"><div className="card-title">MANAGER ANALYTICS</div><div className="empty-note" style={{ marginTop: 9 }}>Loading cycle evidence…</div></div>;
  if (error) return <div className="card" role="alert"><div className="card-title" style={{ color: 'var(--red)' }}>MANAGER ANALYTICS UNAVAILABLE</div><p style={{ fontSize: 11, color: 'var(--muted)', margin: '8px 0 12px' }}>{error}</p><button type="button" className="btn btn-outline-red" style={{ height: 42 }} onClick={onRetry}>Retry report</button></div>;
  return children;
}

export default function ManagerAnalytics({ data, loading, error, filters, onFilters, onRetry, onOpenVehicle, onPrint, onShare }) {
  const [expandedVehicleKey, setExpandedVehicleKey] = useState(null);
  const options = data?.filters?.options || { estimators: [], qcResults: ['pass', 'fail'] };
  const rows = data?.cycles?.rows || [];
  const stages = data?.cycles?.stages || [];
  const daily = data?.daily;
  const calibration = data?.calibration;
  const filteredRows = rows;
  const updateFilter = (key) => (event) => onFilters({ ...filters, [key]: event.target.value });
  const dateRange = data?.range ? `${data.range.from} → ${data.range.to}` : 'Selected range';
  const coverageText = (stage) => `${pct(stage.coverage)} coverage · ${stage.unknown || 0} unknown`;
  const stageByKey = Object.fromEntries(stages.map((stage) => [stage.key, stage]));
  const agingStages = daily?.aging?.stages || [];
  const generatedLabel = daily?.generatedAt
    ? new Date(daily.generatedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
    : 'unknown';

  return <div style={{ display: 'contents' }}>
    <RangeState loading={loading} error={error} onRetry={onRetry}>
      {data ? <>
        <div className="card" style={{ background: '#faf7f2', borderColor: '#ded6cc' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 160 }}><div className="screen-title" style={{ fontSize: 21 }}>Manager analytics</div><div style={{ color: 'var(--muted)', fontSize: 10, marginTop: 2 }}>Flow evidence for coaching the next estimate, not ranking the team.</div></div>
            {scope('SELECTED RANGE')}
            <button type="button" className="btn btn-outline-brown" style={{ width: 'auto', height: 38, padding: '0 11px', fontSize: 11 }} onClick={onPrint}>Print</button>
            <button type="button" className="btn btn-dark" style={{ width: 'auto', height: 38, padding: '0 11px', fontSize: 11 }} onClick={onShare}>Share</button>
          </div>
          <div className="mono" style={{ fontSize: 9, color: 'var(--muted)', marginTop: 9 }}>{dateRange} · completed intakes · {data.timezone || 'shop timezone'}</div>
        </div>

        <div className="card">
          <div className="card-title">FILTER THE COACHING VIEW</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
            <label><span className="field-label">ESTIMATOR</span><select aria-label="Estimator filter" className="input" style={{ height: 42, fontSize: 13 }} value={filters?.estimator || ''} onChange={updateFilter('estimator')}><option value="">All estimators</option>{options.estimators.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
            <label><span className="field-label">FINAL QC</span><select aria-label="QC result filter" className="input" style={{ height: 42, fontSize: 13 }} value={filters?.qcResult || ''} onChange={updateFilter('qcResult')}><option value="">All results</option>{options.qcResults.map((result) => <option key={result} value={result}>{result.toUpperCase()}</option>)}</select></label>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 7 }}>
          <Metric label="COMPLETED COHORT" value={stageByKey.arrivalToIntake?.total ?? 0} sub="selected range" />
          <Metric label="ARRIVAL → INTAKE" value={hours(stageByKey.arrivalToIntake?.medianHours)} sub={`median · ${pct(stageByKey.arrivalToIntake?.coverage)} coverage`} accent="var(--gold)" />
          <Metric label="INTAKE → FINAL QC" value={hours(stageByKey.intakeToQc?.medianHours)} sub={`median · ${pct(stageByKey.intakeToQc?.coverage)} coverage`} accent="var(--green)" />
          <Metric label="RO → RELEASE" value={duration(stageByKey.roToRelease?.medianHours, stageByKey.roToRelease?.precision)} sub={`median · ${pct(stageByKey.roToRelease?.coverage)} coverage`} accent="var(--brown)" />
        </div>

        <div className="card">
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, flexWrap: 'wrap' }}><div className="card-title">CYCLE BOTTLENECKS</div>{scope('SELECTED RANGE')}</div>
          <div style={{ fontSize: 9.5, color: 'var(--muted)', margin: '6px 0' }}>Unknown means an endpoint was not recorded. It is not zero hours.</div>
          {stages.length ? stages.map((stage) => <div key={stage.key} style={{ borderTop: '1px solid #F5F1EC', padding: '9px 0' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}><strong style={{ fontSize: 11.5, flex: 1 }}>{stage.label}</strong><span className="mono" style={{ fontSize: 10, color: 'var(--muted)' }}>{stage.eligible ?? '—'} eligible</span><span className="oswald" style={{ fontSize: 16, color: stage.unknown ? 'var(--amber)' : 'var(--brown)' }}>{duration(stage.medianHours, stage.precision)}</span></div>
            <div style={{ display: 'flex', gap: 12, fontSize: 8.5, color: 'var(--muted)', marginTop: 3 }}><span>{coverageText(stage)}</span><span>avg {duration(stage.avgHours, stage.precision)} · p90 {duration(stage.p90Hours, stage.precision)}</span>{stage.invalidOrder ? <span style={{ color: 'var(--red)' }}>{stage.invalidOrder} invalid order</span> : null}</div>
          </div>) : <div className="empty-note" style={{ marginTop: 8 }}>No cycle stages in this report.</div>}
          <div style={{ fontSize: 8.5, color: 'var(--muted)', marginTop: 7 }}>RO and release tracker endpoints are source dates, so those stages display whole calendar-day precision.</div>
        </div>

        <div className="card">
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, flexWrap: 'wrap' }}><div className="card-title">VEHICLE DRILLDOWN</div>{scope(`${filteredRows.length} ROWS · SELECTED RANGE`)}</div>
          {!filteredRows.length ? <div className="empty-note" style={{ marginTop: 8 }}>No vehicles match these filters.</div> : <>
            <div className="manager-drilldown-cards">
              {filteredRows.map((vehicle) => {
                const vehicleKey = `${vehicle.vin}-${vehicle.qcNumber}`;
                const expanded = expandedVehicleKey === vehicleKey;
                const vehicleLabel = `${vehicle.stock || shortVin(vehicle.vin)} · ${vehicle.vehicle || 'Vehicle'}`;
                const panelId = `manager-cycle-${vehicleKey.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
                return <div className="manager-drilldown-card" key={vehicleKey}>
                  <button type="button" className="manager-drilldown-summary" aria-expanded={expanded} aria-controls={panelId} aria-label={`${expanded ? 'Hide' : 'Show'} cycle details for ${vehicleLabel}`} onClick={() => setExpandedVehicleKey(expanded ? null : vehicleKey)}>
                    <span>
                      <strong>{vehicleLabel}</strong>
                      <span className="mono">{shortVin(vehicle.vin)} · {vehicle.qcNumber || 'no QC number'}</span>
                    </span>
                    <span className="manager-drilldown-chevron" aria-hidden="true">{expanded ? '−' : '+'}</span>
                  </button>
                  {expanded && <div className="manager-drilldown-panel" id={panelId}>
                    <div className="manager-drilldown-details">
                      <div><span>Estimator</span><strong>{vehicle.estimator || 'unknown'}</strong></div>
                      <div><span>Final QC</span><strong className={vehicle.qcResult === 'fail' ? 'manager-drilldown-fail' : 'manager-drilldown-pass'}>{vehicle.qcResult || 'unknown'}</strong></div>
                      <div><span>Intake → QC</span><strong className="mono">{duration(vehicle.durations?.intakeToQc, 'timestamp')}</strong></div>
                      <div><span>QC → RO</span><strong className="mono">{duration(vehicle.durations?.qcToRo, 'calendar_day')}</strong></div>
                      <div><span>RO → release</span><strong className="mono">{duration(vehicle.durations?.roToRelease, 'calendar_day')}</strong></div>
                    </div>
                    <button type="button" className="manager-drilldown-open" onClick={() => onOpenVehicle(vehicle.vin, vehicle.qcNumber)}>Open vehicle</button>
                  </div>}
                </div>;
              })}
            </div>
            <div className="manager-drilldown-table" style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 580 }}><thead><tr>{['Vehicle', 'Estimator', 'QC', 'Intake → QC', 'QC → RO', 'RO → release'].map((heading) => <th key={heading} scope="col" style={{ textAlign: 'left', padding: '6px 7px', color: 'var(--muted)', fontSize: 8, letterSpacing: .4, borderBottom: '1px solid var(--border)' }}>{heading}</th>)}</tr></thead>
                <tbody>{filteredRows.map((vehicle) => <tr key={`${vehicle.vin}-${vehicle.qcNumber}`}><td style={{ padding: '8px 7px', borderBottom: '1px solid #F5F1EC' }}><button type="button" aria-label={`Open ${vehicle.stock || shortVin(vehicle.vin)} ${vehicle.vehicle || 'vehicle'}`} onClick={() => onOpenVehicle(vehicle.vin, vehicle.qcNumber)} style={{ border: 0, padding: 0, textAlign: 'left', background: 'none', color: 'var(--ink)', cursor: 'pointer' }}><strong style={{ display: 'block', fontSize: 10.5 }}>{vehicle.stock || shortVin(vehicle.vin)} · {vehicle.vehicle || 'Vehicle'}</strong><span className="mono" style={{ fontSize: 8, color: 'var(--muted)' }}>{shortVin(vehicle.vin)} · {vehicle.qcNumber || 'no QC number'}</span></button></td><td style={{ fontSize: 10, padding: 7, borderBottom: '1px solid #F5F1EC' }}>{vehicle.estimator || 'unknown'}</td><td style={{ fontSize: 9, fontWeight: 800, color: vehicle.qcResult === 'fail' ? 'var(--red)' : 'var(--green)', padding: 7, borderBottom: '1px solid #F5F1EC' }}>{vehicle.qcResult || 'unknown'}</td>{['intakeToQc', 'qcToRo', 'roToRelease'].map((key) => <td className="mono" key={key} style={{ fontSize: 9, padding: 7, borderBottom: '1px solid #F5F1EC' }}>{duration(vehicle.durations?.[key], key === 'intakeToQc' ? 'timestamp' : 'calendar_day')}</td>)}</tr>)}</tbody>
              </table>
            </div>
          </>}
          {data.cycles?.truncated && <div style={{ fontSize: 9, color: 'var(--muted)', marginTop: 8 }}>Showing the first 500 rows. Narrow the date range or filters to inspect the complete cohort.</div>}
        </div>

        <div className="card">
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, flexWrap: 'wrap' }}><div className="card-title">SHOP CALIBRATION</div>{scope('SELECTED RANGE')}</div>
          {!calibration?.available ? <div className="empty-note" style={{ marginTop: 8 }}>Calibration is unavailable for this range. No coaching conclusion is shown.</div> : <>
            <div style={{ margin: '7px 0' }}>
              {(calibration.notes?.length ? calibration.notes : [`Patterns below use a ${calibration.sampleThreshold || 5}-line low-sample marker.`]).map((note) => <div key={note} style={{ fontSize: 9.5, color: 'var(--muted)', marginTop: 3 }}>{note}</div>)}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 7 }}>
              <Metric label="AI ANALYSES" value={calibration.ai?.analyses ?? '—'} accent="var(--brown)" />
              <Metric label="AI CORRECTED" value={calibration.ai?.corrected ?? '—'} accent="var(--amber)" />
              <Metric label="AI CORRECTION RATE" value={pct(calibration.ai?.correctionRate)} accent="var(--red)" />
            </div>
            {calibration.ai?.byField?.length ? <div style={{ marginTop: 9 }}>
              <div className="field-label">COMMONLY CORRECTED AI CALLS</div>
              {calibration.ai.byField.map((item) => <div key={item.field} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', borderTop: '1px solid #F5F1EC' }}><span style={{ fontSize: 10.5, fontWeight: 700, flex: 1 }}>{item.field}</span><span className="mono" style={{ fontSize: 9 }}>{item.count} · {pct(item.share)}</span></div>)}
            </div> : null}
            {calibration.pricing?.byDamage?.length ? <div style={{ marginTop: 9 }}>
              <div className="field-label">PRICING CORRECTIONS BY DAMAGE TYPE</div>
              {calibration.pricing.byDamage.map((damage) => <div key={damage.category} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', borderTop: '1px solid #F5F1EC' }}><span style={{ fontSize: 10.5, fontWeight: 700, flex: 1, textTransform: 'capitalize' }}>{damage.category.replace(/_/g, ' ')}</span><span className="mono" style={{ fontSize: 9, color: damage.lowSample ? 'var(--muted)' : 'var(--ink)' }}>{damage.corrected}/{damage.total} corrected · {pct(damage.rate)}</span>{damage.lowSample && <span style={{ fontSize: 8, color: 'var(--amber)', fontWeight: 700 }}>LOW SAMPLE</span>}</div>)}
            </div> : null}
            {calibration.pricing?.byComponent?.length ? <div style={{ marginTop: 9 }}>
              <div className="field-label">PRICING PATTERN BY COMPONENT</div>
              {calibration.pricing.byComponent.map((item) => <div key={item.component} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', borderTop: '1px solid #F5F1EC' }}><span style={{ fontSize: 10.5, fontWeight: 700, flex: 1 }}>{item.component}</span><span className="mono" style={{ fontSize: 9 }}>{item.count} lines · {pct(item.share)}</span></div>)}
            </div> : null}
          </>}
        </div>

        <div className="card">
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, flexWrap: 'wrap' }}><div className="card-title">RIGHT NOW</div>{scope('LIVE OPERATIONAL SUMMARY')}</div>
          <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 7 }}>This summary ignores the selected date range. It is here to help decide what to teach or unblock today.</div>
          {daily?.trackerSource !== 'live' && <div role="status" style={{ color: 'var(--amber)', fontWeight: 700, fontSize: 10, marginTop: 8 }}>Production tracker is offline — release and RO endpoint data may be unavailable, not zero.</div>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 7, marginTop: 9 }}>
            <Metric label="INTAKES COMPLETED TODAY" value={daily?.completedIntakes ?? '—'} />
            <Metric label="FINAL QC PASS / FAIL" value={`${daily?.qcsPassed ?? '—'} / ${daily?.qcsFailed ?? '—'}`} accent="var(--green)" />
            <Metric label="OPEN RE-CHECKS" value={daily?.openRechecks ?? '—'} accent="var(--amber)" />
            <Metric label="EXPORT EXCEPTIONS" value={daily?.exportExceptions?.count ?? '—'} accent={daily?.exportExceptions?.count ? 'var(--red)' : 'var(--muted)'} />
          </div>
          {agingStages.length ? <div style={{ marginTop: 9 }}>
            <div className="field-label">AGING UNITS BY CURRENT STAGE</div>
            {agingStages.map((stage) => <div key={stage.key} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', borderTop: '1px solid #F5F1EC' }}><span style={{ fontSize: 10.5, fontWeight: 700, flex: 1 }}>{stage.label}</span><span className="mono" style={{ fontSize: 10 }}>{stage.count}</span></div>)}
          </div> : null}
          {daily?.exportExceptions?.trucks?.length ? <div style={{ marginTop: 7, fontSize: 10 }}>Export exceptions: {daily.exportExceptions.trucks.map((truck) => <button key={truck.vin} type="button" onClick={() => onOpenVehicle(truck.vin, truck.qcNumber)} style={{ margin: '3px 4px 0 0', border: '1px solid var(--border)', background: '#fff', borderRadius: 5, padding: '4px 6px', fontSize: 9 }}>{truck.stock || shortVin(truck.vin)}</button>)}</div> : null}
          <div className="mono" style={{ fontSize: 8.5, color: 'var(--muted)', marginTop: 9 }}>Generated {generatedLabel} · tracker source {daily?.trackerSource || 'unknown'}</div>
        </div>

        <div className="quote-print" aria-hidden="true">
          <h1>Truck Ranch Daily Manager Summary</h1>
          <div className="qp-sub">{daily?.day || 'Unknown day'} · America/Chicago · right now</div>
          <div className="qp-rule" />
          <div className="qp-meta">Generated {generatedLabel} · tracker source {daily?.trackerSource || 'unknown'}</div>
          <table>
            <tbody>
              <tr><th>Completed intakes</th><td className="num">{daily?.completedIntakes ?? 'unknown'}</td></tr>
              <tr><th>Final QC pass / fail</th><td className="num">{daily?.qcsPassed ?? 'unknown'} / {daily?.qcsFailed ?? 'unknown'}</td></tr>
              <tr><th>Open re-checks</th><td className="num">{daily?.openRechecks ?? 'unknown'}</td></tr>
              <tr><th>Export exceptions</th><td className="num">{daily?.exportExceptions?.count ?? 'unknown'}</td></tr>
            </tbody>
          </table>
          <h2>Selected-range cycle coverage</h2>
          <div className="qp-sub">{dateRange} · completed-intake cohort</div>
          <table>
            <thead><tr><th>Stage</th><th>Median</th><th>Eligible</th><th>Coverage</th><th>Unknown</th></tr></thead>
            <tbody>{stages.map((stage) => <tr key={stage.key}><td>{stage.label}</td><td className="num">{duration(stage.medianHours, stage.precision)}</td><td className="num">{stage.eligible}/{stage.total}</td><td className="num">{pct(stage.coverage)}</td><td className="num">{stage.unknown}</td></tr>)}</tbody>
          </table>
          <div className="qp-foot">Unknown endpoints remain unknown and are never treated as zero. This report is read-only and intended for shop coaching, not employee ranking.</div>
        </div>
      </> : <div className="card"><div className="empty-note">No manager report data for this range.</div></div>}
    </RangeState>
  </div>;
}