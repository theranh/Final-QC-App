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

  const { kpi, tracker7, byStatus, blocked, activity, weekly, deptFailRate, intakeSource } = dash;
  const maxWeek = Math.max(1, ...(weekly || []).map((w) => w.finalQcs));

  return (
    <div className="screen">
      <div className="screen-topbar">
        <div className="screen-title-row">
          <span className="screen-title">Dashboard</span>
          {intakeSource !== 'live' && (
            <span style={{ fontSize: 8.5, fontWeight: 700, color: 'var(--amber)' }}>INTAKE DATA UNAVAILABLE</span>
          )}
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
      </div>
    </div>
  );
}
