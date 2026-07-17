// Shown when a newer version of the app has been published — employees on an
// old version should refresh so everyone runs the same revision.
export default function UpdateBanner({ onRefresh }) {
  return (
    <div
      className="noprint"
      style={{
        flex: '0 0 auto',
        background: '#DB2728',
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
        A new version of this app is available. Refresh now so you&apos;re on the latest revision.
      </span>
      <span
        onClick={onRefresh}
        style={{ flex: '0 0 auto', background: 'rgba(255,255,255,0.2)', borderRadius: 7, padding: '7px 11px', cursor: 'pointer' }}
      >
        Refresh
      </span>
    </div>
  );
}
