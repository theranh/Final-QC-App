// Per-truck save/sync status pill. Honest by design: 'Saved' only ever means
// the server confirmed persistence; local-only work is labeled as such.
export default function SaveStatusPill({ status, pendingPhotos = 0, onRetry, style }) {
  if (!status || status === 'idle') {
    if (!pendingPhotos) return null;
    status = 'syncing';
  }
  const P = {
    saved: { bg: '#e8f3ea', border: 'var(--green)', color: 'var(--green)', icon: '✓', label: 'Saved to server' },
    syncing: { bg: '#fdf6e3', border: 'var(--amber)', color: 'var(--amber)', icon: '↻', label: 'Syncing…' },
    local: { bg: 'var(--panel)', border: 'var(--brown)', color: 'var(--brown)', icon: '●', label: 'On this device — not synced' },
    error: { bg: '#fdecea', border: 'var(--red)', color: 'var(--red)', icon: '⚠', label: 'Save failed' },
  }[status] || null;
  if (!P) return null;
  const photoNote = pendingPhotos > 0 ? ` · ${pendingPhotos} photo${pendingPhotos === 1 ? '' : 's'} queued` : '';
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
        borderRadius: 9, border: `1px solid ${P.border}`, background: P.bg,
        fontSize: 11, fontWeight: 700, color: P.color, ...style,
      }}
    >
      <span aria-hidden="true">{P.icon}</span>
      <span style={{ flex: 1, minWidth: 0 }}>{P.label}{photoNote}</span>
      {status === 'error' && onRetry && (
        <button
          className="btn btn-outline-red"
          style={{ height: 44, padding: '0 16px', fontSize: 11, flex: '0 0 auto' }}
          onClick={onRetry}
        >
          RETRY
        </button>
      )}
    </div>
  );
}
