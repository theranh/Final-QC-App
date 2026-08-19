// Operations Handoff Workspace — Shift Handoff + Needs Attention sections.
// Designed as a self-contained module that can be added to / removed from
// DashScreen without touching any other screen logic.
//
// Props:
//   isAdmin          boolean  — from me.isAdmin
//   pendingPhotoCount number  — from photoQueue subscribePending
//   pendingCommit    boolean  — unsaved Final QC / re-check on this device

import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';

// ── helpers ───────────────────────────────────────────────────────────────────

const relTime = (ts) => {
  if (!ts) return '—';
  const diffMs = Date.now() - new Date(ts).getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 2) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.round(diffHr / 24)}d ago`;
};

const KIND_LABEL = {
  needs_wash: 'Needs wash',
  waiting_parts: 'Waiting parts',
  manager_review: 'Manager review',
  customer_vehicle: 'Customer vehicle',
  other: 'Other',
};

const SOURCE_LABEL = {
  qc: 'Final QC',
  intake: 'Intake',
  handoff: 'Handoff',
  device: 'This device',
  inspections: 'Final QC · server',
  intakes: 'Intake · server',
  sheet_export_jobs: 'Tracker export · server',
  vehicle_handoff_flags: 'Handoff flag · server',
};

function kindLabel(kind) {
  return KIND_LABEL[kind] || kind || '—';
}

function sourceLabel(source) {
  return SOURCE_LABEL[source] || source || '—';
}

// ── Needs Attention section ────────────────────────────────────────────────

function NeedsAttention({ serverItems, pendingPhotoCount, pendingCommit }) {
  const deviceItems = [];
  if (pendingCommit) {
    deviceItems.push({ key: 'pending-commit', tone: 'var(--red)', label: 'Unsaved Final QC on this device', sub: 'Use the RETRY button to push to server' });
  }
  if (pendingPhotoCount > 0) {
    deviceItems.push({ key: 'pending-photos', tone: 'var(--amber)', label: `${pendingPhotoCount} photo${pendingPhotoCount === 1 ? '' : 's'} queued for upload`, sub: 'This device — uploading in background' });
  }

  const allItems = [
    ...deviceItems,
    ...(serverItems || []).map((item) => ({
      key: [item.kind, item.flagId, item.qcNumber, item.vin].filter(Boolean).join(':'),
      tone: item.flag ? 'var(--amber)' : 'var(--muted)',
      label: [item.stock, item.vehicle].filter(Boolean).join(' · ') || item.vin,
      sub: `${sourceLabel(item.source)} — ${item.nextAction || kindLabel(item.flag)}`,
      ageDays: item.ageDays,
    })),
  ];

  return (
    <div className="card" style={{ borderLeft: '3px solid var(--amber)' }}>
      <div className="card-title" style={{ color: allItems.length ? 'var(--amber)' : undefined }}>
        NEEDS ATTENTION
        <span style={{ marginLeft: 8, fontSize: 8, fontWeight: 700, color: 'var(--muted)', background: '#F5F1EC', padding: '2px 6px', borderRadius: 4 }}>
          SERVER + THIS DEVICE
        </span>
      </div>
      {allItems.length === 0 && (
        <div className="empty-note" style={{ padding: '10px 0 4px', border: 'none', textAlign: 'left', fontSize: 11 }}>
          Nothing needs attention right now.
        </div>
      )}
      {allItems.map((item) => (
        <div key={item.key} style={{ borderTop: '1px solid #F5F1EC', padding: '9px 0', display: 'flex', alignItems: 'flex-start', gap: 9 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: item.tone, flex: '0 0 auto', marginTop: 4 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</div>
            <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>{item.sub}</div>
          </div>
          {item.ageDays != null && (
            <span style={{ fontSize: 9, fontWeight: 700, color: item.ageDays > 3 ? 'var(--red)' : 'var(--muted)', flex: '0 0 auto' }}>
              {item.ageDays === 0 ? 'today' : `${item.ageDays}d`}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Shift Handoff section ─────────────────────────────────────────────────

function ShiftHandoff({ items, generatedAt }) {
  if (!items) {
    return (
      <div className="card">
        <div className="card-title">SHIFT HANDOFF</div>
        <div className="empty-note" style={{ padding: '10px 0 4px', border: 'none', textAlign: 'left', fontSize: 11 }}>
          Loading handoff data…
        </div>
      </div>
    );
  }
  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <div className="card-title">SHIFT HANDOFF</div>
        {generatedAt && (
          <span className="mono" style={{ fontSize: 8.5, color: 'var(--muted)', marginLeft: 'auto' }}>
            {new Date(generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
          </span>
        )}
      </div>
      {items.length === 0 && (
        <div className="empty-note" style={{ padding: '10px 0 4px', border: 'none', textAlign: 'left', fontSize: 11 }}>
          No active work items for the shift handoff.
        </div>
      )}
      {items.map((item) => (
        <div key={item.vin + (item.qcNumber || '')} style={{ borderTop: '1px solid #F5F1EC', padding: '9px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {[item.stock, item.vehicle].filter(Boolean).join(' · ') || item.vin}
              </div>
              <div style={{ fontSize: 9.5, color: 'var(--muted)', marginTop: 2 }}>
                <span className="mono">{item.qcNumber || '—'}</span>
                {item.lastActor && <span> · {item.lastActor}</span>}
                {item.lastAt && <span> · {relTime(item.lastAt)}</span>}
              </div>
            </div>
            {item.flag && (
              <span style={{ fontSize: 8.5, fontWeight: 700, color: '#fff', background: 'var(--amber)', padding: '2px 7px', borderRadius: 4, flex: '0 0 auto' }}>
                {kindLabel(item.flag)}
              </span>
            )}
            {item.ageDays != null && (
              <span style={{ fontSize: 9, fontWeight: 700, color: item.ageDays > 3 ? 'var(--red)' : 'var(--muted)', flex: '0 0 auto' }}>
                {item.ageDays === 0 ? 'today' : `${item.ageDays}d`}
              </span>
            )}
          </div>
          {item.nextAction && (
            <div style={{ fontSize: 10.5, color: 'var(--brown)', marginTop: 4, fontWeight: 600 }}>
              Next: {item.nextAction}
            </div>
          )}
          {item.flag && (
            <div style={{ fontSize: 10, color: 'var(--amber)', marginTop: 3, fontWeight: 600 }}>
              Flag: {kindLabel(item.flag)}{item.flagNote ? ` — ${item.flagNote}` : ''}
            </div>
          )}
          {item.source && (
            <div style={{ fontSize: 9, color: 'var(--muted)', marginTop: 2 }}>
              Source: {sourceLabel(item.source)}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────

export default function HandoffWorkspace({ isAdmin, pendingPhotoCount, pendingCommit }) {
  const [handoff, setHandoff] = useState(null);
  const [error, setError] = useState(null);
  const [collapsed, setCollapsed] = useState(false);

  const load = useCallback(() => {
    setError(null);
    api.collabHandoff()
      .then((d) => setHandoff(d))
      .catch((err) => setError(err.message || 'Could not load handoff data'));
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 60000);
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(id); window.removeEventListener('focus', onFocus); };
  }, [load]);

  // Accept the original combined contract as well as the current source-specific
  // arrays. Keeping this normalization here makes the dashboard module removable
  // without coupling the rest of the app to collaboration response details.
  const normalize = (item) => ({
    ...item,
    lastAt: item.lastAt ?? item.lastActorAt ?? null,
    flag: item.flag ?? item.flagKind ?? null,
  });
  const activeFlags = handoff?.activeFlags || [];
  const flagByVin = new Map(activeFlags.map((flag) => [flag.vin, flag]));
  const decorate = (item) => {
    const normalized = normalize(item);
    const activeFlag = flagByVin.get(normalized.vin);
    return activeFlag
      ? { ...normalized, flag: normalized.flag || activeFlag.flagKind, flagNote: activeFlag.note || null }
      : normalized;
  };
  const awaiting = handoff?.awaitingFinalQc || [];
  const stale = handoff?.staleIntakes || [];
  const rechecks = handoff?.openRechecks || [];
  const activeWork = handoff
    ? (handoff.activeWork ?? [...awaiting, ...stale, ...rechecks]).map(decorate)
    : null;
  const attention = handoff
    ? (handoff.attention ?? [
        ...(handoff.failedExports || []),
        ...activeFlags,
        ...stale,
        ...awaiting.filter((item) => item.ageDays != null && item.ageDays >= 2),
        ...rechecks.filter((item) => item.ageDays != null && item.ageDays >= 3),
      ]).map(normalize)
    : [];

  return (
    <div>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, cursor: 'pointer', minHeight: 44 }}
        onClick={() => setCollapsed((c) => !c)}
        role="button"
        aria-expanded={!collapsed}
        aria-label="Toggle handoff workspace"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setCollapsed((c) => !c); }}
      >
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.8, color: 'var(--muted)', flex: 1 }}>
          OPERATIONS HANDOFF WORKSPACE
        </span>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>{collapsed ? '+ show' : '- hide'}</span>
      </div>
      {!collapsed && (
        <>
          {error && (
            <div style={{ fontSize: 11, color: 'var(--red)', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '8px 10px', marginBottom: 8 }}>
              Handoff: {error}{' '}
              <button
                onClick={load}
                style={{ background: 'none', border: 'none', color: 'var(--red)', fontWeight: 700, cursor: 'pointer', textDecoration: 'underline', padding: 0, fontSize: 11 }}
              >
                Retry
              </button>
            </div>
          )}
          <ShiftHandoff
            items={activeWork}
            generatedAt={handoff?.generatedAt}
          />
          <div style={{ marginTop: 8 }}>
            <NeedsAttention
              serverItems={attention}
              pendingPhotoCount={pendingPhotoCount}
              pendingCommit={pendingCommit}
            />
          </div>
        </>
      )}
    </div>
  );
}
