import { useEffect, useState } from 'react';
import { CATS, chipStyle } from '../lib/constants';
import { api } from '../lib/api';
import ActivityTimeline from './ActivityTimeline';
import PhotoButton from './PhotoButton';

// Vehicle card — every record for one VIN on one screen: the TR-INTAKE-V2
// intake (photos, steps, RO-Ready check, quote) from this app's local intakes
// table, the Final QC result per segment, and the production tracker figures.
// When the intake predates the system (found:false) the QC half still shows —
// never nine empty checkboxes that read as skipped work.

const usd = (v) => (v == null ? null : '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 }));
const unavailable = <span style={{ color: 'var(--muted)', fontStyle: 'italic' }}>unavailable</span>;

function Row({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '5px 0', borderTop: '1px solid #F5F1EC' }}>
      <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>{label}</span>
      <span className="mono" style={{ fontSize: 11.5, fontWeight: 700, textAlign: 'right' }}>{value ?? unavailable}</span>
    </div>
  );
}

const stateColor = (s) => {
  const v = String(s || '').toLowerCase();
  if (['done', 'pass', 'complete', 'completed', 'checked', 'true', 'yes', 'ok'].includes(v)) return 'var(--green)';
  if (['fail', 'failed', 'no', 'issue'].includes(v)) return 'var(--red)';
  if (['skipped', 'n/a', 'na', 'deferred'].includes(v)) return 'var(--muted)';
  return 'var(--amber)';
};
const stateLabel = (s) => {
  if (typeof s === 'boolean') return s ? 'DONE' : 'OPEN';
  return String(s || 'open').toUpperCase();
};

function CheckItem({ label, state }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderTop: '1px solid #F5F1EC' }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: stateColor(state), flex: '0 0 auto' }} />
      <span style={{ fontSize: 11.5, fontWeight: 600, flex: 1 }}>{label}</span>
      <span style={{ fontSize: 8.5, fontWeight: 700, color: stateColor(state) }}>{stateLabel(state)}</span>
    </div>
  );
}

/** Tolerant readers for the intake payload — field names may vary slightly. */
const intakePhotos = (it) => {
  const list = it?.photos || it?.photoSet || [];
  return (Array.isArray(list) ? list : []).map((p) =>
    typeof p === 'string' ? { url: p, label: '' } : { url: p.url || p.src || p.data, label: p.label || p.slot || p.kind || '' }
  ).filter((p) => p.url);
};

