import { useState } from 'react';
import { fmtDT, csvEsc, download, fileStamp } from '../lib/format';
import { filterRecords, statusMeta } from '../lib/records';
import { api } from '../lib/api';

const RES_CHIPS = [
  ['all', 'All'],
  ['pass', 'Pass'],
  ['fail', 'Fail / open'],
];

// ── local CSV export of selected records ──────────────────────────────────

function exportSelectedCsv(recs) {
  if (!recs.length) return;
  const esc = csvEsc;
  const rows = [
    ['ID', 'Date', 'VIN', 'Stock #', 'Vehicle', 'Inspector', 'Title', 'Status', 'Items checked', 'Failed items', 'Archived'].map(esc).join(','),
    ...recs.map((r) => {
      const sm = statusMeta(r);
      return [r.id, fmtDT(r.ts), r.vin || '', r.stock, r.vehicle, r.inspector, r.title, sm.txt, r.checked, r.failCount || 0, r.archived ? 'Yes' : 'No'].map(esc).join(',');
    }),
  ];
  download('TruckRanch_Selected_' + fileStamp() + '.csv', '\uFEFF' + rows.join('\r\n'), 'text/csv;charset=utf-8');
}

// ── BulkActions bar ───────────────────────────────────────────────────────

function BulkActionsBar({ selected, allFiltered, onSelectAll, onClearAll, onBulkArchive, onBulkUnarchive, onExportCsv, busy }) {
  const count = selected.size;
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '8px 14px', background: '#FBF3E4', borderBottom: '1px solid var(--border)', alignItems: 'center' }}>
      <span style={{ fontSize: 11, fontWeight: 700, flex: '0 0 auto' }}>
        {count} selected
      </span>
      <button
        onClick={onSelectAll}
        style={{ height: 36, padding: '0 10px', background: '#fff', border: '1px solid var(--border)', borderRadius: 8, cursor: 'pointer', fontSize: 11, fontWeight: 700, color: 'var(--brown)' }}
      >
        All {allFiltered.length}
      </button>
      <button
        onClick={onClearAll}
        style={{ height: 36, padding: '0 10px', background: '#fff', border: '1px solid var(--border)', borderRadius: 8, cursor: 'pointer', fontSize: 11, fontWeight: 700, color: 'var(--muted)' }}
      >
        Clear
      </button>
      <span style={{ flex: 1 }} />
      <button
        disabled={count === 0 || busy}
        onClick={onBulkArchive}
        style={{ height: 36, padding: '0 10px', background: count > 0 && !busy ? 'var(--brown)' : 'var(--disabled)', color: '#fff', border: 'none', borderRadius: 8, cursor: count > 0 && !busy ? 'pointer' : 'not-allowed', fontSize: 11, fontWeight: 700 }}
      >
        Archive {count > 0 ? `(${count})` : ''}
      </button>
      <button
        disabled={count === 0 || busy}
        onClick={onBulkUnarchive}
        style={{ height: 36, padding: '0 10px', background: count > 0 && !busy ? 'var(--green)' : 'var(--disabled)', color: '#fff', border: 'none', borderRadius: 8, cursor: count > 0 && !busy ? 'pointer' : 'not-allowed', fontSize: 11, fontWeight: 700 }}
      >
        Unarchive {count > 0 ? `(${count})` : ''}
      </button>
      <button
        disabled={count === 0}
        onClick={onExportCsv}
        style={{ height: 36, padding: '0 10px', background: '#fff', border: '1px solid var(--border)', borderRadius: 8, cursor: count > 0 ? 'pointer' : 'not-allowed', fontSize: 11, fontWeight: 700, color: 'var(--brown)' }}
      >
        Export CSV
      </button>
    </div>
  );
}

// ── BulkResults modal ─────────────────────────────────────────────────────

