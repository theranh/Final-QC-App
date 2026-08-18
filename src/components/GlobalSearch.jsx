// Global truck search results — server-backed (/api/search), covering every
// record the app knows about: Final QC inspections (including ARCHIVED),
// intakes (active and committed), and quote-only records whose VIN never got
// an intake. Rendered under the Vehicles search box when the local dash lists
// may not contain the truck being looked for. Full VINs are always shown so
// two trucks with similar stock numbers can never be confused.
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

const KIND_META = {
  inspection: { label: 'FINAL QC', bg: 'var(--green)' },
  intake: { label: 'INTAKE', bg: 'var(--brown)' },
  quote: { label: 'QUOTE ONLY', bg: 'var(--muted)' },
};

export default function GlobalSearchResults({ query, excludeVins, onOpenRecord, onOpenIntake, onOpenQuote }) {
  const q = String(query || '').trim();
  const [state, setState] = useState({ status: 'idle', results: [], forQ: '' });
  const [attempt, setAttempt] = useState(0); // RETRY bumps this
  const timerRef = useRef(null);

  useEffect(() => {
    clearTimeout(timerRef.current);
    if (q.length < 2) {
      setState({ status: 'idle', results: [], forQ: q });
      return undefined;
    }
    let live = true;
    setState((s) => ({ ...s, status: 'loading' }));
    // Debounce keystrokes; the endpoint is cheap but not free.
    timerRef.current = setTimeout(() => {
      api.search(q)
        .then((j) => { if (live) setState({ status: 'done', results: j?.results || [], forQ: q }); })
        .catch(() => { if (live) setState({ status: 'error', results: [], forQ: q }); });
    }, 350);
    return () => { live = false; clearTimeout(timerRef.current); };
  }, [q, attempt]);

  if (q.length < 2) return null;

  // Trucks already visible in the local dash lists above are excluded so the
  // section only surfaces what the user could NOT otherwise find.
  const shown = (state.results || []).filter((r) => !excludeVins || !excludeVins.has(r.vin));

  return (
    <div style={{ marginTop: 12 }}>
      <div className="card-title" style={{ padding: '0 2px' }}>EVERYWHERE ELSE (ALL RECORDS)</div>
      {state.status === 'loading' && (
        <div style={{ fontSize: 11, color: 'var(--muted)', padding: '8px 2px' }}>Searching all records…</div>
      )}
      {state.status === 'error' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 2px' }}>
          <span style={{ fontSize: 11, color: 'var(--red)', fontWeight: 700, flex: 1 }}>Search failed — check your connection.</span>
          <button className="btn btn-outline-red" style={{ height: 44, padding: '0 16px', fontSize: 11 }} onClick={() => setAttempt((n) => n + 1)}>RETRY</button>
        </div>
      )}
      {state.status === 'done' && shown.length === 0 && (
        <div style={{ fontSize: 11, color: 'var(--muted)', padding: '8px 2px' }}>No other records match “{state.forQ}”.</div>
      )}
      {state.status === 'done' && shown.map((r) => {
        const meta = KIND_META[r.kind] || KIND_META.quote;
        const open = () => {
          if (r.kind === 'inspection' && r.qcNumber) onOpenRecord(r.qcNumber);
          // Quote-only record: no intake exists — open the saved quote itself
          // (standalone reopen path), never a blank intake for that VIN.
          else if (r.kind === 'quote' && r.quoteId) onOpenQuote({ vin: r.vin, stock: r.stock, vehicle: r.vehicle, quoteId: r.quoteId });
          else onOpenIntake({ vin: r.vin });
        };
        return (
          <div
            key={r.kind + ':' + (r.inspectionId ?? r.intakeId ?? r.quoteId ?? r.vin)}
            className="card"
            role="button"
            tabIndex={0}
            onClick={open}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
            style={{ cursor: 'pointer', marginTop: 8 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: 0.6, color: '#fff', background: meta.bg, padding: '2px 7px', borderRadius: 4 }}>{meta.label}</span>
              {r.archived && (
                <span style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: 0.6, color: '#fff', background: 'var(--amber)', padding: '2px 7px', borderRadius: 4 }}>ARCHIVED</span>
              )}
              {r.kind === 'inspection' && r.status === 'open' && (
                <span style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: 0.6, color: '#fff', background: 'var(--amber)', padding: '2px 7px', borderRadius: 4 }}>OPEN RE-CHECK</span>
              )}
              {r.kind !== 'inspection' && r.committed && (
                <span style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: 0.6, color: '#fff', background: 'var(--green)', padding: '2px 7px', borderRadius: 4 }}>COMMITTED</span>
              )}
              <span style={{ flex: 1 }} />
              {r.qcNumber && <span className="mono" style={{ fontSize: 10, color: 'var(--muted)' }}>{r.qcNumber}</span>}
            </div>
            <div style={{ fontSize: 12.5, fontWeight: 700, marginTop: 5 }}>
              {r.vehicle || 'Vehicle not recorded'}{r.stock ? ` · STOCK ${r.stock}` : ''}
            </div>
            {/* Full VIN, always — never truncated, so similar trucks can't be mixed up. */}
            <div className="mono" style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, wordBreak: 'break-all' }}>{r.vin || 'No VIN recorded'}</div>
          </div>
        );
      })}
    </div>
  );
}
