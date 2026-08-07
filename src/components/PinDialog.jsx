import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';

/*
 * Reusable commit sign-off dialog.
 *
 * The signer picks THEMSELVES from the active-employee list, then enters their
 * own 4-digit PIN. This is never a free-text name field — committed_by comes
 * from the verified PIN owner on the server.
 *
 * Supervisor override: if the chosen signer canOverride, a "Signing for" picker
 * appears so they can countersign another active employee's work. In that case
 * committed_by = the worker, overridden_by = the signer.
 *
 * Props:
 *   title    — heading (e.g. "Commit intake")
 *   subtitle — small line under the heading (e.g. the VIN)
 *   onCommit(({ signerId, pin, forEmployeeId }) => Promise) — does the API call
 *   onClose  — dismiss without committing
 */
export default function PinDialog({ title, subtitle, onCommit, onClose }) {
  const [signers, setSigners] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [signerId, setSignerId] = useState(null);
  const [pin, setPin] = useState('');
  const [overrideOn, setOverrideOn] = useState(false);
  const [forId, setForId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    api
      .signers()
      .then((j) => {
        if (!live) return;
        setSigners((j && j.signers) || []);
        setLoadError(false);
      })
      .catch(() => live && setLoadError(true));
    return () => {
      live = false;
    };
  }, []);

  const withPin = useMemo(() => (signers || []).filter((s) => s.hasPin), [signers]);
  const signer = useMemo(() => (signers || []).find((s) => s.id === signerId) || null, [signers, signerId]);
  const canOverride = !!(signer && signer.canOverride);

  // "Signing for" candidates: active employees other than the signer.
  const forCandidates = useMemo(
    () => (signers || []).filter((s) => s.id !== signerId),
    [signers, signerId],
  );

  const pickSigner = (id) => {
    setSignerId(id);
    setError('');
    // Leaving a can_override signer resets override state.
    const s = (signers || []).find((x) => x.id === id);
    if (!s || !s.canOverride) {
      setOverrideOn(false);
      setForId(null);
    }
  };

  const canSubmit =
    !busy &&
    signerId != null &&
    /^\d{4}$/.test(pin) &&
    (!overrideOn || forId != null);

  const submit = () => {
    if (!canSubmit) return;
    setBusy(true);
    setError('');
    Promise.resolve(
      onCommit({
        signerId,
        pin,
        forEmployeeId: overrideOn && forId != null ? forId : undefined,
      }),
    )
      .then(() => {
        /* parent closes on success */
      })
      .catch((err) => {
        setError((err && (err.data?.error || err.message)) || 'Could not commit');
        setBusy(false);
        setPin('');
      });
  };

  return (
    <div className="lightbox-overlay" onClick={onClose} style={{ cursor: 'default', padding: 18 }}>
      <div
        className="card"
        onClick={(e) => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 380, maxHeight: '90%', overflowY: 'auto' }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span className="oswald" style={{ fontWeight: 700, fontSize: 18, flex: 1 }}>{title}</span>
          <span onClick={onClose} style={{ fontSize: 20, color: 'var(--muted)', cursor: 'pointer', lineHeight: 1 }}>✕</span>
        </div>
        {subtitle && <div className="mono" style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>{subtitle}</div>}

        {loadError && (
          <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 10 }}>Could not load the signer list — check your connection.</div>
        )}
        {signers == null && !loadError && (
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 10 }}>Loading…</div>
        )}

        {signers != null && (
          <>
            <div style={{ marginTop: 12 }}>
              <div className="field-label">WHO IS SIGNING?</div>
              {withPin.length === 0 ? (
                <div style={{ fontSize: 11, color: 'var(--amber)', fontWeight: 600, marginTop: 4 }}>
                  No one has a PIN yet. An admin must set PINs in Settings first.
                </div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                  {withPin.map((s) => (
                    <div
                      key={s.id}
                      className={'pill-btn' + (signerId === s.id ? ' on' : '')}
                      style={{ height: 34, fontSize: 11 }}
                      onClick={() => pickSigner(s.id)}
                    >
                      {s.name}{s.canOverride ? ' ★' : ''}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {signerId != null && (
              <div style={{ marginTop: 12 }}>
                <div className="field-label">4-DIGIT PIN</div>
                <input
                  className="input mono"
                  style={{ height: 46, textAlign: 'center', letterSpacing: 8, fontSize: 20 }}
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={4}
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
                  autoFocus
                />
              </div>
            )}

            {canOverride && (
              <div style={{ marginTop: 12 }}>
                <div
                  className={'pill-btn' + (overrideOn ? ' on amber' : '')}
                  style={{ height: 34, fontSize: 10.5 }}
                  onClick={() => { setOverrideOn((v) => !v); setForId(null); }}
                >
                  {overrideOn ? '✓ ' : ''}Sign for someone else (supervisor)
                </div>
                {overrideOn && (
                  <div style={{ marginTop: 8 }}>
                    <div className="field-label">SIGNING FOR</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                      {forCandidates.map((s) => (
                        <div
                          key={s.id}
                          className={'pill-btn' + (forId === s.id ? ' on green' : '')}
                          style={{ height: 32, fontSize: 10.5 }}
                          onClick={() => setForId(s.id)}
                        >
                          {s.name}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {error && <div style={{ fontSize: 11, color: 'var(--red)', fontWeight: 600, marginTop: 10 }}>{error}</div>}

            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <button className="btn btn-outline" style={{ height: 44, flex: '0 0 38%' }} onClick={onClose} disabled={busy}>Cancel</button>
              <button
                className={'btn btn-green' + (canSubmit ? '' : ' disabled')}
                style={{ height: 44, flex: 1, opacity: canSubmit ? 1 : 0.6 }}
                onClick={submit}
              >
                {busy ? 'Committing…' : 'Commit sign-off'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Small inline badge shown wherever a committed signature appears.
export function SignatureBadge({ committedBy, overriddenBy }) {
  if (!committedBy) return null;
  return (
    <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--green)', lineHeight: 1.4 }}>
      ✓ Signed by {committedBy}
      {overriddenBy ? <span style={{ color: 'var(--brown)' }}> · countersigned by {overriddenBy}</span> : null}
    </div>
  );
}
