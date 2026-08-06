import { CATS, CHECKLIST, OPTIONAL_CATS, catByKey, chipStyle } from '../lib/constants';
import { initials } from '../lib/format';
import { vinValid } from '../lib/vin';
import IntakeQuoteCard from './IntakeQuoteCard';
import PhotoRow from './PhotoRow';

export default function NewInspectionForm({ draft, onDraftChange, users, optOut, onToggleOptOut, photosMap, onTakePhoto, onRemovePhoto, onScanVin, onClose, onGoSettings, onStart, nextId, openRecs = [], onOpenRecheck }) {
  const vin = (draft.vin || '').toUpperCase();
  const vinOk = vinValid(vin);

  // Guard against a duplicate QC: if this VIN already has a failed inspection
  // with an open re-check, the right move is to finish that re-check instead.
  const openMatch =
    vin.length >= 8 ? openRecs.find((r) => (r.vin || '').toUpperCase().startsWith(vin) || vin.startsWith((r.vin || '').toUpperCase())) : null;
  const vinPhotos = photosMap['vin'] || [];
  const insp = users.find((u) => u.id === draft.uid) || users[0];

  let vinStatusLabel, vinStatusColor, vinBorder;
  if (!vin.length) {
    vinStatusLabel = 'Scan the barcode or type all 17 characters';
    vinStatusColor = 'var(--muted)';
    vinBorder = 'var(--border)';
  } else if (vin.length < 17) {
    vinStatusLabel = `${vin.length} / 17 characters`;
    vinStatusColor = 'var(--muted)';
    vinBorder = 'var(--border)';
  } else if (vinOk) {
    vinStatusLabel = '✓ Valid VIN — check digit OK';
    vinStatusColor = 'var(--green)';
    vinBorder = 'var(--green)';
  } else {
    vinStatusLabel = '✕ Invalid VIN — failed check-digit validation';
    vinStatusColor = 'var(--red)';
    vinBorder = 'var(--red)';
  }

  const active = CATS.filter((c) => !optOut[c.k]);
  const activeTotal = active.reduce((a, c) => a + CHECKLIST[c.k].length, 0);
  const startValid = !!(draft.stock.trim() && draft.vehicle.trim() && insp && vinOk && vinPhotos.length);
  const startLabel = startValid
    ? `Start Checklist → ${activeTotal} items`
    : !vinOk
    ? 'Valid 17-character VIN required'
    : !vinPhotos.length
    ? 'VIN label photo required'
    : 'Enter stock # and vehicle to start';

  return (
    <div className="screen">
      <div className="screen-topbar" style={{ padding: '10px 14px 12px', display: 'flex', alignItems: 'center', gap: 9 }}>
        <span className="icon-btn" onClick={onClose}>‹</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="oswald" style={{ fontWeight: 600, fontSize: 18 }}>New Inspection</div>
        </div>
        <span className="mono" style={{ fontSize: 11, color: 'var(--muted)', flex: '0 0 auto' }}>{nextId}</span>
      </div>
      <div className="screen-body" style={{ gap: 9 }}>
        {openMatch && (
          <div className="card" style={{ border: '1.5px solid var(--red)', background: '#FBEFEF' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--red)' }}>⚠ THIS UNIT HAS AN OPEN RE-CHECK</div>
            <div style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.45 }}>
              {openMatch.qcNumber || openMatch.id} — {openMatch.vehicle || 'this vehicle'} failed QC and is waiting on a re-check.
              Don&apos;t start a new QC for it — finish the re-check so the fixed items are cleared on the original record.
            </div>
            {onOpenRecheck && (
              <div
                className="btn btn-red"
                style={{ marginTop: 9, height: 40, fontSize: 12 }}
                onClick={() => onOpenRecheck(openMatch.id)}
              >
                Open the re-check instead →
              </div>
            )}
          </div>
        )}
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span className="card-title" style={{ flex: 1 }}>STEP 1 — VIN · PRIMARY ID</span>
            <span style={{ fontSize: 8.5, fontWeight: 700, color: '#fff', background: 'var(--red)', padding: '2px 7px', borderRadius: 4 }}>REQUIRED</span>
          </div>
          <div
            style={{ marginTop: 9, height: 48, borderRadius: 10, background: 'var(--ink)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}
            onClick={onScanVin}
          >
            ▣ Scan VIN barcode — door label
          </div>
          <div style={{ marginTop: 10 }}>
            <div className="field-label">Full VIN — 17 characters (manual fallback)</div>
            <input
              className="input mono"
              value={draft.vin}
              onChange={(e) => onDraftChange({ vin: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 17) })}
              placeholder="1FTFW1E57MFA82241"
              maxLength={17}
              style={{ borderColor: vinBorder, borderWidth: 1.5, letterSpacing: 0.5, textTransform: 'uppercase' }}
            />
            <div style={{ fontSize: 9.5, fontWeight: 700, marginTop: 5, color: vinStatusColor }}>{vinStatusLabel}</div>
          </div>
          <div style={{ marginTop: 10 }}>
            <div className="field-label" style={{ marginBottom: 5 }}>
              Door-jamb VIN label photo <span style={{ color: 'var(--red)' }}>* proof of unit</span>
            </div>
            <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
              <PhotoRow photos={vinPhotos} onAdd={() => onTakePhoto('vin')} onRemove={(idx) => onRemovePhoto('vin', idx)} size={64} height={48} />
              <span style={{ fontSize: 9.5, fontWeight: 700, color: vinPhotos.length ? 'var(--green)' : 'var(--red)', flex: 1, minWidth: 120 }}>
                {vinPhotos.length ? '✓ Saved with the record as proof of unit' : 'Required before starting'}
              </span>
            </div>
          </div>
        </div>

        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="card-title">STEP 2 — VEHICLE</div>
          <div>
            <div className="field-label">Stock # <span style={{ color: 'var(--red)' }}>*</span></div>
            <input className="input" value={draft.stock} onChange={(e) => onDraftChange({ stock: e.target.value })} placeholder="T-4821" />
          </div>
          <div>
            <div className="field-label">Vehicle (year / make / model) <span style={{ color: 'var(--red)' }}>*</span></div>
            <input className="input" value={draft.vehicle} onChange={(e) => onDraftChange({ vehicle: e.target.value })} placeholder="2021 F-150 XLT" />
          </div>
        </div>

        <IntakeQuoteCard vin={vin} />

        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <div className="card-title" style={{ flex: 1 }}>INSPECTOR</div>
            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--red)', cursor: 'pointer', padding: '4px 2px' }} onClick={onGoSettings}>+ Manage in Settings</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 9 }}>
            {users.map((u) => {
              const on = insp && insp.id === u.id;
              return (
                <div
                  key={u.id}
                  onClick={() => onDraftChange({ uid: u.id })}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 9, minHeight: 52, padding: '6px 11px', borderRadius: 10, cursor: 'pointer',
                    background: on ? '#F0F6F1' : '#fff', border: on ? '1.5px solid var(--green)' : '1px solid var(--border)',
                  }}
                >
                  <span style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--brown)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Oswald, sans-serif', fontSize: 11, fontWeight: 600, flex: '0 0 auto' }}>
                    {initials(u.name)}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>{u.name}</div>
                    <div style={{ fontSize: 10, color: 'var(--muted)' }}>{u.title}{u.email ? ' · ' + u.email : ''}</div>
                  </div>
                  <span style={{ fontSize: 14, fontWeight: 700, color: on ? 'var(--green)' : 'var(--muted2)' }}>{on ? '✓' : ''}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="card">
          <div className="card-title">INSTALLED PACKAGES — TOGGLE OFF IF NOT ON THIS UNIT</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 9 }}>
            {OPTIONAL_CATS.map((k) => {
              const c = catByKey(k);
              const on = !optOut[k];
              return (
                <div
                  key={k}
                  onClick={() => onToggleOptOut(k)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 9, minHeight: 48, padding: '4px 11px', borderRadius: 10, cursor: 'pointer',
                    background: on ? '#fff' : 'var(--panel)', border: on ? '1px solid var(--border)' : '1px dashed var(--muted2)', opacity: on ? 1 : 0.75,
                  }}
                >
                  <span style={chipStyle(k)}>{c.seg}</span>
                  <span style={{ fontSize: 12.5, fontWeight: 700, flex: 1 }}>{c.label}</span>
                  <span style={{ fontSize: 10, fontWeight: 700, color: on ? 'var(--green)' : 'var(--muted)' }}>{on ? 'ON THIS UNIT ✓' : 'NOT ON UNIT · N/A'}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div className="screen-footer">
        <div className={'btn' + (startValid ? ' btn-red' : ' disabled')} onClick={() => startValid && onStart()}>
          {startLabel}
        </div>
      </div>
    </div>
  );
}
