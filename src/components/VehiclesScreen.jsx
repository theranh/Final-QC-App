// Vehicles tab — two buckets: In-Take Quotes (completed intake, no inspection yet)
// and Completed QC's (every vehicle with an inspection). Searchable by stock # or
// VIN. All figures come from /api/dashboard (server-computed); this screen only renders.

import { useEffect, useMemo, useRef, useState } from 'react';
import { RecentQuoteCard } from './IntakeScreen';
import GlobalSearchResults from './GlobalSearch';
import SavedViews from './SavedViews';
import PinDialog from './PinDialog';
import { api } from '../lib/api';
import PhotoButton from './PhotoButton';

const FILTERS = [
  ['awaitingFinalQc', 'In-Take Quotes'],
  ['completed', "Completed QC's"],
];

const STATUS_META = {
  openRecheck: { label: 'OPEN RE-CHECK', bg: 'var(--amber)' },
  frontlineReady: { label: 'FRONTLINE READY', bg: 'var(--green)' },
  released: { label: 'RELEASED', bg: 'var(--muted)' },
};

const usd = (v) =>
  v == null ? null : '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 });


// Green <3 days, yellow 3–6, red 7+.


// "mike smith" → "Mike Smith" (also after hyphens: "mary-jo" → "Mary-Jo").
const titleCaseName = (s) => s.replace(/(^|[\s-])([a-zà-ö])/g, (m, sep, ch) => sep + ch.toUpperCase());

const REVEAL_PX = 82;
const SWIPE_THRESHOLD = 42;

function SwipeDeleteRow({ children, onDelete, label }) {
  const [offset, setOffset] = useState(0);
  const drag = useRef(null);
  const suppressClick = useRef(false);

  const pointerDown = (e) => {
    if (e.button != null && e.button !== 0) return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, start: offset, horizontal: false };
  };
  const pointerMove = (e) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.horizontal) {
      if (Math.abs(dx) < 7) return;
      if (Math.abs(dy) > Math.abs(dx)) {
        drag.current = null;
        return;
      }
      d.horizontal = true;
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
    setOffset(Math.max(-REVEAL_PX, Math.min(0, d.start + dx)));
  };
  const pointerEnd = (e) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    if (d.horizontal) {
      const moved = Math.abs(e.clientX - d.x);
      suppressClick.current = moved >= 7;
      setOffset(d.start + (e.clientX - d.x) < -SWIPE_THRESHOLD ? -REVEAL_PX : 0);
    }
    drag.current = null;
  };
  const captureClick = (e) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (offset) {
      e.preventDefault();
      e.stopPropagation();
      setOffset(0);
    }
  };

  return (
    <div
      data-testid="swipe-vehicle-shell"
      style={{
        position: 'relative',
        overflow: 'hidden',
        borderRadius: 10,
        width: '100%',
        minWidth: 0,
        flex: '0 0 auto',
      }}
    >
      <button
        type="button"
        aria-label={`Delete ${label}`}
        onClick={onDelete}
        style={{
          position: 'absolute', inset: '0 0 0 auto', width: REVEAL_PX, border: 0,
          background: 'var(--red)', color: '#fff', fontWeight: 800, cursor: 'pointer',
        }}
      >
        Delete
      </button>
      <div
        data-testid="swipe-vehicle-row"
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerEnd}
        onPointerCancel={pointerEnd}
        onClickCapture={captureClick}
        style={{
          position: 'relative', zIndex: 1, transform: `translateX(${offset}px)`,
          transition: drag.current?.horizontal ? 'none' : 'transform 160ms ease',
          touchAction: 'pan-y', background: '#fff',
        }}
      >
        {children}
      </div>
    </div>
  );
}

function fallbackVehicle(record) {
  const qcNumber = String(record?.qcNumber || record?.id || '');
  const createdTs = Number(record?.clearedTs ?? record?.ts ?? record?.createdAt ?? 0) || 0;
  return {
    vin: record?.vin || '',
    stock: record?.stock || '',
    vehicle: record?.vehicle || '',
    qcNumber,
    result: record?.result || '',
    status: record?.status || '',
    statusKey: record?.status === 'open' ? 'openRecheck' : 'frontlineReady',
    inspector: record?.inspector || '',
    imported: !!record?.imported,
    createdTs,
    finalizedTs: createdTs,
    segments: [],
    itemCount: Array.isArray(record?.openItems) ? record.openItems.length : 0,
    note: '',
    daysInProduction: null,
    quote: null,
    tracker: null,
    intake: null,
  };
}

