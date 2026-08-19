// FieldReadiness — optional preflight dialog shown before opening the
// walk-around camera.  Lists passive readiness indicators so the inspector
// knows the environment before committing to the shoot.
//
// Props:
//   onContinue()   — inspector chose Continue → proceed to camera/file-picker
//   onCancel()     — inspector chose Cancel / back
//
// Degraded states (offline, private-mode IDB, non-persistent storage) are
// shown as warnings but NEVER block Continue.

import { useEffect, useRef, useState } from 'react';
import { getReadiness } from '../lib/fieldCapabilities';
import { probePersistence, pendingJobs } from '../lib/photoQueue';

export default function FieldReadiness({ onContinue, onCancel }) {
  const [ready, setReady] = useState(null); // null while loading
  const dialogRef = useRef(null);
  const continueRef = useRef(null);
  const restoreFocusRef = useRef(true);

  useEffect(() => {
    let live = true;
    getReadiness({ probePersistenceFn: probePersistence, pendingJobsFn: pendingJobs })
      .then((r) => { if (live) setReady(r); })
      .catch(() => { if (live) setReady({}); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    continueRef.current?.focus();

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = dialogRef.current?.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (restoreFocusRef.current && previouslyFocused instanceof HTMLElement) {
        previouslyFocused.focus();
      }
    };
  }, [onCancel]);

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 300,
        background: 'rgba(25,22,20,0.72)',
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="field-readiness-title"
        tabIndex={-1}
        style={{
          width: '100%', maxWidth: 540,
          background: '#fff', borderRadius: '18px 18px 0 0',
          padding: '20px 18px 32px',
          boxShadow: '0 -4px 24px rgba(0,0,0,0.22)',
        }}
      >
        <div id="field-readiness-title" className="oswald" style={{ fontWeight: 700, fontSize: 16, letterSpacing: 1.5, color: 'var(--ink)', marginBottom: 14 }}>
          CAMERA READINESS CHECK
        </div>

        {ready === null ? (
          <div style={{ fontSize: 12, color: 'var(--muted)', padding: '12px 0' }}>Checking…</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
            <ReadinessRow
              label="Camera API"
              ok={ready.cameraSupported !== false}
              okText="Supported"
              warnText="Not supported — Continue still offers the existing photo picker"
              note="Permission will only be requested when you open the camera."
            />
            <ReadinessRow
              label="Connection"
              ok={ready.online !== false}
              okText="Online"
              warnText="Offline — photos will queue locally and upload when signal returns"
            />
            <ReadinessRow
              label="Local photo queue"
              ok={ready.persistenceOk !== false}
              okText={ready.persistenceOk === true ? 'Ready' : 'Not checked'}
              warnText="Unavailable (private mode or blocked storage) — keep this app open until every photo finishes sending"
            />
            <ReadinessRow
              label="Browser storage"
              ok={ready.storagePersistence === 'persistent'}
              okText="Persistent"
              warnText={ready.storagePersistence === 'best-effort'
                ? 'Best-effort — browser may evict data under storage pressure'
                : 'Persistence status unavailable — use the local queue result above'}
            />
            {ready.queuedUploads > 0 && (
              <div style={{
                display: 'flex', alignItems: 'flex-start', gap: 10,
                padding: '8px 10px', borderRadius: 8,
                background: '#fdf3e0', border: '1px solid var(--amber)',
                fontSize: 11, fontWeight: 600, color: '#8a6210',
              }}>
                <span style={{ fontSize: 15, flex: '0 0 auto' }}>⏳</span>
                <span>
                  <b>{ready.queuedUploads}</b> photo{ready.queuedUploads !== 1 ? 's' : ''} still uploading in the background.
                  They will continue while you shoot.
                </span>
              </div>
            )}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            className="btn btn-outline"
            style={{ flex: '0 0 38%', height: 48, fontSize: 14 }}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            ref={continueRef}
            type="button"
            className="btn btn-red"
            style={{ flex: 1, height: 48, fontSize: 15, fontWeight: 700 }}
            onClick={() => {
              restoreFocusRef.current = false;
              onContinue();
            }}
          >
            Continue →
          </button>
        </div>
      </div>
    </div>
  );
}

// Single row in the readiness list.
function ReadinessRow({ label, ok, okText, warnText, note }) {
  const bg = ok ? '#eaf4ec' : '#fdf3e0';
  const border = ok ? '1px solid #9ec4a8' : '1px solid var(--amber)';
  const iconColor = ok ? 'var(--green)' : '#8a6210';
  const icon = ok ? '✓' : '⚠';
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 10,
      padding: '8px 10px', borderRadius: 8,
      background: bg, border,
      fontSize: 11, color: 'var(--ink)',
    }}>
      <span style={{ fontWeight: 700, color: iconColor, fontSize: 13, flex: '0 0 auto', marginTop: 1 }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontWeight: 700 }}>{label}: </span>
        <span style={{ color: ok ? 'var(--green)' : '#8a6210', fontWeight: 600 }}>
          {ok ? okText : warnText}
        </span>
        {note && (
          <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>{note}</div>
        )}
      </div>
    </div>
  );
}
