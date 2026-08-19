// Advisory photo-quality review overlay.
//
// Shown only when analyzeDataUrl() returns one or more quality warnings for a
// just-captured photo.  The user can:
//   • Keep   — proceed with the original dataUrl exactly as captured.
//   • Retake — discard the candidate; the existing camera mode/slot is restored.
//
// This component never re-encodes, persists, queues, or alters the dataUrl.
// It also never creates or removes queue records.

/**
 * @param {object}   props
 * @param {string}   props.dataUrl       Preview data URL (passed through unchanged on Keep).
 * @param {string[]} props.warnings      Non-empty array of warning strings ('dark', 'blur', …).
 * @param {function} props.onKeep        Called with the original dataUrl when the user keeps the photo.
 * @param {function} props.onRetake      Called with no args when the user retakes the photo.
 */
export default function PhotoQualityReview({ dataUrl, warnings, onKeep, onRetake }) {
  const isDark = warnings.includes('dark');
  const isBlur = warnings.includes('blur');

  let headline = 'Photo may need a retake';
  const tips = [];
  if (isDark && isBlur) {
    headline = 'Photo looks dark and blurry';
    tips.push('Move closer to a light source or step into better lighting.');
    tips.push('Hold the phone steady and wait for the camera to focus.');
  } else if (isDark) {
    headline = 'Photo looks too dark';
    tips.push('Move closer to a light source or step into better lighting.');
  } else if (isBlur) {
    headline = 'Photo looks blurry';
    tips.push('Hold the phone steady and wait for the camera to focus before shooting.');
  }

  // Overlay sits above the camera (z-index 300 > camera's 200).
  const overlay = {
    position: 'fixed',
    inset: 0,
    zIndex: 300,
    background: 'rgba(0,0,0,0.88)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px 20px calc(24px + env(safe-area-inset-bottom))',
    gap: 20,
    color: '#f5f3ee',
  };
  const previewStyle = {
    width: '100%',
    maxWidth: 340,
    maxHeight: '38vh',
    objectFit: 'contain',
    borderRadius: 10,
    border: '2px solid rgba(255,255,255,.18)',
  };
  const badgeRow = {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
    justifyContent: 'center',
  };
  const badge = (label, color) => (
    <span key={label} style={{
      background: color,
      color: '#fff',
      fontWeight: 700,
      fontSize: 12,
      letterSpacing: 1,
      padding: '4px 10px',
      borderRadius: 20,
    }}>
      {label}
    </span>
  );
  const btnBase = {
    flex: 1,
    maxWidth: 180,
    padding: '14px 0',
    borderRadius: 10,
    fontWeight: 700,
    fontSize: 15,
    letterSpacing: 0.5,
    cursor: 'pointer',
    border: 'none',
  };

  return (
    <div style={overlay} role="dialog" aria-modal="true" aria-label="Photo quality review">
      <img src={dataUrl} alt="Captured photo preview" style={previewStyle} />

      <div style={badgeRow}>
        {isDark && badge('TOO DARK', '#7a4200')}
        {isBlur && badge('BLURRY', '#2e4a7a')}
      </div>

      <div style={{ textAlign: 'center', maxWidth: 320 }}>
        <div style={{ fontWeight: 700, fontSize: 17, marginBottom: 8 }}>{headline}</div>
        {tips.map((t, i) => (
          <div key={i} style={{ fontSize: 14, color: '#c8c0b4', lineHeight: 1.5 }}>{t}</div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 12, width: '100%', maxWidth: 380, justifyContent: 'center' }}>
        <button
          onClick={onRetake}
          aria-label="Retake photo"
          style={{ ...btnBase, background: 'rgba(255,255,255,.12)', color: '#f5f3ee', border: '1.5px solid rgba(255,255,255,.3)' }}
        >
          Retake
        </button>
        <button
          onClick={() => onKeep(dataUrl)}
          aria-label="Keep photo"
          style={{ ...btnBase, background: '#b0322a', color: '#fff' }}
        >
          Keep Photo
        </button>
      </div>
    </div>
  );
}
