export default function LivePhotoOrientationReview({ dataUrl, onChoose }) {
  const button = {
    border: '1px solid #5c554b',
    borderRadius: 8,
    background: '#2b2823',
    color: '#f5f3ee',
    fontWeight: 700,
    padding: '12px 10px',
  };
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Camera orientation check"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 500,
        display: 'flex',
        flexDirection: 'column',
        background: '#11100e',
        color: '#f5f3ee',
        padding: 'calc(14px + env(safe-area-inset-top)) 14px calc(14px + env(safe-area-inset-bottom))',
      }}
    >
      <div style={{ textAlign: 'center', marginBottom: 10 }}>
        <div style={{ fontWeight: 800, letterSpacing: 1 }}>QUICK CAMERA CHECK</div>
        <div style={{ color: '#c8c0b4', fontSize: 13, marginTop: 4 }}>
          Make this photo upright. The app will remember this camera.
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#000', borderRadius: 10, overflow: 'hidden' }}>
        <img src={dataUrl} alt="Captured camera orientation preview" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 12 }}>
        <button type="button" style={button} onClick={() => onChoose(-90)}>ROTATE LEFT</button>
        <button type="button" style={button} onClick={() => onChoose(90)}>ROTATE RIGHT</button>
        <button type="button" style={button} onClick={() => onChoose(180)}>FLIP 180°</button>
        <button type="button" style={{ ...button, background: '#f5f3ee', color: '#171512', borderColor: '#f5f3ee' }} onClick={() => onChoose(0)}>LOOKS UPRIGHT</button>
      </div>
    </div>
  );
}