function BulkResultsModal({ results, onClose }) {
  if (!results) return null;
  const success = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Bulk action results"
      style={{ position: 'fixed', inset: 0, background: 'rgba(38,34,32,.6)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={onClose}
    >
      <div
        style={{ background: '#fff', borderRadius: 14, padding: 20, maxWidth: 380, width: '100%', maxHeight: '80vh', overflowY: 'auto' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <span style={{ fontSize: 13, fontWeight: 700, flex: 1 }}>Bulk action complete</span>
          <button onClick={onClose} className="dialog-close" aria-label="Close results">x</button>
        </div>
        {success.length > 0 && (
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--green)', letterSpacing: 0.6, marginBottom: 4 }}>COMPLETED ({success.length})</div>
            {success.map((r) => (
              <div key={r.qcNumber} style={{ fontSize: 11.5, color: 'var(--green)', padding: '3px 0' }}>
                {r.qcNumber}{r.status === 'already' ? ' — already in that state' : ''}
              </div>
            ))}
          </div>
        )}
        {failed.length > 0 && (
          <div>
            <div style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--red)', letterSpacing: 0.6, marginBottom: 4 }}>FAILED ({failed.length})</div>
            {failed.map((r) => (
              <div key={r.qcNumber} style={{ fontSize: 11.5, color: 'var(--red)', padding: '3px 0' }}>
                {r.qcNumber}{r.error ? ` — ${r.error}` : ''}
              </div>
            ))}
          </div>
        )}
        <button
          onClick={onClose}
          style={{ marginTop: 16, height: 44, width: '100%', background: 'var(--brown)', color: '#fff', border: 'none', borderRadius: 10, fontWeight: 700, fontSize: 13, cursor: 'pointer' }}
        >
          Done
        </button>
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export default function RecordsList({ recs, q, onQ, fRes, onFRes, fFrom, onFFrom, fTo, onFTo, onOpenRecord, isAdmin = false, onBulkDone }) {
  const filtered = filterRecords(recs, { q, fRes, fFrom, fTo });

  // Selection mode (admin only)
  const [selMode, setSelMode] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [bulkResults, setBulkResults] = useState(null);
  const [bulkError, setBulkError] = useState(null);

  const toggleSelect = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < 100) next.add(id);
      return next;
    });
  };

  const exitSelMode = () => { setSelMode(false); setSelected(new Set()); };

  const handleBulkOp = (archived) => {
    const ids = [...selected];
    if (!ids.length) return;
    const action = archived ? 'archive' : 'unarchive';
    if (!window.confirm(`${action.charAt(0).toUpperCase() + action.slice(1)} ${ids.length} record${ids.length === 1 ? '' : 's'}? This changes dashboard visibility.`)) return;
    setBusy(true);
    setBulkError(null);
    api.bulkArchive(ids, archived)
      .then((res) => {
        const raw = Array.isArray(res) ? res : (res?.results || []);
        setBulkResults(raw.map((item) => ({
          qcNumber: item.qcNumber,
          status: item.result,
          ok: item.ok ?? item.result !== 'not_found',
          error: item.error || (item.result === 'not_found' ? 'Record not found' : undefined),
        })));
        setSelected(new Set());
        onBulkDone?.();
      })
      .catch((err) => setBulkError(err.message || 'Bulk operation failed'))
      .finally(() => setBusy(false));
  };

  const handleExportCsv = () => {
    const recs = filtered.filter((r) => selected.has(r.id));
    exportSelectedCsv(recs);
  };

  return (
    <div className="screen">
      <div className="screen-topbar" style={{ padding: '8px 14px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 9 }}>
          <span className="screen-title">Records</span>
          <span className="count-pill">{filtered.length}</span>
          <span style={{ flex: 1 }} />
          {isAdmin && !selMode && (
            <button
              onClick={() => setSelMode(true)}
              style={{ height: 36, padding: '0 12px', background: '#fff', border: '1px solid var(--border)', borderRadius: 8, cursor: 'pointer', fontSize: 11, fontWeight: 700, color: 'var(--brown)' }}
              aria-label="Enter selection mode for bulk actions"
            >
              Select
            </button>
          )}
          {selMode && (
            <button
              onClick={exitSelMode}
              style={{ height: 36, padding: '0 12px', background: '#fff', border: '1px solid var(--border)', borderRadius: 8, cursor: 'pointer', fontSize: 11, fontWeight: 700, color: 'var(--muted)' }}
              aria-label="Exit selection mode"
            >
              Done
            </button>
          )}
        </div>
        <input className="input" value={q} onChange={(e) => onQ(e.target.value)} placeholder="Search stock #, vehicle, VIN, inspector…" style={{ height: 44, fontSize: 12.5, marginTop: 9 }} />
        <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center' }}>
          {RES_CHIPS.map(([k, label]) => {
            const on = fRes === k;
            const cls = k === 'fail' ? 'amber' : k === 'pass' ? 'green' : '';
            return (
              <span key={k} className={'pill-btn' + (on ? ' on ' + cls : '')} onClick={() => onFRes(k)}>
                {label}
              </span>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--muted)', flex: '0 0 auto' }}>FROM</span>
          <input type="date" value={fFrom} onChange={(e) => onFFrom(e.target.value)} style={{ flex: 1, minWidth: 0, height: 38, border: '1px solid var(--border)', borderRadius: 8, background: '#fff', fontSize: 11, color: 'var(--brown)', padding: '0 8px', outline: 'none', boxSizing: 'border-box' }} />
          <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--muted)', flex: '0 0 auto' }}>TO</span>
          <input type="date" value={fTo} onChange={(e) => onFTo(e.target.value)} style={{ flex: 1, minWidth: 0, height: 38, border: '1px solid var(--border)', borderRadius: 8, background: '#fff', fontSize: 11, color: 'var(--brown)', padding: '0 8px', outline: 'none', boxSizing: 'border-box' }} />
        </div>
      </div>

      {selMode && (
        <BulkActionsBar
          selected={selected}
          allFiltered={filtered}
          onSelectAll={() => setSelected(new Set(filtered.slice(0, 100).map((r) => r.id)))}
          onClearAll={() => setSelected(new Set())}
          onBulkArchive={() => handleBulkOp(true)}
          onBulkUnarchive={() => handleBulkOp(false)}
          onExportCsv={handleExportCsv}
          busy={busy}
        />
      )}
      {bulkError && (
        <div style={{ padding: '8px 14px', background: '#FEF2F2', fontSize: 11, color: 'var(--red)', fontWeight: 700 }}>
          {bulkError}
        </div>
      )}

      <div className="screen-body">
        {filtered.map((r) => {
          const sm = statusMeta(r);
          const isSel = selMode && selected.has(r.id);
          return (
            <div
              key={r.id}
              style={{ background: isSel ? '#FBF3E4' : '#fff', border: `1px solid ${isSel ? 'var(--amber)' : 'var(--border)'}`, borderRadius: 10, padding: '11px 12px', cursor: 'pointer', display: 'flex', alignItems: 'flex-start', gap: 10 }}
              onClick={() => selMode ? toggleSelect(r.id) : onOpenRecord(r.id)}
            >
              {selMode && (
                <input
                  type="checkbox"
                  checked={isSel}
                  onChange={() => toggleSelect(r.id)}
                  onClick={(e) => e.stopPropagation()}
                  aria-label={`Select ${r.id}`}
                  style={{ marginTop: 3, width: 20, height: 20, accentColor: 'var(--amber)', flex: '0 0 auto', cursor: 'pointer' }}
                />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span className="mono" style={{ fontSize: 10.5, fontWeight: 600 }}>{r.id}</span>
                  <span style={{ fontSize: 8.5, fontWeight: 700, color: '#fff', background: sm.bg, padding: '2px 7px', borderRadius: 4 }}>{sm.label}</span>
                  {r.archived && <span style={{ fontSize: 8.5, fontWeight: 700, color: '#fff', background: 'var(--muted)', padding: '2px 7px', borderRadius: 4 }}>ARCHIVED</span>}
                  <span style={{ flex: 1 }} />
                  <span className="mono" style={{ fontSize: 9, color: 'var(--muted)' }}>{fmtDT(r.ts)}</span>
                </div>
                <div style={{ fontSize: 12.5, fontWeight: 600, marginTop: 4 }}>{r.stock} · {r.vehicle}</div>
                <div className="mono" style={{ fontSize: 9.5, color: 'var(--muted)', marginTop: 2 }}>VIN {r.vin || '—'}</div>
                <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>
                  {r.inspector} — {r.title}
                  {r.failCount ? ` · ${r.failCount} fail${r.failCount === 1 ? '' : 's'}${(r.rechecks || []).length ? ` · ${r.rechecks.length} re-check${r.rechecks.length === 1 ? '' : 's'}` : ''}` : ' · clean pass'}
                </div>
              </div>
            </div>
          );
        })}
        {filtered.length === 0 && (
          <div className="empty-note">{recs.length === 0 ? 'No inspections yet — run your first Final QC from the Inspect tab.' : 'No records match these filters.'}</div>
        )}
      </div>

      <BulkResultsModal results={bulkResults} onClose={() => { setBulkResults(null); }} />
    </div>
  );
}
