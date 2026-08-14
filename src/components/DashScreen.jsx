import { chipStyle, catByKey } from '../lib/constants';

// Dash tab — every number here comes from /api/dashboard; nothing is recomputed
// on the client. `dash` may be null while the first fetch is in flight.

const pct = (v) => (v == null ? '—' : Math.round(v * 1000) / 10 + '%');
const n1 = (v) => (v == null ? '—' : Math.round(v * 10) / 10);

const STATUS_ROWS = [
  ['awaitingFinalQc', 'Awaiting Final QC', 'var(--brown)'],
  ['openRecheck', 'Open re-check', 'var(--amber)'],
  ['frontlineReady', 'Frontline ready', 'var(--green)'],
  ['released', 'Released', 'var(--muted)'],
];

const ACTION_LABEL = { created: 'Final QC committed', recheck_committed: 'Re-check committed' };

function Tile({ label, value, accent }) {
  return (
    <div style={{ background: '#fff', border: '1px solid var(--border)', borderLeft: `3px solid ${accent}`, borderRadius: 10, padding: '10px 11px' }}>
      <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: 0.5, color: 'var(--muted)' }}>{label}</div>
      <div className="oswald" style={{ fontWeight: 600, fontSize: 22, marginTop: 2, color: accent }}>{value}</div>
    </div>
  );
}

