// Activity timeline and quick-flag panel for RecordDetail and VehicleCard.
// Fetches timeline events and active flags for a given VIN (+ optional QC#).
// Allows adding one of the predefined flag kinds (with optional note) and
// clearing/deleting active flags. All API errors are shown inline.

import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { fmtDT } from '../lib/format';

const FLAG_KINDS = [
  ['needs_wash', 'Needs wash'],
  ['waiting_parts', 'Waiting parts'],
  ['manager_review', 'Manager review'],
  ['customer_vehicle', 'Customer vehicle'],
  ['other', 'Other'],
];

const EVENT_ACTION_LABEL = {
  created: 'Final QC committed',
  inspection_created: 'Final QC committed',
  inspection_cleared: 'Final QC cleared',
  recheck_committed: 'Re-check committed',
  flag_added: 'Flag added',
  flag_cleared: 'Flag cleared',
  intake_created: 'Intake started',
  intake_completed: 'Intake completed',
  quote_updated: 'Body quote saved',
  quote_committed: 'Body quote committed',
  photos_uploaded: 'Photos available on server',
  export_pending: 'Tracker export queued',
  export_done: 'Tracker export completed',
  export_failed: 'Tracker export failed',
  bulk_archived: 'Archived by manager',
  bulk_unarchived: 'Unarchived by manager',
};

const EVENT_SOURCE_LABEL = {
  inspections: 'Final QC record',
  intakes: 'Intake record',
  quotes: 'Body quote',
  quote_snapshots: 'Signed quote snapshot',
  photos: 'Server photo store',
  audit_log: 'Audit log',
  sheet_export_jobs: 'Tracker export queue',
  vehicle_activity_events: 'Handoff activity',
};

