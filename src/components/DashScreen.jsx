import { useEffect, useState } from 'react';
import { chipStyle, catByKey } from '../lib/constants';
import { subscribePending } from '../lib/photoQueue';
import HandoffWorkspace from './HandoffWorkspace';

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

function Tile({ label, value, accent, sub }) {
  return (
    <div style={{ background: '#fff', border: '1px solid var(--border)', borderLeft: `3px solid ${accent}`, borderRadius: 10, padding: '10px 11px' }}>
      <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: 0.5, color: 'var(--muted)' }}>{label}</div>
      <div className="oswald" style={{ fontWeight: 600, fontSize: 22, marginTop: 2, color: accent }}>{value}</div>
      {sub && <div style={{ fontSize: 7.5, fontWeight: 600, letterSpacing: 0.3, color: 'var(--muted)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

// Small scope chip so all-time / right-now cards can't be misread as
// range-scoped (and vice versa).
function ScopeChip({ children }) {
  return (
    <span style={{ fontSize: 7.5, fontWeight: 700, letterSpacing: 0.5, color: 'var(--muted)', background: '#F5F1EC', padding: '2px 6px', borderRadius: 4, marginLeft: 6, verticalAlign: 'middle' }}>
      {children}
    </span>
  );
}

/**
 * Sparkline bar chart for AI accuracy — one bar per week, height proportional
 * to the correction rate, colour green/amber/red by threshold.
 */
function AccuracyBars({ weeks }) {
  // weeks = aiAccuracy.slice(-8), same slice used by the table
  const visibleWeeks = weeks.filter((w) => w.analyses > 0);
  if (!visibleWeeks.length) return null;
  return (
    <div style={{ display: 'flex', gap: 5, alignItems: 'flex-end', height: 72, marginBottom: 10 }}>
      {visibleWeeks.map((w) => {
        const rate = w.analyses > 0 ? w.corrections / w.analyses : 0;
        const barH = Math.max(4, Math.round(rate * 100)); // px, 4 = floor so 0% is still visible
        const color = rate > 0.7 ? 'var(--red)' : rate > 0.4 ? 'var(--amber)' : 'var(--green)';
        const label = w.week.slice(5); // MM-DD
        const rateLabel = Math.round(rate * 100) + '%';
        return (
          <div key={w.week} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, height: '100%' }}>
            <div style={{ flex: 1, width: '100%', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
              <div
                title={`wk ${label}: ${rateLabel} correction rate (${w.corrections}/${w.analyses})`}
                style={{ width: '70%', height: `${barH}%`, background: color, borderRadius: 3 }}
              />
            </div>
            <span className="mono" style={{ fontSize: 7.5, color: 'var(--muted)', fontWeight: 600, letterSpacing: 0 }}>{label}</span>
          </div>
        );
      })}
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

export default function DashScreen({ dash, onOpenStatus, onOpenVehicle, isAdmin, pendingCommit }) {
  const [pendingPhotoCount, setPendingPhotoCount] = useState(0);
  useEffect(() => subscribePending(setPendingPhotoCount), []);

  if (!dash) {
    return (
      <div className="screen">
        <div className="screen-body"><div className="empty-note">Loading dashboard…</div></div>
      </div>
    );
  }

  const { kpi, tracker7, byStatus, blocked, activity, weekly, deptFailRate, thisWeek, aiAccuracy, aging } = dash;
  const maxWeek = Math.max(1, ...(weekly || []).map((w) => w.finalQcs));
  const agingByKey = Object.fromEntries((aging?.stages || []).map((s) => [s.key, s]));
  const firstBlocked = blocked[0];
  const firstAwaiting = agingByKey.awaitingQc?.trucks?.[0];
  const firstExportFailure = agingByKey.exportFailed?.trucks?.[0];
  const actionItems = [
    firstExportFailure && {
      tone: 'var(--red)',
      title: 'Resolve failed tracker export',
      detail: `${firstExportFailure.stock || firstExportFailure.vin} · waiting ${firstExportFailure.days}d`,
      onClick: () => firstExportFailure.qcNumber
        ? onOpenVehicle(firstExportFailure.vin, firstExportFailure.qcNumber)
        : onOpenStatus('frontlineReady'),
    },
    firstBlocked && {
      tone: 'var(--amber)',
      title: 'Complete an open re-check',
      detail: `${firstBlocked.stock || firstBlocked.vin} · ${firstBlocked.daysOpen === 0 ? 'opened today' : `${firstBlocked.daysOpen}d open`}`,
      onClick: () => onOpenVehicle(firstBlocked.vin, firstBlocked.qcNumber),
    },
    firstAwaiting && {
      tone: 'var(--brown)',
      title: 'Run a Final QC',
      detail: `${firstAwaiting.stock || firstAwaiting.vin} · intake waiting ${firstAwaiting.days === 0 ? 'today' : `${firstAwaiting.days}d`}`,
      onClick: () => onOpenStatus('awaitingFinalQc'),
    },
  ].filter(Boolean).slice(0, 3);

  return (
    <div className="screen">
      <div className="screen-topbar">
        <div className="screen-title-row">
          <span className="screen-title">Dashboard</span>
          <span style={{ flex: 1 }} />
          {/* Freshness — this payload is server-cached; say when it was
              composed, and be loud when tracker data is missing from it. */}
          {dash.trackerSource === 'unavailable' && (
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 0.6, color: '#fff', background: 'var(--amber)', padding: '3px 8px', borderRadius: 5, marginRight: 8 }}>TRACKER OFFLINE</span>
          )}
          {dash.generatedAt ? (
            <span className="mono" style={{ fontSize: 9.5, color: 'var(--muted)' }}>
              Updated {new Date(dash.generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
            </span>
          ) : null}
        </div>
      </div>
      <div className="screen-body" style={{ gap: 9 }}>
        {/* 0 — Operations Handoff Workspace (collapsible) */}
        <HandoffWorkspace
          isAdmin={isAdmin}
          pendingPhotoCount={pendingPhotoCount}
          pendingCommit={!!pendingCommit}
        />

        {/* 1 — KPI grid */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 7 }}>
          <Tile label="INSPECTIONS ON RECORD" value={kpi.inspections} accent="var(--brown)" sub="selected range" />
          <Tile label="QC FAIL RATE" value={pct(kpi.failRate)} accent={kpi.failRate > 0.25 ? 'var(--red)' : 'var(--green)'} sub="selected range" />
          <Tile label="AVG DAYS IN PRODUCTION" value={n1(kpi.avgDaysInProduction)} accent="var(--gold)" sub="range · trucks with tracker data" />
          <Tile label="OPEN RE-CHECKS" value={kpi.openRechecks} accent={kpi.openRechecks ? 'var(--amber)' : 'var(--muted)'} sub="right now — all time" />
        </div>

        {/* Make the first decision on shift obvious: action items come from
            the same server-composed aging/blocked data as the other cards. */}
        <div className="card today-queue">
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <div className="card-title" style={{ color: 'var(--ink)' }}>TODAY — NEXT ACTIONS</div>
            <span style={{ fontSize: 9, color: 'var(--muted)', fontWeight: 600 }}>PRIORITIZED FOR THE TEAM</span>
          </div>
          {actionItems.length ? actionItems.map((item) => (
            <button className="today-queue-row" key={item.title} onClick={item.onClick}>
              <span className="today-queue-dot" style={{ background: item.tone }} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <strong>{item.title}</strong>
                <span>{item.detail}</span>
              </span>
              <span className="today-queue-arrow" aria-hidden="true">›</span>
            </button>
          )) : (
            <div className="empty-note" style={{ padding: '14px 10px', marginTop: 8 }}>
              <strong>Everything is moving.</strong>
              No re-checks, failed exports, or waiting intakes need attention right now.
            </div>
          )}
        </div>

        {/* 1b — This week strip */}
        {thisWeek && (
          <div className="card">
            <div className="card-title">THIS WEEK<ScopeChip>CURRENT WEEK — IGNORES RANGE</ScopeChip></div>
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
          <div className="card-title">DAILY TRACKER<ScopeChip>LAST 7 DAYS — IGNORES RANGE</ScopeChip></div>
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
          <div className="card-title">EVERY RECORD BY STATUS<ScopeChip>RIGHT NOW — ALL TIME</ScopeChip></div>
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
          <div className="card-title" style={{ color: blocked.length ? 'var(--red)' : undefined }}>BLOCKED — FAILED FINAL QC<ScopeChip>RIGHT NOW</ScopeChip></div>
          {blocked.length === 0 && <div className="empty-note" style={{ padding: '10px 0 4px' }}>Nothing blocked — no open re-checks.</div>}
          {blocked.map((b) => (
            <div key={b.qcNumber} onClick={() => onOpenVehicle(b.vin, b.qcNumber)} style={{ borderTop: '1px solid #F5F1EC', padding: '10px 0', cursor: 'pointer' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <span className="mono" style={{ fontSize: 10, fontWeight: 600 }}>{b.qcNumber}</span>
                <span className="oswald" style={{ fontWeight: 600, fontSize: 13.5, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {b.stock} · {b.vehicle}
                </span>
                {b.imported && (
                  <span style={{ fontSize: 8, fontWeight: 700, color: 'var(--muted)', border: '1px solid #E4DDD3', borderRadius: 3, padding: '1px 4px', letterSpacing: 0.5 }}>
                    OLD APP
                  </span>
                )}
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

        {/* 4b — Aging / bottleneck board */}
        {dash.aging && (
          <div className="card">
            <div className="card-title">AGING — WHERE TRUCKS ARE STUCK<ScopeChip>RIGHT NOW</ScopeChip></div>
            {dash.aging.stages.map((st) => {
              const tone = (d) => (d == null ? 'var(--muted)' : d >= st.alertDays ? 'var(--red)' : d >= st.warnDays ? 'var(--amber)' : 'var(--green)');
              const worst = st.trucks.length ? st.trucks[0].days : null;
              return (
                <div key={st.key} style={{ borderTop: '1px solid #F5F1EC', padding: '9px 0' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 11.5, fontWeight: 700, flex: 1 }}>{st.label}</span>
                    {st.count > 0 && worst != null && (
                      <span style={{ fontSize: 9, fontWeight: 700, color: tone(worst) }}>oldest {worst === 0 ? 'today' : `${worst}d`}</span>
                    )}
                    <span className="oswald" style={{ fontSize: 16, fontWeight: 600, color: st.count ? tone(worst) : 'var(--muted)' }}>{st.count}</span>
                  </div>
                  {st.key === 'committedNoRo' && !dash.aging.trackerAvailable && (
                    <div style={{ fontSize: 9.5, color: 'var(--muted)', marginTop: 3 }}>Tracker offline — can't tell which trucks have an RO open.</div>
                  )}
                  {st.trucks.map((t) => (
                    <div
                      key={st.key + t.vin}
                      onClick={() => (t.qcNumber ? onOpenVehicle(t.vin, t.qcNumber) : undefined)}
                      style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginTop: 5, cursor: t.qcNumber ? 'pointer' : 'default' }}
                    >
                      <span style={{ fontSize: 10.5, fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {[t.stock, t.vehicle].filter(Boolean).join(' · ') || t.vin}
                      </span>
                      <span className="mono" style={{ fontSize: 8.5, color: 'var(--muted)', flex: '0 0 auto' }}>…{(t.vin || '').slice(-8)}</span>
                      <span style={{ fontSize: 9.5, fontWeight: 700, color: tone(t.days), flex: '0 0 auto' }}>
                        {t.days == null ? '—' : t.days === 0 ? 'today' : `${t.days}d`}
                      </span>
                    </div>
                  ))}
                  {st.count > st.trucks.length && (
                    <div style={{ fontSize: 9, color: 'var(--muted)', marginTop: 4 }}>+ {st.count - st.trucks.length} more</div>
                  )}
                </div>
              );
            })}
          </div>
        )}

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
            <AccuracyBars weeks={aiAccuracy.slice(-8)} />
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
