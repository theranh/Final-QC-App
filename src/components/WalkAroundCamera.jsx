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
  const gravRef = useRef(null); // last gravity reading {x,y,t} for the rotation-lock fix
  const motionOnRef = useRef(false);
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
  // Gravity readings power the old Body Quoter's rotation-lock fix: if the
  // phone is held sideways but the feed is still portrait, the shot gets
  // rotated upright at capture time.
  const onMotion = useCallback((e) => {
    const g = e.accelerationIncludingGravity;
    if (g && (g.x != null)) gravRef.current = { x: g.x, y: g.y, t: Date.now() };
  }, []);
  const enableMotion = useCallback(() => {
    if (motionOnRef.current) return;
    const attach = () => { motionOnRef.current = true; window.addEventListener('devicemotion', onMotion); };
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      DeviceMotionEvent.requestPermission().then((r) => { if (r === 'granted') attach(); }).catch(() => {});
    } else if (typeof DeviceMotionEvent !== 'undefined') attach();
  }, [onMotion]);
  useEffect(() => {
    enableMotion();
    return () => { if (motionOnRef.current) window.removeEventListener('devicemotion', onMotion); };
  }, [enableMotion, onMotion]);
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
  // Capture logic ported verbatim from the old Body Quoter app: crop to the
  // visible (object-fit: cover) region, apply digital-zoom crop, and rotate
  // upright only in the rotation-lock case (portrait feed, phone sideways).
  const capture = async () => {
    enableMotion(); // iOS needs a user gesture to grant motion access
    setFlash(true); setTimeout(() => setFlash(false), 160);
    const v = videoRef.current;
    if (!v?.videoWidth) { fileRef.current?.click(); return; }
    let rot = 0;
    const gv = gravRef.current;
    const fresh = gv && (Date.now() - gv.t) < 1500;
    if (fresh && v.videoHeight > v.videoWidth) {
      if (Math.abs(gv.x) > Math.abs(gv.y) && Math.abs(gv.x) > 4) rot = gv.x > 0 ? -90 : 90;
      else if (Math.abs(gv.y) > Math.abs(gv.x) && gv.y < -4) rot = 180;
    }
    let sx = 0, sy = 0, sw = v.videoWidth, sh = v.videoHeight;
    const ew = v.clientWidth, eh = v.clientHeight;
    if (ew > 0 && eh > 0) {
      const va = v.videoWidth / v.videoHeight, ea = ew / eh;
      if (va > ea) { sw = Math.round(v.videoHeight * ea); sx = Math.round((v.videoWidth - sw) / 2); }
      else if (va < ea) { sh = Math.round(v.videoWidth / ea); sy = Math.round((v.videoHeight - sh) / 2); }
    }
    const dz = nativeZooms.length ? 1 : Math.max(1, zoomRef.current);
    if (dz > 1) {
      const nw = sw / dz, nh = sh / dz;
      sx += (sw - nw) / 2; sy += (sh - nh) / 2; sw = nw; sh = nh;
    }
    const canvas = canvasRef.current || document.createElement('canvas');
    const r = Math.min(1, MAX / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * r)); const h = Math.max(1, Math.round(sh * r));
    const swap = Math.abs(rot) === 90;
    canvas.width = swap ? h : w; canvas.height = swap ? w : h;
    const ctx = canvas.getContext('2d');
    ctx.save();
    if (rot) { ctx.translate(canvas.width / 2, canvas.height / 2); ctx.rotate(rot * Math.PI / 180); ctx.drawImage(v, sx, sy, sw, sh, -w / 2, -h / 2, w, h); }
    else ctx.drawImage(v, sx, sy, sw, sh, 0, 0, w, h);
    ctx.restore();
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
  const skipOrCancel = () => (mode === 'damage' ? setMode('guided') : (setSkipped((p) => ({ ...p, [slot.key]: true })), setCurrent(nextUntakenSlot(WALK_SLOTS, taken, current + 1) || current)));
  // Translucent dark camera-chrome buttons (never the app's white .btn styles)
  const chromeBtn = { border: '1px solid rgba(255,255,255,.28)', borderRadius: 20, background: 'rgba(28,26,23,.65)', color: '#f5f3ee', fontSize: 12, fontWeight: 600, letterSpacing: 1, padding: '10px 14px' };
  const roundBtn = { ...chromeBtn, borderRadius: '50%', width: 42, height: 42, padding: 0, fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(35,32,26,.72)', border: '2px solid rgba(255,255,255,.5)' };
  // Shutter styled like the old Body Quoter: solid white with a translucent ring.
  const shutterBtn = <button onClick={capture} aria-label="Take photo" style={{ width: 78, height: 78, borderRadius: '50%', background: '#fff', backgroundClip: 'padding-box', border: '5px solid rgba(255,255,255,.4)', flex: 'none', padding: 0 }} />;
  // Latest shot thumbnail + count badge (old Body Quoter's gallery button) — opens the shot list.
  const lastShot = [...WALK_SLOTS].reverse().map((s) => photos[s.key]?.thumb).find(Boolean);
  const galleryBtn = (
    <button onClick={() => setMode('review')} aria-label="Open photo gallery" style={{ position: 'relative', flex: 'none', width: 64, height: 64, padding: 0, border: '2px solid #fff', borderRadius: 12, background: '#000', overflow: 'visible' }}>
      {lastShot ? <img src={lastShot} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 9 }} /> : <span style={{ color: '#aaa092', fontSize: 10 }}>SHOTS</span>}
      {progress.captured > 0 && <span style={{ position: 'absolute', right: -6, top: -6, background: '#b0322a', color: '#fff', fontWeight: 700, fontSize: 12, minWidth: 20, height: 20, lineHeight: '20px', borderRadius: 10, padding: '0 4px' }}>{progress.captured}</span>}
    </button>
  );
  // Zoom selector mirroring the native iPhone camera: plain white numbers
  // floating over the image; only the selected zoom gets a dark circle with
  // the yellow "0.5x"-style label.
  const zoomDial = (vertical) => (
    <div style={{ display: 'flex', flexDirection: vertical ? 'column' : 'row', alignItems: 'center', gap: 6, background: 'rgba(20,18,15,.28)', borderRadius: 24, padding: 5 }}>
      {shownZooms.map((z) => {
        const sel = zoom === z;
        return (
          <button key={z} onClick={() => setZoom(z)} aria-label={`${z}x zoom`} style={{ flex: 'none', width: 38, height: 38, borderRadius: '50%', border: 'none', background: sel ? 'rgba(35,32,26,.78)' : 'transparent', color: sel ? '#f7c948' : '#fff', fontWeight: 700, fontSize: sel ? 13 : 15, padding: 0, textShadow: sel ? 'none' : '0 1px 3px rgba(0,0,0,.6)' }}>
            {sel ? `${z}x` : String(z)}
          </button>
        );
      })}
    </div>
  );
  const frame = (
    <div style={{ position: 'relative', flex: 'none', width: '100%', maxWidth: landscape ? 'calc((100dvh) * 4 / 3)' : '100%', maxHeight: '100%', aspectRatio: landscape ? '4 / 3' : '3 / 4', overflow: 'hidden', background: '#080807', alignSelf: 'center' }}>
      <video ref={videoRef} autoPlay playsInline muted style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', transform: `scale(${nativeZooms.length ? 1 : Math.max(1, zoom)})` }} />
      {mode === 'damage' && <div style={{ position: 'absolute', top: 10, left: 12, right: 12, textAlign: 'center', textShadow: '0 1px 4px rgba(0,0,0,.8)', pointerEvents: 'none', fontSize: 15, color: '#f0e6d5' }}>DAMAGE CLOSE-UP</div>}
      {error && <div style={{ position: 'absolute', bottom: 16, left: 16, right: 16, padding: 12, borderRadius: 8, background: 'rgba(58,54,47,.9)', color: '#f2c8a8', textAlign: 'center', fontSize: 12 }}>{error}</div>}
      {!landscape && !error && <div style={{ position: 'absolute', bottom: 10, left: 0, right: 0, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}><div style={{ pointerEvents: 'auto' }}>{zoomDial(false)}</div></div>}
    </div>
  );
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 200, background: '#171512', color: '#f5f3ee', display: 'flex', flexDirection: 'column' }}>
      <canvas ref={canvasRef} style={{ display: 'none' }} />
      <input ref={fileRef} type="file" accept="image/*" capture="environment" onChange={onFile} style={{ display: 'none' }} />
      {(!landscape || mode === 'review') && <div style={{ padding: 'calc(10px + env(safe-area-inset-top)) 14px 10px', display: 'flex', alignItems: 'center', gap: 12, background: '#000', flex: 'none' }}>
        <button aria-label="Close camera" onClick={onClose} style={roundBtn}>×</button>
        <div style={{ flex: 1, textAlign: 'center' }}><div className="card-title" style={{ color: '#d9d2c4' }}>{mode === 'damage' ? 'DAMAGE CLOSE-UP' : 'WALK-AROUND'}</div><div style={{ fontSize: 11, color: '#aaa092' }}>{mode === 'guided' ? `${progress.captured} / ${WALK_SLOTS.length} captured` : 'Close-ups go to the AI for the body quote.'}</div></div>
        {mode === 'guided' ? <button style={chromeBtn} onClick={() => setMode('review')}>Review</button> : <span style={{ width: 40 }} />}
      </div>}
      {mode === 'review' ? (
        <div style={{ padding: 16, overflow: 'auto' }}>
          <div className="card-title" style={{ color: '#d9d2c4', marginBottom: 12 }}>SHOT LIST · {progress.captured} TAKEN · {progress.skipped} SKIPPED</div>
          {['Exterior', 'Interior', 'Wheels / tires'].map((group) => <div key={group} style={{ marginBottom: 18 }}><div className="field-label" style={{ color: '#aaa092' }}>{group}</div><div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginTop: 7 }}>{WALK_SLOTS.filter((s) => s.group === group).map((s) => { const i = WALK_SLOTS.indexOf(s); return <button key={s.key} onClick={() => selectSlot(i)} style={{ aspectRatio: '1', padding: 0, overflow: 'hidden', borderRadius: 8, border: '1px solid #4a443c', background: taken[s.key] ? '#2e2a25' : '#25221e', color: '#d9d2c4', position: 'relative' }}>{photos[s.key]?.thumb ? <img src={photos[s.key].thumb} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span style={{ fontSize: 10, display: 'block', padding: 5 }}>{s.label}</span>}{skipped[s.key] && <b style={{ position: 'absolute', bottom: 3, left: 4, fontSize: 8, color: '#e7ad62' }}>SKIPPED</b>}</button>; })}</div></div>)}
          <button className="btn btn-red" onClick={() => setMode('guided')}>BACK TO CAMERA</button>
          <button className="btn btn-outline" style={{ marginTop: 8, color: '#f5f3ee', borderColor: '#5c554b' }} onClick={damage}>+ ADD DAMAGE CLOSE-UP</button>
        </div>
      ) : landscape ? (
        /* Landscape — like the iPhone camera turned sideways: full-height 4:3
           frame on the left, controls in a rail on the right. */
        <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'row', background: '#000', paddingLeft: 'env(safe-area-inset-left)' }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{frame}</div>
          <div style={{ flex: 'none', width: 118, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'space-between', padding: 'calc(8px + env(safe-area-inset-top)) calc(8px + env(safe-area-inset-right)) 8px 4px' }}>
            <button aria-label="Close camera" onClick={onClose} style={roundBtn}>✕</button>
            {zoomDial(true)}
            {shutterBtn}
            {mode === 'damage' ? <button style={chromeBtn} onClick={skipOrCancel}>CANCEL</button> : galleryBtn}
          </div>
          {flash && <div style={{ position: 'absolute', inset: 0, background: '#fff', opacity: .9, pointerEvents: 'none' }} />}
        </div>
      ) : (
        /* Portrait — header on top, 3:4 frame, controls below on solid black. */
        <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column', background: '#000' }}>
          <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{frame}</div>
          <div style={{ flex: 'none', padding: '12px 18px calc(16px + env(safe-area-inset-bottom))', background: '#000' }}>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              {mode === 'damage' ? <button style={{ ...chromeBtn, width: 84 }} onClick={skipOrCancel}>CANCEL</button> : galleryBtn}
              <span style={{ flex: 1 }} />
              {shutterBtn}
              <span style={{ flex: 1 }} />
              <span style={{ flex: 'none', width: mode === 'damage' ? 84 : 64 }} />
            </div>
          </div>
          {flash && <div style={{ position: 'absolute', inset: 0, background: '#fff', opacity: .9, pointerEvents: 'none' }} />}
        </div>
      )}
    </div>
  );
}