function fmtEventAction(action) {
  if (!action) return '—';
  const plain = action.startsWith('audit_') ? action.slice(6) : action;
  return EVENT_ACTION_LABEL[action]
    || EVENT_ACTION_LABEL[plain]
    || plain.replaceAll('_', ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
}

export default function ActivityTimeline({ vin, qcNumber }) {
  const [events, setEvents] = useState(null);   // null = loading
  const [flags, setFlags] = useState(null);
  const [loadError, setLoadError] = useState(null);

  // Add-flag form state
  const [addingKind, setAddingKind] = useState('');
  const [addingNote, setAddingNote] = useState('');
  const [addBusy, setAddBusy] = useState(null); // kind string while posting
  const [addError, setAddError] = useState(null);
  const [deleteError, setDeleteError] = useState(null);
  const [deletingId, setDeletingId] = useState(null);

  const load = useCallback(() => {
    if (!vin) return;
    setLoadError(null);
    api.collabTimeline(vin)
      .then((d) => {
        setEvents(d.events || []);
        setFlags(d.flags || []);
      })
      .catch((err) => setLoadError(err.message || 'Could not load timeline'));
  }, [vin]);

  useEffect(() => { load(); }, [load]);

  const handleAddFlag = () => {
    if (!addingKind || addBusy) return;
    setAddBusy(addingKind);
    setAddError(null);
    api.addCollabFlag({ vin, qcNumber: qcNumber || undefined, kind: addingKind, note: addingNote.trim() || undefined })
      .then(() => {
        setAddingKind('');
        setAddingNote('');
        load();
      })
      .catch((err) => setAddError(err.message || 'Could not add flag'))
      .finally(() => setAddBusy(null));
  };

  const handleDeleteFlag = (id) => {
    if (!window.confirm('Remove this flag?')) return;
    setDeletingId(id);
    setDeleteError(null);
    api.deleteCollabFlag(id)
      .then(() => load())
      .catch((err) => setDeleteError(err.message || 'Could not remove flag'))
      .finally(() => setDeletingId(null));
  };

  if (!vin) return null;

  return (
    <div className="card">
      <div className="card-title">ACTIVITY TIMELINE & FLAGS</div>

      {/* Active flags */}
      {flags && flags.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {deleteError && (
            <div style={{ fontSize: 10.5, color: 'var(--red)', marginBottom: 6 }}>Error: {deleteError}</div>
          )}
          {flags.map((f) => (
            <div
              key={f.id}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', borderTop: '1px solid #F5F1EC' }}
            >
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--amber)', flex: '0 0 auto' }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 11.5, fontWeight: 700 }}>
                  {FLAG_KINDS.find(([k]) => k === f.kind)?.[1] || f.kind}
                </span>
                {f.note && (
                  <span style={{ fontSize: 10, color: 'var(--muted)', marginLeft: 6 }}>— {f.note}</span>
                )}
                {(f.creatorName || f.actor) && (
                  <div style={{ fontSize: 9, color: 'var(--muted)', marginTop: 2 }}>
                    Added by {f.creatorName || f.actor}
                  </div>
                )}
              </div>
              <button
                aria-label="Remove flag"
                disabled={deletingId === f.id}
                onClick={() => handleDeleteFlag(f.id)}
                style={{ height: 44, minWidth: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: '1px solid var(--border)', borderRadius: 8, cursor: 'pointer', fontSize: 11, color: 'var(--red)', fontWeight: 700, padding: '0 10px' }}
              >
                {deletingId === f.id ? '…' : 'Clear'}
              </button>
            </div>
          ))}
        </div>
      )}
      {flags && flags.length === 0 && (
        <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 6 }}>No active flags.</div>
      )}
      {!flags && !loadError && (
        <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 6 }}>Loading…</div>
      )}

      {/* Add flag */}
      <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #F5F1EC' }}>
        <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--muted)', marginBottom: 6, letterSpacing: 0.6 }}>ADD FLAG</div>
        {addError && (
          <div style={{ fontSize: 10.5, color: 'var(--red)', marginBottom: 6 }}>Error: {addError}</div>
        )}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
          {FLAG_KINDS.map(([kind, label]) => (
            <button
              key={kind}
              aria-pressed={addingKind === kind}
              onClick={() => setAddingKind(addingKind === kind ? '' : kind)}
              style={{
                height: 44, padding: '0 12px', border: '1px solid var(--border)', borderRadius: 8, cursor: 'pointer',
                background: addingKind === kind ? 'var(--amber)' : '#fff',
                color: addingKind === kind ? '#fff' : 'var(--brown)',
                fontWeight: 700, fontSize: 11,
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {addingKind && (
          <>
            <input
              className="input"
              style={{ marginBottom: 8, height: 44, fontSize: 13 }}
              placeholder="Optional note…"
              value={addingNote}
              onChange={(e) => setAddingNote(e.target.value)}
              maxLength={200}
            />
            <button
              onClick={handleAddFlag}
              disabled={!!addBusy}
              aria-busy={!!addBusy}
              style={{ height: 44, width: '100%', background: 'var(--amber)', color: '#fff', border: 'none', borderRadius: 9, fontWeight: 700, fontSize: 13, cursor: addBusy ? 'not-allowed' : 'pointer' }}
            >
              {addBusy ? 'Adding…' : `Add — ${FLAG_KINDS.find(([k]) => k === addingKind)?.[1]}`}
            </button>
          </>
        )}
      </div>

      {/* Timeline events */}
      <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #F5F1EC' }}>
        <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--muted)', marginBottom: 6, letterSpacing: 0.6 }}>HISTORY</div>
        {loadError && (
          <div style={{ fontSize: 10.5, color: 'var(--red)', marginBottom: 6 }}>
            {loadError}{' '}
            <button
              onClick={load}
              style={{ background: 'none', border: 'none', color: 'var(--red)', fontWeight: 700, cursor: 'pointer', textDecoration: 'underline', padding: 0, fontSize: 10.5 }}
            >
              Retry
            </button>
          </div>
        )}
        {events && events.length === 0 && (
          <div className="empty-note" data-testid="timeline-empty" style={{ padding: '8px 0 2px', border: 'none', textAlign: 'left', fontSize: 10.5 }}>
            No activity recorded yet.
          </div>
        )}
        {events && events.map((ev, i) => {
          const action = ev.eventType || ev.action;
          const at = ev.occurredAt || ev.at;
          const note = ev.note || ev.details?.note || ev.details?.lastError;
          return (
          <div
            key={[action, at, ev.source, ev.qcNumber, i].filter(Boolean).join(':')}
            style={{ display: 'flex', gap: 8, padding: '7px 0', borderTop: i === 0 ? 'none' : '1px solid #F5F1EC', alignItems: 'flex-start' }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <span style={{ fontSize: 11.5, fontWeight: 700 }}>{fmtEventAction(action)}</span>
              {ev.actor && <span style={{ fontSize: 10, color: 'var(--muted)', marginLeft: 6 }}>{ev.actor}</span>}
              {note && <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 2, fontStyle: 'italic' }}>"{note}"</div>}
              {ev.source && (
                <div style={{ fontSize: 8.5, color: 'var(--muted)', marginTop: 2 }}>
                  Source: {EVENT_SOURCE_LABEL[ev.source] || ev.source}
                </div>
              )}
            </div>
            {at ? (
              <span className="mono" style={{ fontSize: 9, color: 'var(--muted)', flex: '0 0 auto', paddingTop: 2 }}>
                {fmtDT(at)}
              </span>
            ) : (
              <span className="mono" style={{ fontSize: 8.5, color: 'var(--muted)', flex: '0 0 auto', paddingTop: 2 }}>
                Date unknown
              </span>
            )}
          </div>
          );
        })}
        {!events && !loadError && (
          <div style={{ fontSize: 10, color: 'var(--muted)' }}>Loading history…</div>
        )}
      </div>
    </div>
  );
}
