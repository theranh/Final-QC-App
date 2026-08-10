import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { WALK_SLOTS, nextUntakenSlot, putSlotPhoto, walkProgress } from '../lib/walkSlots';

const MAX = 1600;
function dataUrlImage(dataUrl, max = MAX, quality = 0.8, zoom = 1) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, max / Math.max(image.width, image.height));
      const sw = image.width / zoom; const sh = image.height / zoom;
      const sx = (image.width - sw) / 2; const sy = (image.height - sh) / 2;
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(sw * scale)); canvas.height = Math.max(1, Math.round(sh * scale));
      canvas.getContext('2d').drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    image.onerror = reject; image.src = dataUrl;
  });
}

export default function WalkAroundCamera({ quoteId, committed, initialMode = 'guided', onClose, onDamageCapture, showToast }) {
  const [taken, setTaken] = useState({});
  const [skipped, setSkipped] = useState({});
  const [current, setCurrent] = useState(0);
  const [photos, setPhotos] = useState({});
  const [mode, setMode] = useState(initialMode);
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  const [flash, setFlash] = useState(false);
  const [error, setError] = useState('');
  const [landscape, setLandscape] = useState(() => typeof window !== 'undefined' && window.matchMedia?.('(orientation: landscape)').matches);
  const [zoomCaps, setZoomCaps] = useState(null);
  const videoRef = useRef(null); const streamRef = useRef(null); const trackRef = useRef(null);
  const fileRef = useRef(null); const canvasRef = useRef(null);
  const progress = walkProgress(WALK_SLOTS, taken, skipped);
  const slot = WALK_SLOTS[current];
  const zooms = useMemo(() => [0.5, 1, 2, 3, 5], []);

  const stopCamera = useCallback(() => {
    if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);
  const startCamera = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) return;
    let cancelled = false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false });
      if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
      streamRef.current = stream; trackRef.current = stream.getVideoTracks()[0];
      if (videoRef.current) videoRef.current.srcObject = stream;
      const caps = trackRef.current.getCapabilities ? trackRef.current.getCapabilities() : {};
      setZoomCaps(caps.zoom || null);
      if (caps.zoom) trackRef.current.applyConstraints({ advanced: [{ zoom: Math.max(caps.zoom.min, Math.min(caps.zoom.max, zoomRef.current)) }] }).catch(() => {});
    } catch { if (!cancelled) setError('Camera unavailable. Choose a photo from your device instead.'); }
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    let cancel;
    Promise.resolve(startCamera()).then((cleanup) => { cancel = cleanup; });
    return () => { if (cancel) cancel(); stopCamera(); };
  }, [startCamera, stopCamera]);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  useEffect(() => {
    const mq = window.matchMedia?.('(orientation: landscape)');
    if (!mq) return;
    const onChange = (e) => setLandscape(e.matches);
    mq.addEventListener ? mq.addEventListener('change', onChange) : mq.addListener(onChange);
    return () => { mq.removeEventListener ? mq.removeEventListener('change', onChange) : mq.removeListener(onChange); };
  }, []);
  useEffect(() => {
    const track = trackRef.current; const caps = track?.getCapabilities?.();
    if (track && caps?.zoom) track.applyConstraints({ advanced: [{ zoom: Math.max(caps.zoom.min, Math.min(caps.zoom.max, zoom)) }] }).catch(() => {});
  }, [zoom]);

  const nativeZooms = zoomCaps ? zooms.filter((z) => z >= zoomCaps.min && z <= zoomCaps.max) : [];
  const shownZooms = nativeZooms.length ? nativeZooms : [1, 2, 3];

  const saveGuided = async (dataUrl) => {
    if (committed) return;
    const thumb = await dataUrlImage(dataUrl, 340, 0.7, 1);
    const id = `${quoteId}_${slot.key}`.slice(0, 60);
    try {
      await api.putQuotePhoto({ id, quoteId, slot: slot.key, dataUrl });
      setPhotos((p) => putSlotPhoto(p, slot.key, { id, thumb, dataUrl }));
      setTaken((p) => ({ ...p, [slot.key]: true }));
      setSkipped((p) => ({ ...p, [slot.key]: false }));
      const next = nextUntakenSlot(WALK_SLOTS, { ...taken, [slot.key]: true }, current + 1);
      if (next >= 0) setCurrent(next);
    } catch (e) {
      showToast?.(e.status === 413 ? 'Photo is too large — try again closer or with less zoom.' : e.status === 409 ? 'This quote is committed and cannot accept photos.' : 'Photo could not be saved.');
    }
  };
  const capture = async () => {
    setFlash(true); setTimeout(() => setFlash(false), 160);
    if (!videoRef.current?.videoWidth) { fileRef.current?.click(); return; }
    const video = videoRef.current; const canvas = canvasRef.current || document.createElement('canvas');
    const aspect = video.clientWidth / video.clientHeight; let w = video.videoWidth; let h = Math.round(w / aspect);
    if (h > video.videoHeight) { h = video.videoHeight; w = Math.round(h * aspect); }
    // Only digital zoom (crop) applies when the camera lacks native zoom;
    // the video feed itself is already orientation-correct, so no rotation
    // compensation is needed — rotating here corrupts captures.
    const z = nativeZooms.length ? 1 : Math.max(1, zoomRef.current);
    w /= z; h /= z;
    const scale = Math.min(1, MAX / Math.max(w, h));
    canvas.width = Math.max(1, Math.round(w * scale)); canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, (video.videoWidth - w) / 2, (video.videoHeight - h) / 2, w, h, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
    if (mode === 'damage') { if (!committed) onDamageCapture?.(dataUrl); }
    else await saveGuided(dataUrl);
  };
  const onFile = async (event) => {
    const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
    const reader = new FileReader(); reader.onload = async () => {
      if (committed) return;
      const normalized = await dataUrlImage(reader.result, MAX, 0.8, zoomRef.current);
      if (mode === 'damage') onDamageCapture?.(normalized); else await saveGuided(normalized);
    }; reader.readAsDataURL(file);
  };
  const damage = () => { if (!committed) setMode('damage'); };
  const selectSlot = (i) => { setMode('guided'); setCurrent(i); };
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 200, background: '#171512', color: '#f5f3ee', display: 'flex', flexDirection: 'column' }}>
      <canvas ref={canvasRef} style={{ display: 'none' }} />
      <input ref={fileRef} type="file" accept="image/*" capture="environment" onChange={onFile} style={{ display: 'none' }} />
      {(!landscape || mode === 'review') && <div style={{ padding: 'calc(12px + env(safe-area-inset-top)) 16px 12px', display: 'flex', alignItems: 'center', gap: 12, borderBottom: '1px solid #3a362f' }}>
        <button className="btn btn-outline" style={{ color: '#f5f3ee', borderColor: '#5c554b', width: 42, padding: 8 }} onClick={onClose}>×</button>
        <div style={{ flex: 1 }}><div className="card-title" style={{ color: '#d9d2c4' }}>{mode === 'damage' ? 'DAMAGE CLOSE-UP' : 'WALK-AROUND'}</div><div style={{ fontSize: 12, color: '#aaa092' }}>{mode === 'guided' ? `${progress.captured} / ${WALK_SLOTS.length} captured` : 'Found damage? Take a close-up of each spot — these go to the AI for the body quote.'}</div></div>
        {mode === 'guided' && <button className="btn btn-outline" style={{ color: '#f5f3ee', borderColor: '#5c554b', padding: '8px 10px' }} onClick={() => setMode('review')}>Review</button>}
      </div>}
      {mode === 'review' ? (
        <div style={{ padding: 16, overflow: 'auto' }}>
          <div className="card-title" style={{ color: '#d9d2c4', marginBottom: 12 }}>SHOT LIST · {progress.captured} TAKEN · {progress.skipped} SKIPPED</div>
          {['Exterior', 'Interior', 'Wheels / tires'].map((group) => <div key={group} style={{ marginBottom: 18 }}><div className="field-label" style={{ color: '#aaa092' }}>{group}</div><div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginTop: 7 }}>{WALK_SLOTS.filter((s) => s.group === group).map((s) => { const i = WALK_SLOTS.indexOf(s); return <button key={s.key} onClick={() => selectSlot(i)} style={{ aspectRatio: '1', padding: 0, overflow: 'hidden', borderRadius: 8, border: '1px solid #4a443c', background: taken[s.key] ? '#2e2a25' : '#25221e', color: '#d9d2c4', position: 'relative' }}>{photos[s.key]?.thumb ? <img src={photos[s.key].thumb} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span style={{ fontSize: 10, display: 'block', padding: 5 }}>{s.label}</span>}{skipped[s.key] && <b style={{ position: 'absolute', bottom: 3, left: 4, fontSize: 8, color: '#e7ad62' }}>SKIPPED</b>}</button>; })}</div></div>)}
          <button className="btn btn-red" onClick={() => setMode('guided')}>BACK TO CAMERA</button>
          <button className="btn btn-outline" style={{ marginTop: 8, color: '#f5f3ee', borderColor: '#5c554b' }} onClick={damage}>+ ADD DAMAGE CLOSE-UP</button>
        </div>
      ) : (
        <div style={{ flex: 1, position: 'relative', display: 'flex', flexDirection: 'column', justifyContent: 'center', background: '#080807' }}>
          {mode !== 'review' && <><video ref={videoRef} autoPlay playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover', transform: `scale(${nativeZooms.length ? 1 : Math.max(1, zoom)})` }} /><div style={{ position: 'absolute', top: 16, left: 16, right: 16, textAlign: 'center' }}>{mode === 'guided' ? <><div style={{ fontFamily: 'var(--font-display, sans-serif)', fontSize: 27, fontWeight: 700 }}>{slot.label}</div><div style={{ fontFamily: 'monospace', fontSize: 12, marginTop: 4, color: '#d9d2c4' }}>{current + 1} / 24</div></> : <div style={{ fontSize: 15, color: '#f0e6d5' }}>DAMAGE CLOSE-UP</div>}</div></>}
          {landscape && (
            <>
              <button aria-label="Close camera" onClick={onClose} style={{ position: 'absolute', top: 'calc(10px + env(safe-area-inset-top))', left: 'calc(12px + env(safe-area-inset-left))', width: 40, height: 40, borderRadius: '50%', border: '1px solid rgba(255,255,255,.35)', background: 'rgba(0,0,0,.45)', color: '#f5f3ee', fontSize: 18 }}>×</button>
              {mode === 'guided' && <button onClick={() => setMode('review')} style={{ position: 'absolute', top: 'calc(10px + env(safe-area-inset-top))', right: 'calc(12px + env(safe-area-inset-right))', borderRadius: 20, border: '1px solid rgba(255,255,255,.35)', background: 'rgba(0,0,0,.45)', color: '#f5f3ee', fontSize: 12, padding: '9px 14px' }}>Review</button>}
            </>
          )}
          {error && <div style={{ position: 'absolute', bottom: 120, left: 20, right: 20, padding: 12, borderRadius: 8, background: '#3a362f', color: '#f2c8a8', textAlign: 'center', fontSize: 12 }}>{error}</div>}
          <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: '16px 18px calc(18px + env(safe-area-inset-bottom))', background: 'linear-gradient(transparent, rgba(0,0,0,.85))' }}>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginBottom: 14 }}>{shownZooms.map((z) => <button key={z} onClick={() => setZoom(z)} style={{ border: 0, borderRadius: 20, padding: '6px 9px', background: zoom === z ? '#b0322a' : '#332f2a', color: '#fff', fontSize: 11 }}>{z}×</button>)}</div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}><button className="btn btn-outline" style={{ color: '#fff', borderColor: '#776e62' }} onClick={() => mode === 'damage' ? setMode('guided') : (setSkipped((p) => ({ ...p, [slot.key]: true })), setCurrent(nextUntakenSlot(WALK_SLOTS, taken, current + 1) || current))}>{mode === 'damage' ? 'CANCEL' : 'SKIP'}</button><button onClick={capture} aria-label="Take photo" style={{ width: 72, height: 72, borderRadius: '50%', background: '#f5f3ee', border: '7px solid rgba(255,255,255,.3)', boxShadow: '0 0 0 2px #f5f3ee' }} /><button className="btn btn-outline" style={{ color: '#fff', borderColor: '#776e62' }} onClick={() => setMode('review')}>DONE</button></div>
          </div>
          {flash && <div style={{ position: 'absolute', inset: 0, background: '#fff', opacity: .9, pointerEvents: 'none' }} />}
        </div>
      )}
    </div>
  );
}