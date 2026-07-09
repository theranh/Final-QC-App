// Shown when another tab/window of this same browser just wrote inspection data —
// this app has no cross-tab merge, so the safe move is to reload before continuing.
export default function StaleTabBanner({ onReload }) {
  return (
    <div
      className="noprint"
      style={{
        flex: '0 0 auto',
        background: '#B07A1E',
        color: '#fff',
        fontSize: 11.5,
        fontWeight: 700,
        padding: '10px 14px',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        zIndex: 70,
      }}
    >
      <span style={{ flex: 1, lineHeight: 1.4 }}>
        This app changed in another tab/window. Reload now to avoid overwriting that data.
      </span>
      <span
        onClick={onReload}
        style={{ flex: '0 0 auto', background: 'rgba(255,255,255,0.2)', borderRadius: 7, padding: '7px 11px', cursor: 'pointer' }}
      >
        Reload
      </span>
    </div>
  );
}