function PairedBars({ days }) {
  const max = Math.max(1, ...days.map((d) => Math.max(d.intakes, d.finalQcs)));
  const todayIdx = days.length - 1;
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end', height: 96, marginTop: 10 }}>
      {days.map((d, i) => {
        const dayLabel = new Date(d.day + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' });
        return (
          <div key={d.day} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, height: '100%' }}>
            <div style={{ flex: 1, width: '100%', display: 'flex', gap: 2, alignItems: 'flex-end', justifyContent: 'center' }}>
              <div title={`${d.intakes} intakes`} style={{ width: '40%', height: `${(d.intakes / max) * 100}%`, minHeight: d.intakes ? 3 : 1, background: 'var(--brown)', borderRadius: 3 }} />
              <div title={`${d.finalQcs} Final QCs`} style={{ width: '40%', height: `${(d.finalQcs / max) * 100}%`, minHeight: d.finalQcs ? 3 : 1, background: 'var(--red)', borderRadius: 3 }} />
            </div>
            <span className="mono" style={{ fontSize: 8, fontWeight: i === todayIdx ? 800 : 500, color: i === todayIdx ? 'var(--red)' : 'var(--muted)' }}>
              {i === todayIdx ? 'TODAY' : dayLabel}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default function DashScreen({ dash, onOpenStatus, onOpenVehicle }) {
  if (!dash) {
    return (
      <div className="screen">
        <div className="screen-body"><div className="empty-note">Loading dashboard…</div></div>
      </div>
    );
  }

  const { kpi, tracker7, byStatus, blocked, activity, weekly, deptFailRate, thisWeek, aiAccuracy } = dash;
  const maxWeek = Math.max(1, ...(weekly || []).map((w) => w.finalQcs));

  return (
    <div className="screen">
      <div className="screen-topbar">
        <div className="screen-title-row">
          <span className="screen-title">Dashboard</span>
        </div>
      </div>
      <div className="screen-body" style={{ gap: 9 }}>
        {/* 1 — KPI grid */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 7 }}>
          <Tile label="INSPECTIONS ON RECORD" value={kpi.inspections} accent="var(--brown)" />
          <Tile label="QC FAIL RATE" value={pct(kpi.failRate)} accent={kpi.failRate > 0.25 ? 'var(--red)' : 'var(--green)'} />
          <Tile label="AVG DAYS IN PRODUCTION" value={n1(kpi.avgDaysInProduction)} accent="var(--gold)" />
          <Tile label="OPEN RE-CHECKS" value={kpi.openRechecks} accent={kpi.openRechecks ? 'var(--amber)' : 'var(--muted)'} />
        </div>

        {/* 1b — This week strip */}
        {thisWeek && (
          <div className="card">
            <div className="card-title">THIS WEEK</div>
            <div style={{ display: 'flex', gap: 14, marginTop: 8 }}>
              {[
                ['Intakes', thisWeek.intakesCompleted, 'var(--brown)'],
                ['QCs passed', thisWeek.qcsPassed, 'var(--green)'],
                ['QCs failed', thisWeek.qcsFailed, thisWeek.qcsFailed ? 'var(--red)' : 'var(--muted)'],
                ['Avg quoted hrs', n1(thisWeek.avgQuotedHours), 'var(--gold)'],
              ].map(([label, value, color]) => (
                <div key={label} style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: 0.4, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</div>
                  <div className="oswald" style={{ fontWeight: 600, fontSize: 22, marginTop: 2, color }}>{value}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 2 — Daily Tracker */}
        <div className="card">
          <div className="card-title">DAILY TRACKER</div>
          <div style={{ display: 'flex', gap: 18, marginTop: 8 }}>
            {[
              ['Intakes today', tracker7.todayIntakes, tracker7.weekIntakes, 'var(--brown)'],
              ['Final QCs today', tracker7.todayFinalQcs, tracker7.weekFinalQcs, 'var(--red)'],
            ].map(([label, today, week, color]) => (
              <div key={label} style={{ flex: 1 }}>
                <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--muted)' }}>{label}</div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
                  <span className="oswald" style={{ fontSize: 26, fontWeight: 600, color }}>{today}</span>
                  <span className="mono" style={{ fontSize: 9.5, color: 'var(--muted)' }}>{week} this week</span>
                </div>
              </div>
            ))}
          </div>
          <PairedBars days={tracker7.days} />
          <div style={{ display: 'flex', gap: 12, marginTop: 6, fontSize: 8.5, color: 'var(--muted)', fontWeight: 600 }}>
            <span><span style={{ display: 'inline-block', width: 8, height: 8, background: 'var(--brown)', borderRadius: 2, marginRight: 4 }} />Intakes</span>
            <span><span style={{ display: 'inline-block', width: 8, height: 8, background: 'var(--red)', borderRadius: 2, marginRight: 4 }} />Final QCs</span>
          </div>
        </div>

        {/* 3 — Every record by status */}
        <div className="card">
          <div className="card-title">EVERY RECORD BY STATUS</div>
          {STATUS_ROWS.map(([k, label, color]) => (
            <div key={k} onClick={() => onOpenStatus(k)} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '11px 0', borderTop: '1px solid #F5F1EC', cursor: 'pointer', minHeight: 44 }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: color, flex: '0 0 auto' }} />
              <span style={{ fontSize: 12.5, fontWeight: 600, flex: 1 }}>{label}</span>
              <span className="oswald" style={{ fontSize: 17, fontWeight: 600 }}>{byStatus[k] == null ? '—' : byStatus[k]}</span>
              <span style={{ color: 'var(--muted)', fontSize: 13 }}>›</span>
            </div>
          ))}
        </div>

        {/* 4 — Blocked */}
        <div className="card">
          <div className="card-title" style={{ color: blocked.length ? 'var(--red)' : undefined }}>BLOCKED — FAILED FINAL QC</div>
          {blocked.length === 0 && <div className="empty-note" style={{ padding: '10px 0 4px' }}>Nothing blocked — no open re-checks.</div>}
          {blocked.map((b) => (
            <div key={b.qcNumber} onClick={() => onOpenVehicle(b.vin, b.qcNumber)} style={{ borderTop: '1px solid #F5F1EC', padding: '10px 0', cursor: 'pointer' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <span className="mono" style={{ fontSize: 10, fontWeight: 600 }}>{b.qcNumber}</span>
                <span className="oswald" style={{ fontWeight: 600, fontSize: 13.5, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {b.stock} · {b.vehicle}
                </span>
                <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--amber)' }}>
                  {b.daysOpen === 0 ? 'today' : `${b.daysOpen}d open`}
                </span>
              </div>
              <div className="mono" style={{ fontSize: 9, color: 'var(--muted)', marginTop: 3 }}>{b.vin}</div>
              <div style={{ display: 'flex', gap: 4, marginTop: 5, alignItems: 'center', flexWrap: 'wrap' }}>
                {b.segments.map((k) => (
                  <span key={k} style={chipStyle(k)}>{catByKey(k)?.seg || k}</span>
                ))}
                <span style={{ fontSize: 9, color: 'var(--muted)', fontWeight: 600 }}>
                  {b.itemCount} item{b.itemCount === 1 ? '' : 's'}
                </span>
              </div>
              {b.note && <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 4, fontStyle: 'italic' }}>“{b.note}”</div>}
            </div>
          ))}
        </div>

        {/* 5 — Recent activity */}
        <div className="card">
          <div className="card-title">RECENT ACTIVITY</div>
          {activity.length === 0 && <div className="empty-note" style={{ padding: '10px 0 4px' }}>No activity yet.</div>}
          {activity.slice(0, 12).map((a, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, padding: '8px 0', borderTop: '1px solid #F5F1EC', alignItems: 'baseline' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 11.5, fontWeight: 700 }}>{ACTION_LABEL[a.action] || a.action}</span>
                <span className="mono" style={{ fontSize: 10, marginLeft: 6 }}>{a.qcNumber}</span>
                <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {[a.stock, a.vehicle].filter(Boolean).join(' · ') || '—'} — {a.actor}
                </div>
              </div>
              <span className="mono" style={{ fontSize: 9, color: 'var(--muted)', flex: '0 0 auto' }}>
                {new Date(a.at).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })}{' '}
                {new Date(a.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
              </span>
            </div>
          ))}
        </div>

        {/* 6 — Throughput per week + dept fail rate */}
        <div className="card">
          <div className="card-title">THROUGHPUT PER WEEK</div>
          {(weekly || []).map((w) => (
            <div key={w.week} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0' }}>
              <span className="mono" style={{ fontSize: 9.5, flex: '0 0 74px', color: 'var(--muted)' }}>wk of {w.week.slice(5)}</span>
              <div style={{ flex: 1, height: 8, background: 'var(--panel2)', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ width: `${(w.finalQcs / maxWeek) * 100}%`, height: '100%', background: 'var(--red)', borderRadius: 4 }} />
              </div>
              <span className="mono" style={{ fontSize: 11, minWidth: 20, textAlign: 'right' }}>{w.finalQcs}</span>
            </div>
          ))}
        </div>
        <div className="card">
          <div className="card-title">FAIL RATE BY DEPARTMENT</div>
          {deptFailRate.map((d) => (
            <div key={d.segment} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0' }}>
              <span style={chipStyle(d.segment)}>{catByKey(d.segment)?.seg || d.segment}</span>
              <div style={{ flex: 1, height: 8, background: 'var(--panel2)', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ width: d.rate ? `${Math.max(4, d.rate * 100)}%` : 0, height: '100%', background: 'var(--red)', borderRadius: 4 }} />
              </div>
              <span className="mono" style={{ fontSize: 11, minWidth: 40, textAlign: 'right' }}>{pct(d.rate)}</span>
            </div>
          ))}
        </div>

        {/* 8 — AI accuracy trend (only shown once at least one photo has been analyzed) */}
        {aiAccuracy && aiAccuracy.some((w) => w.analyses > 0) && (
          <div className="card">
            <div className="card-title">AI DAMAGE CALL ACCURACY</div>
            <div style={{ fontSize: 9.5, color: 'var(--muted)', marginBottom: 8 }}>
              Photos AI analyzed vs. estimator corrections per week — lower correction rate = better AI accuracy.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '74px 1fr 1fr 56px', gap: 0 }}>
              <span className="mono" style={{ fontSize: 8, fontWeight: 700, color: 'var(--muted)', paddingBottom: 4 }}>WEEK OF</span>
              <span className="mono" style={{ fontSize: 8, fontWeight: 700, color: 'var(--muted)', paddingBottom: 4, textAlign: 'right', paddingRight: 8 }}>ANALYZED</span>
              <span className="mono" style={{ fontSize: 8, fontWeight: 700, color: 'var(--muted)', paddingBottom: 4, textAlign: 'right', paddingRight: 8 }}>CORRECTED</span>
              <span className="mono" style={{ fontSize: 8, fontWeight: 700, color: 'var(--muted)', paddingBottom: 4, textAlign: 'right' }}>CORR RATE</span>
            </div>
            {aiAccuracy.slice(-8).map((w) => {
              const rate = w.analyses > 0 ? w.corrections / w.analyses : null;
              const rateColor = rate == null ? 'var(--muted)' : rate > 0.7 ? 'var(--red)' : rate > 0.4 ? 'var(--amber)' : 'var(--green)';
              return (
                <div key={w.week} style={{ display: 'grid', gridTemplateColumns: '74px 1fr 1fr 56px', gap: 0, padding: '4px 0', borderTop: '1px solid #F5F1EC', alignItems: 'center' }}>
                  <span className="mono" style={{ fontSize: 9.5, color: 'var(--muted)' }}>wk {w.week.slice(5)}</span>
                  <span className="mono" style={{ fontSize: 11, fontWeight: 600, textAlign: 'right', paddingRight: 8 }}>{w.analyses}</span>
                  <span className="mono" style={{ fontSize: 11, fontWeight: 600, textAlign: 'right', paddingRight: 8 }}>{w.corrections}</span>
                  <span className="mono oswald" style={{ fontSize: 11, fontWeight: 700, textAlign: 'right', color: rateColor }}>
                    {rate == null ? '—' : Math.round(rate * 100) + '%'}
                  </span>
                </div>
              );
            })}
            <div style={{ display: 'flex', gap: 14, marginTop: 8, fontSize: 8, color: 'var(--muted)', fontWeight: 600 }}>
              <span><span style={{ display: 'inline-block', width: 8, height: 8, background: 'var(--green)', borderRadius: 2, marginRight: 4 }} />≤40% good</span>
              <span><span style={{ display: 'inline-block', width: 8, height: 8, background: 'var(--amber)', borderRadius: 2, marginRight: 4 }} />41–70% ok</span>
              <span><span style={{ display: 'inline-block', width: 8, height: 8, background: 'var(--red)', borderRadius: 2, marginRight: 4 }} />&gt;70% high</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