export default function VehiclesScreen({ dash, records = [], filter, onFilter, q, onQ, onOpenIntake, onOpenRecord, onOpenQuote, onOpenLightbox, onDeleted }) {
  // Any non-intake filter value (old saved states like 'all', 'released', …)
  // falls into the Completed QC's bucket.
  const bucket = filter === 'awaitingFinalQc' ? 'awaitingFinalQc' : 'completed';
  // Filter-by-person selection, cleared whenever the bucket changes so a name
  // from one bucket never leaks into the other (In-Take → estimator, Completed
  // QC's → inspector).
  const [person, setPerson] = useState('');
  const [deleteTarget, setDeleteTarget] = useState(null);

  // Saved-view apply: update bucket, person, and q together
  const handleApplyView = ({ bucket: b, person: p, q: newQ }) => {
    if (b !== filter) { setPerson(''); onFilter(b); }
    setPerson(p || '');
    onQ(newQ || '');
  };
  // The bootstrap inspection list is authoritative and loads independently of
  // dashboard enrichment (tracker, quote, and intake metadata). Keep every
  // active completed inspection visible if the dashboard request is delayed or
  // temporarily fails during a publish, then replace its fallback card with the
  // enriched dashboard card when that payload arrives.
  const vehicles = useMemo(() => {
    const byQc = new Map((dash?.vehicles || []).map((vehicle) => [vehicle.qcNumber, vehicle]));
    for (const record of records) {
      if (record?.archived) continue;
      const qcNumber = String(record?.qcNumber || record?.id || '');
      if (qcNumber && !byQc.has(qcNumber)) byQc.set(qcNumber, fallbackVehicle(record));
    }
    return [...byQc.values()];
  }, [dash, records]);
  const needle = q.trim().toUpperCase();

  // Names present in the current bucket (estimators for In-Take, inspectors for
  // Completed QC's), for the dropdown. Sorted, de-duped, non-empty.
  const people = useMemo(() => {
    const src = bucket === 'awaitingFinalQc' ? dash?.awaiting || [] : vehicles;
    const key = bucket === 'awaitingFinalQc' ? 'estimator' : 'inspector';
    // Keyed by lowercase so "mike" and "Mike" collapse to one entry, always
    // displayed in Title Case.
    const names = new Map();
    for (const r of src) {
      const name = titleCaseName((r[key] || '').trim());
      if (name && !names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
    }
    return [...names.values()].sort((a, b) => a.localeCompare(b));
  }, [dash, bucket, vehicles]);

  // If a data refresh drops the selected name from the current bucket, clear the
  // selection so the list isn't silently filtered down to nothing.
  useEffect(() => {
    if (person && !people.includes(person)) setPerson('');
  }, [person, people]);

  const matchPerson = (r, key) => !person || (r[key] || '').trim().toLowerCase() === person.toLowerCase();

  const list = vehicles.filter((v) => {
    if (!matchPerson(v, 'inspector')) return false;
    if (!needle) return true;
    return (v.stock || '').toUpperCase().includes(needle) || (v.vin || '').toUpperCase().includes(needle);
  }).sort((a, b) => (b.finalizedTs ?? b.createdTs ?? 0) - (a.finalizedTs ?? a.createdTs ?? 0)); // newest first
  // Awaiting Final QC = completed intake, no inspection yet — server-composed
  // list from this app's local intakes table.
  const awaiting = (dash?.awaiting || []).filter((v) => {
    if (!matchPerson(v, 'estimator')) return false;
    if (!needle) return true;
    return (v.stock || '').toUpperCase().includes(needle) || (v.vin || '').toUpperCase().includes(needle);
  }).sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0)); // newest first

  const setBucket = (k) => {
    setPerson('');
    onFilter(k);
  };

  const retire = async ({ signerId, pin }) => {
    await api.retireVehicle({
      kind: deleteTarget.kind,
      recordId: deleteTarget.recordId,
      signerId,
      pin,
    });
    setDeleteTarget(null);
    await onDeleted?.();
  };

  return (
    <div className="screen">
      <div className="screen-topbar" style={{ padding: '8px 14px 10px' }}>
        <div className="screen-title-row">
          <span className="screen-title">Vehicles</span>
          <span className="mono" style={{ fontSize: 9.5, color: 'var(--muted)' }}>
            {(bucket === 'awaitingFinalQc' ? awaiting.length : list.length)} shown
          </span>
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8, overflowX: 'auto', paddingBottom: 4 }}>
          {FILTERS.map(([k, label]) => (
            <span key={k} className={'pill-btn' + (bucket === k ? ' on red' : '')} onClick={() => setBucket(k)} style={{ whiteSpace: 'nowrap' }}>
              {label}
            </span>
          ))}
        </div>
        {people.length > 0 && (
          <select
            className="input"
            style={{ marginTop: 8 }}
            value={person}
            onChange={(e) => setPerson(e.target.value)}
          >
            <option value="">
              {bucket === 'awaitingFinalQc' ? 'All estimators' : 'All inspectors'}
            </option>
            {people.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        )}
        <input
          className="input"
          style={{ marginTop: 8, textTransform: 'uppercase' }}
          placeholder="Search stock # or VIN…"
          autoCapitalize="characters"
          value={q}
          onChange={(e) => onQ(e.target.value.toUpperCase())}
        />
        <SavedViews bucket={bucket} person={person} q={q} onApply={handleApplyView} />
      </div>
      <div className="screen-body">
        {!dash && bucket === 'awaitingFinalQc' && <div className="empty-note">Loading vehicles…</div>}
        {dash && bucket === 'awaitingFinalQc' && awaiting.length === 0 && (
          <div className="empty-note">No in-take quotes are waiting for QC{needle ? ' that match' : ''}.</div>
        )}
        {bucket === 'awaitingFinalQc' &&
          awaiting.map((v) => (
            <SwipeDeleteRow
              key={v.intakeId}
              label={v.stock || v.vin || 'intake'}
              onDelete={() => setDeleteTarget({
                kind: 'intake',
                recordId: v.intakeId,
                label: v.stock || v.vin || 'Intake',
              })}
            >
              <RecentQuoteCard quote={v} badge={v.inProgress ? 'IN PROGRESS' : undefined} onClick={() => onOpenIntake(v)} onOpenCover={onOpenLightbox} />
            </SwipeDeleteRow>
          ))}
        {bucket === 'completed' && list.length === 0 && (
          <div className="empty-note">No completed QC's{needle ? ' match' : ' yet'}.</div>
        )}
        {bucket === 'completed' &&
          list.map((v) => {
            const sm = STATUS_META[v.statusKey] || STATUS_META.frontlineReady;
            const quoteSummary = v.quote
              ? [
                  v.quote.hrs != null ? `${v.quote.hrs} hrs` : null,
                  v.quote.usd != null ? usd(v.quote.usd) : null,
                  v.quote.lineCount != null ? `${v.quote.lineCount} line${v.quote.lineCount === 1 ? '' : 's'}` : null,
                ].filter(Boolean).join(' · ')
              : 'Quote unavailable';
            const trackerSummary =
              v.tracker && (v.tracker.retailPlan != null || v.tracker.closedRO != null)
                ? [
                    v.tracker.retailPlan != null ? `${usd(v.tracker.retailPlan)} plan` : null,
                    v.tracker.closedRO != null ? `${usd(v.tracker.closedRO)} closed` : null,
                  ].filter(Boolean).join(' · ')
                : null;
            return (
              <SwipeDeleteRow
                key={v.qcNumber}
                label={v.stock || v.vin || v.qcNumber}
                onDelete={() => setDeleteTarget({
                  kind: 'inspection',
                  recordId: v.qcNumber,
                  label: v.stock || v.vin || v.qcNumber,
                })}
              >
                <div style={{ width: '100%', textAlign: 'left', background: '#fff', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px', color: 'inherit', display: 'flex', gap: 11, alignItems: 'center' }}>
                  {v.cover ? (
                    <PhotoButton
                      src={v.cover}
                      alt={`${v.vehicle || v.stock || 'Completed vehicle'} cover photo`}
                      onOpen={onOpenLightbox}
                      style={{ flex: '0 0 auto' }}
                      imageClassName="completed-vehicle-cover"
                      imageStyle={{ width: 46, height: 46, borderRadius: 8, objectFit: 'cover', border: '1px solid var(--border)' }}
                    />
                  ) : (
                    <div data-testid="completed-vehicle-cover-placeholder" style={{ width: 46, height: 46, borderRadius: 8, flex: '0 0 auto', background: 'var(--panel)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted2)', fontSize: 18 }}>🚚</div>
                  )}
                  <button
                    type="button"
                    aria-label={`Open ${v.vehicle || v.stock || v.qcNumber} details`}
                    onClick={() => v.intake ? onOpenIntake(v) : onOpenRecord(v.qcNumber)}
                    style={{ flex: 1, minWidth: 0, padding: 0, border: 0, background: 'transparent', color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer' }}
                  >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span className="oswald" style={{ fontWeight: 600, fontSize: 14, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {v.stock || 'NO STOCK #'} · {v.vehicle || 'Vehicle not recorded'}
                  </span>
                  <span style={{ fontSize: 8.5, fontWeight: 700, color: '#fff', background: sm.bg, padding: '2px 7px', borderRadius: 4, flex: '0 0 auto' }}>{sm.label}</span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px 9px', marginTop: 4, alignItems: 'baseline' }}>
                  <span className="mono" style={{ fontSize: 9.5, color: 'var(--muted)', wordBreak: 'break-all' }}>{v.vin || 'VIN unavailable'}</span>
                  <span className="mono" style={{ fontSize: 9.5, color: 'var(--muted)' }}>{v.qcNumber}</span>
                  {v.inspector && <span style={{ fontSize: 9.5, color: 'var(--muted)' }}>Inspector: {titleCaseName(v.inspector)}</span>}
                  {v.intake?.estimator && <span style={{ fontSize: 9.5, color: 'var(--muted)' }}>Estimator: {titleCaseName(v.intake.estimator)}</span>}
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: 9.5, fontWeight: 600, color: 'var(--muted)' }}>
                    {v.daysInProduction != null ? `${v.daysInProduction}d in production` : 'days n/a'}
                  </span>
                </div>
                <div style={{ fontSize: 10.5, fontWeight: 600, marginTop: 5, color: 'var(--brown)' }}>{quoteSummary}</div>
                {trackerSummary && <div style={{ fontSize: 10, marginTop: 3, color: 'var(--muted)' }}>{trackerSummary}</div>}
                <div style={{ display: 'flex', gap: 10, marginTop: 4, fontSize: 9.5, color: 'var(--muted)' }}>
                  <span>{v.itemCount || 0} QC issue{v.itemCount === 1 ? '' : 's'}</span>
                  <span>{v.intake ? 'Tap for intake details + walk-around photos' : 'Digital intake unavailable · tap for full QC record'}</span>
                  </div>
                  </button>
                </div>
              </SwipeDeleteRow>
            );
          })}
        {/* Global search: everything the two dash buckets above can't show —
            archived QC records, historical inspections, quote-only trucks.
            Only rendered while the user is actually searching. */}
        {needle.length >= 2 && (
          <GlobalSearchResults
            query={needle}
            excludeVins={new Set([
              ...(bucket === 'completed' ? list : awaiting).map((v) => v.vin),
            ])}
            onOpenRecord={onOpenRecord}
            onOpenIntake={onOpenIntake}
            onOpenQuote={onOpenQuote}
          />
        )}
      </div>
      {deleteTarget && (
        <PinDialog
          title="Delete vehicle"
          subtitle={`${deleteTarget.label} · history and galleries will be retained`}
          adminOnly
          confirmLabel="Delete from Vehicles"
          busyLabel="Deleting…"
          onClose={() => setDeleteTarget(null)}
          onCommit={retire}
        />
      )}
    </div>
  );
}
