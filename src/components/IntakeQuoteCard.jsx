import { useEffect, useState } from 'react';

// Read-only view of what the Intake & Body Quoter wrote up for this VIN.
// Renders nothing until a full VIN is present and a quote is actually found.

const PANEL_LABELS = {
  hood: 'Hood', roof: 'Roof', tailgate: 'Tailgate',
  front_bumper: 'Front bumper', rear_bumper: 'Rear bumper',
  grille: 'Grille', windshield: 'Windshield',
  lf_fender: 'LF fender', rf_fender: 'RF fender',
  lf_door: 'LF door', rf_door: 'RF door',
  lr_door: 'LR door', rr_door: 'RR door',
  lf_bedside: 'LF bedside', rf_bedside: 'RF bedside',
  lr_bedside: 'LR bedside', rr_bedside: 'RR bedside',
  cab_corner: 'Cab corner', rocker: 'Rocker',
  mirror: 'Mirror', headlamp: 'Headlamp', taillamp: 'Taillamp',
  wheel: 'Wheel', running_board: 'Running board',
  unknown: 'Unidentified panel',
};

const panelLabel = (p) => PANEL_LABELS[p] || String(p || '').replace(/_/g, ' ');

export default function IntakeQuoteCard({ vin }) {
  const clean = String(vin || '').trim().toUpperCase();
  const [state, setState] = useState('idle'); // idle | loading | ready | none | error
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (clean.length !== 17) {
      setState('idle');
      setData(null);
      return;
    }
    let live = true;
    setState('loading');
    fetch(`/api/intake-quote/${encodeURIComponent(clean)}`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        if (!live) return;
        if (d && d.found) {
          setData(d);
          setState('ready');
        } else {
          setData(null);
          setState('none');
        }
      })
      .catch(() => {
        if (live) setState('error');
      });
    return () => {
      live = false;
    };
  }, [clean]);

  if (state === 'idle' || state === 'none') return null;

  if (state === 'loading') {
    return (
      <div className="card">
        <div className="card-title">INTAKE DAMAGE QUOTE</div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 7 }}>Checking intake records…</div>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="card">
        <div className="card-title">INTAKE DAMAGE QUOTE</div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 7 }}>
          Could not reach the quoter. Inspect as normal.
        </div>
      </div>
    );
  }

  const quotedOn = data.quotedAt ? new Date(data.quotedAt).toLocaleDateString() : '';
  const lines = data.lines || [];
  const shown = open ? lines : lines.slice(0, 3);
  const flagged = lines.filter((l) => l.needsReview).length;

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span className="card-title" style={{ flex: 1 }}>INTAKE DAMAGE QUOTE</span>
        <span style={{ fontSize: 8.5, fontWeight: 700, color: '#fff', background: 'var(--brown)', padding: '2px 7px', borderRadius: 4 }}>
          FROM INTAKE
        </span>
      </div>

      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8, lineHeight: 1.5 }}>
        {[data.vehicle, data.stock && `Stock ${data.stock}`, data.estimator, quotedOn]
          .filter(Boolean)
          .join(' · ')}
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
        <span className="mono" style={{ fontSize: 15, fontWeight: 700 }}>
          {data.totals?.hrs ?? 0} hr
        </span>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>
          {lines.length} damage {lines.length === 1 ? 'area' : 'areas'} written up at intake
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 9 }}>
        {shown.map((l, i) => (
          <div
            key={i}
            style={{
              display: 'flex', alignItems: 'flex-start', gap: 8, padding: '7px 10px',
              borderRadius: 8, background: 'var(--panel)', border: '1px solid var(--border)',
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700 }}>{panelLabel(l.panel)}</div>
              <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>
                {[l.damage, l.severity, l.paint && 'paint'].filter(Boolean).join(' · ')}
              </div>
            </div>
            {l.needsReview && (
              <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--red)', flex: '0 0 auto' }}>REVIEW</span>
            )}
          </div>
        ))}
      </div>

      {lines.length > 3 && (
        <div
          onClick={() => setOpen((v) => !v)}
          style={{ fontSize: 10, fontWeight: 700, color: 'var(--red)', cursor: 'pointer', padding: '8px 2px 2px' }}
        >
          {open ? 'Show less' : `Show all ${lines.length} areas`}
        </div>
      )}

      {flagged > 0 && (
        <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 7 }}>
          {flagged} area{flagged === 1 ? '' : 's'} flagged for human review at intake.
        </div>
      )}
    </div>
  );
}