export default function VehicleCard({ vehicle, record, onBack, onOpenRecord, onOpenLightbox }) {
  const [intake, setIntake] = useState(undefined); // undefined=loading, null=load error
  useEffect(() => {
    let dead = false;
    setIntake(undefined);
    api.intakeByVin(vehicle.vin)
      .then((d) => { if (!dead) setIntake(d); })
      .catch(() => { if (!dead) setIntake(null); });
    return () => { dead = true; };
  }, [vehicle.vin]);

  const t = vehicle.tracker;
  const found = intake && intake.found;
  const photos = found ? intakePhotos(intake) : [];

  // Final QC per segment, straight from the committed record.
  const segResults = record
    ? CATS.map((c) => {
        if (record.optOut && record.optOut[c.k]) return { c, state: 'opted out', fails: [] };
        const items = (record.items && record.items[c.k]) || [];
        const marked = items.filter((i) => i.mark !== 'n');
        if (!marked.length) return { c, state: 'n/a', fails: [] };
        const fails = items.filter((i) => i.mark === 'f');
        return { c, state: fails.length ? 'fail' : 'pass', fails };
      })
    : [];

  return (
    <div className="screen">
      <div className="screen-topbar" style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <span className="icon-btn" onClick={onBack} style={{ cursor: 'pointer' }}>‹</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="screen-title" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {vehicle.stock} · {vehicle.vehicle}
          </div>
          <div className="mono" style={{ fontSize: 9.5, color: 'var(--muted)' }}>{vehicle.vin}</div>
        </div>
      </div>
      <div className="screen-body" style={{ gap: 9 }}>
        {/* ---- Intake half ---- */}
        {intake === undefined && <div className="empty-note">Loading intake record…</div>}
        {intake === null && (
          <div className="card" style={{ borderLeft: '3px solid var(--amber)' }}>
            <div style={{ fontSize: 11.5, fontWeight: 600 }}>Could not load the intake record right now.</div>
          </div>
        )}
        {intake && !intake.found && (
          <div className="card">
            <div className="card-title">INTAKE</div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6, lineHeight: 1.5 }}>
              This intake predates the intake system — no digital intake record was kept for this truck. That doesn&rsquo;t mean the work wasn&rsquo;t done.
            </div>
          </div>
        )}
        {found && (
          <>
            <div className="card">
              <div className="card-title">INTAKE PHOTO SET</div>
              <div style={{ fontSize: 9, color: 'var(--muted)', marginTop: 3 }}>
                Required: exterior ×10 · interior ×6 · all 4 wheels · tire tread ×4 · each damage/fix
              </div>
              {photos.length ? (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 5, marginTop: 8 }}>
                  {photos.map((p, i) => (
                     <div key={i} style={{ position: 'relative' }}>
                       <PhotoButton src={p.url} alt={p.label || `intake photo ${i + 1}`} onOpen={onOpenLightbox} style={{ width: '100%' }} imageStyle={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: 7, border: '1px solid var(--border)' }} />
                      {p.label && (
                        <span style={{ position: 'absolute', bottom: 2, left: 2, right: 2, fontSize: 7, fontWeight: 700, color: '#fff', background: 'rgba(0,0,0,.55)', borderRadius: 4, padding: '1px 3px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {p.label}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="empty-note" style={{ padding: '8px 0 2px' }}>No photos in the intake record.</div>
              )}
            </div>
          </>
        )}

        {/* ---- Body Quoter total ---- */}
        <div className="card">
          <div className="card-title">BODY QUOTER TOTAL</div>
          {vehicle.quote ? (
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 6 }}>
              <span className="oswald" style={{ fontSize: 22, fontWeight: 600, color: 'var(--brown)' }}>{usd(vehicle.quote.usd) ?? '—'}</span>
              <span className="mono" style={{ fontSize: 10.5, color: 'var(--muted)' }}>
                {vehicle.quote.hrs != null ? `${vehicle.quote.hrs} hrs` : ''}
                {vehicle.quote.lineCount != null ? ` · ${vehicle.quote.lineCount} line${vehicle.quote.lineCount === 1 ? '' : 's'}` : ''}
              </span>
            </div>
          ) : (
            <div style={{ marginTop: 6, fontSize: 11.5 }}>{unavailable}</div>
          )}
        </div>

        {/* ---- Final QC half ---- */}
        <div className="card">
          <div className="card-title">FINAL QC — {vehicle.qcNumber}</div>
          {!record && <div className="empty-note" style={{ padding: '8px 0 2px' }}>QC record not loaded.</div>}
          {segResults.map(({ c, state, fails }) => (
            <div key={c.k} style={{ borderTop: '1px solid #F5F1EC', padding: '7px 0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={chipStyle(c.k)}>{c.seg}</span>
                <span style={{ fontSize: 12, fontWeight: 600, flex: 1 }}>{c.label}</span>
                <span style={{ fontSize: 9, fontWeight: 800, color: state === 'fail' ? 'var(--red)' : state === 'pass' ? 'var(--green)' : 'var(--muted)' }}>
                  {state.toUpperCase()}
                </span>
              </div>
              {fails.map((f, i) => (
                <div key={i} style={{ marginLeft: 6, marginTop: 6 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--red)' }}>✕ {f.item}</div>
                  {f.note && <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 2, fontStyle: 'italic' }}>“{f.note}”</div>}
                  {(f.photos || []).length > 0 && (
                    <div style={{ display: 'flex', gap: 5, marginTop: 5, flexWrap: 'wrap' }}>
                      {f.photos.map((p, j) => (
                         <PhotoButton key={j} src={p} alt={`QC failure photo ${j + 1}`} onOpen={onOpenLightbox} imageStyle={{ width: 52, height: 52, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--border)' }} />
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}
          {record && (
            <div className="btn btn-outline" style={{ height: 44, fontSize: 12, marginTop: 9 }} onClick={() => onOpenRecord(vehicle.qcNumber)}>
              Open full QC record ›
            </div>
          )}
        </div>

        {/* ---- Activity timeline and quick flags ---- */}
        <ActivityTimeline vin={vehicle.vin} qcNumber={vehicle.qcNumber} />

        {/* ---- Production tracker ---- */}
        <div className="card">
          <div className="card-title">PRODUCTION TRACKER</div>
          {t ? (
            <div style={{ marginTop: 4 }}>
              <Row label="RO opened" value={t.roOpen} />
              <Row label="Completed" value={t.completed} />
              <Row label="Retail plan" value={usd(t.retailPlan)} />
              <Row label="Closed RO" value={usd(t.closedRO)} />
              {/* Variance comes off the sheet as typed — never recomputed here. */}
              <Row label="Variance" value={usd(t.variance)} />
              <Row label="Variance %" value={t.variancePct != null ? t.variancePct + '%' : null} />
              <Row label="Days in production" value={t.daysInProduction != null ? `${t.daysInProduction}d` : null} />
              {t.notes && <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 6, fontStyle: 'italic' }}>“{t.notes}”</div>}
            </div>
          ) : (
            <div style={{ fontSize: 11.5, marginTop: 6 }}>
              {unavailable} <span style={{ fontSize: 10, color: 'var(--muted)' }}>— this VIN isn&rsquo;t on the tracker sheet (or the sheet is unreachable).</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
