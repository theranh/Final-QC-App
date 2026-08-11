import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { WALK_SLOTS, nextUntakenSlot, putSlotPhoto, walkProgress } from '../lib/walkSlots';
import { persistJob, removeJob, removeJobsForPhoto, pendingJobs, newJobKey, setCameraOpen } from '../lib/photoQueue';

const MAX = 1600;
// iOS (all iPhone/iPad browsers, incl. iPadOS Safari that masquerades as Mac).
const IS_IOS = typeof navigator !== 'undefined' &&
  (/iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
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

export default function WalkAroundCamera({ quoteId, committed, addOnly = false, initialMode = 'guided', onClose, onDamageCapture, showToast }) {
  const [taken, setTaken] = useState({});
  const [skipped, setSkipped] = useState({});
  const [current, setCurrent] = useState(0);
  const [photos, setPhotos] = useState({});
  // Upload safety net: shots that failed to reach the server wait here and
  // are retried automatically (every few seconds + when the network returns),
  // so a weak-signal moment in the shop can't quietly lose pictures.
  const [pendingCount, setPendingCount] = useState(0);
  const queueRef = useRef([]); // [{ id, slotKey, dataUrl, prev }]
  const retryBusyRef = useRef(false);
  const closeWarnRef = useRef(0);
  const takenRef = useRef({}); // latest taken map for async callbacks
  useEffect(() => { takenRef.current = taken; }, [taken]);
  const interactedRef = useRef(false); // user captured/picked a slot already

  // While the camera is open it owns the retry loop, so the app-level flusher
  // pauses. Any photos persisted for this quote in an earlier force-closed
  // session are picked back up into the in-memory queue here.
  useEffect(() => {
    setCameraOpen(true);
    let live = true;
    if (quoteId) {
      pendingJobs(quoteId).then((jobs) => {
        if (!live) return;
        for (const job of jobs) {
          if (!queueRef.current.some((j) => j.id === job.id)) queueRef.current.push(job);
        }
        if (queueRef.current.length) setPendingCount(queueRef.current.length);
      });
    }
    return () => { live = false; setCameraOpen(false); };
  }, [quoteId]);
  const [serverLoaded, setServerLoaded] = useState(false); // preload finished (or failed)

  // Resume where the truck left off: existing server photos mark their slots
  // as taken (with thumbnails), so reopening the camera never shows 0/24 for
  // a truck that already has shots — and add-only mode knows what's missing.
  useEffect(() => {
    let live = true;
    if (!quoteId) return undefined;
    api.quotePhotos(quoteId).then((j) => {
      if (!live) return;
      const walkKeys = new Set(WALK_SLOTS.map((s) => s.key));
      const takenMap = {}; const photoMap = {};
      for (const p of j?.photos || []) {
        if (!walkKeys.has(p.slot)) continue;
        takenMap[p.slot] = true;
        photoMap[p.slot] = { id: p.id, thumb: `/api/quoter/photo?id=${encodeURIComponent(p.id)}` };
      }
      if (Object.keys(takenMap).length) {
        setTaken((prev) => ({ ...takenMap, ...prev }));
        setPhotos((prev) => ({ ...photoMap, ...prev }));
        // Only steer the camera if the tech hasn't started shooting/picking:
        // never yank the viewfinder away mid-session. Compute from the merged
        // map (server + in-session) so we don't jump to a slot they just shot.
        if (!interactedRef.current) {
          const merged = { ...takenMap, ...takenRef.current };
          setCurrent((cur) => {
            const next = nextUntakenSlot(WALK_SLOTS, merged, cur);
            return next >= 0 ? next : cur;
          });
        }
      }
      setServerLoaded(true);
    }).catch(() => { if (live) setServerLoaded(true); /* offline — start fresh; uploads queue anyway */ });
    return () => { live = false; };
  }, [quoteId]);
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
  // Resolves once the listener is attached (or permission is denied), so a
  // caller can wait for gravity to start flowing before it matters.
  const enableMotion = useCallback(() => {
    if (motionOnRef.current) return Promise.resolve();
    const attach = () => { motionOnRef.current = true; window.addEventListener('devicemotion', onMotion); };
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      return DeviceMotionEvent.requestPermission().then((r) => { if (r === 'granted') attach(); }).catch(() => {});
    }
    if (typeof DeviceMotionEvent !== 'undefined') attach();
    return Promise.resolve();
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

  // Upload one photo; on a network/server hiccup, park it in the retry queue
  // instead of dropping it. Permanent rejections (committed / too large) are
  // surfaced and the slot is rolled back so the tech can react.
  const uploadPhoto = useCallback(async (job, { fromRetry = false } = {}) => {
    try {
      await api.putQuotePhoto({ id: job.id, quoteId, slot: job.slotKey, dataUrl: job.dataUrl });
      queueRef.current = queueRef.current.filter((j) => j.id !== job.id);
      setPendingCount(queueRef.current.length);
      // Clear only THIS capture's on-disk copy: a retake of the same slot may
      // already have persisted a newer record, which must stay queued.
      removeJob(job.key);
      return true;
    } catch (e) {
      if (e.status === 413 || e.status === 409 || e.status === 403) {
        // Permanent — retrying won't help. Restore what the slot showed before
        // this shot (a prior server photo stays visible; an empty slot empties).
        queueRef.current = queueRef.current.filter((j) => j.id !== job.id);
        setPendingCount(queueRef.current.length);
        removeJob(job.key); // retrying can never succeed — drop the on-disk copy too
        setTaken((p) => ({ ...p, [job.slotKey]: !!job.prev }));
        setPhotos((p) => ({ ...p, [job.slotKey]: job.prev || undefined }));
        showToast?.(e.status === 413 ? 'Photo is too large — try again closer or with less zoom.' : 'This quote is locked and cannot accept photos.');
        return false;
      }
      // Transient (offline / server blip / signed out): keep it queued —
      // in memory AND on disk — for auto-retry. A 401 clears itself once the
      // tech signs back in, so the shot must survive until then.
      if (!queueRef.current.some((j) => j.id === job.id)) queueRef.current.push(job);
      setPendingCount(queueRef.current.length);
      if (!fromRetry) showToast?.(e.status === 401 ? 'Signed out — photo saved, it will send after you sign in again.' : 'Weak signal — photo saved on screen, sending in background…');
      return false;
    }
  }, [quoteId, showToast]);

  // Auto-retry loop: every 5s while shots are waiting, plus immediately when
  // the network comes back.
  useEffect(() => {
    const flush = async () => {
      if (retryBusyRef.current || !queueRef.current.length) return;
      retryBusyRef.current = true;
      try {
        for (const job of [...queueRef.current]) {
           
          await uploadPhoto(job, { fromRetry: true });
        }
      } finally { retryBusyRef.current = false; }
    };
    const t = setInterval(flush, 5000);
    window.addEventListener('online', flush);
    return () => { clearInterval(t); window.removeEventListener('online', flush); };
  }, [uploadPhoto]);

  // Extra photos (after-the-fact shots on a saved truck): each capture gets a
  // fresh timestamped slot/id, so nothing existing can ever be overwritten.
  const saveExtra = async (dataUrl) => {
    if (committed) return;
    const thumb = await dataUrlImage(dataUrl, 340, 0.7, 1);
    // Timestamp + random tail: two shots in the same millisecond (fast
    // double-tap) must never collide into one id and silently drop a photo.
    const tag = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const slotKey = `xtra_${tag}`;
    const id = `${quoteId}_x${tag}`.slice(0, 60);
    setPhotos((p) => putSlotPhoto(p, slotKey, { id, thumb, dataUrl }));
    await uploadPhoto({ id, slotKey, dataUrl });
  };
  const extraShots = Object.keys(photos).filter((k) => k.startsWith('xtra_') && photos[k]);

  const saveGuided = async (dataUrl) => {
    if (committed) return;
    if (addOnly) {
      // Never overwrite a saved photo: wait until we know which spots the
      // server already has, and refuse occupied ones.
      if (!serverLoaded) { showToast?.('Checking which photos exist — try again in a second.'); return; }
      if (taken[slot.key]) { showToast?.('That spot already has a photo — saved photos can’t be replaced.'); return; }
    }
    const thumb = await dataUrlImage(dataUrl, 340, 0.7, 1);
    const id = `${quoteId}_${slot.key}`.slice(0, 60);
    const slotKey = slot.key;
    const prev = photos[slotKey]; // restored if the upload is permanently rejected
    // Optimistic: show the shot and advance right away; the upload (or its
    // retry queue) catches up in the background.
    // Persist to disk BEFORE the upload attempt — and wait for the write to
    // commit — so even a force-close mid-send (or a dead battery) can't lose
    // the shot: it flushes on next app open. If IndexedDB is unavailable
    // (private mode / quota), persistJob resolves anyway and the in-memory
    // retry queue still covers the session. The key is unique per CAPTURE,
    // so an in-flight older upload for this slot can only ever delete its
    // own record, never this one.
    const key = newJobKey(id);
    await persistJob({ key, id, quoteId, slotKey, dataUrl });
    // This shot supersedes any earlier queued capture of the same slot —
    // purge them (disk + memory) so a stale retry can't overwrite it.
    await removeJobsForPhoto(id, key);
    queueRef.current = queueRef.current.filter((j) => j.id !== id);
    setPendingCount(queueRef.current.length);
    setPhotos((p) => putSlotPhoto(p, slotKey, { id, thumb, dataUrl }));
    setTaken((p) => ({ ...p, [slotKey]: true }));
    setSkipped((p) => ({ ...p, [slotKey]: false }));
    const next = nextUntakenSlot(WALK_SLOTS, { ...taken, [slotKey]: true }, current + 1);
    if (next >= 0) setCurrent(next);
    await uploadPhoto({ key, id, slotKey, dataUrl, prev });
  };

  // Leaving with unsent shots would lose them — hold the door once.
  const requestClose = () => {
    if (queueRef.current.length && Date.now() - closeWarnRef.current > 4000) {
      closeWarnRef.current = Date.now();
      showToast?.(`Still sending ${queueRef.current.length} photo${queueRef.current.length === 1 ? '' : 's'} — give it a few seconds, or tap ✕ again to leave anyway.`);
      return;
    }
    onClose();
  };
  // Capture logic ported verbatim from the old Body Quoter app: crop to the
  // visible (object-fit: cover) region, apply digital-zoom crop, and rotate
  // upright only in the rotation-lock case (portrait feed, phone sideways).
  const capture = async () => {
    interactedRef.current = true; // preload must not steer the camera anymore
    setFlash(true); setTimeout(() => setFlash(false), 160);
    const v = videoRef.current;
    if (!v?.videoWidth) { fileRef.current?.click(); return; }
    // Rotation-lock fix needs a gravity reading. If none has arrived yet
    // (shutter can be the session's very first tap) and the feed is portrait,
    // finish the permission handshake and give the sensor a beat to report —
    // bounded so the shutter never feels stuck. Once readings flow, this
    // costs nothing on later shots.
    if (v.videoHeight > v.videoWidth && !(gravRef.current && (Date.now() - gravRef.current.t) < 1500)) {
      await enableMotion(); // iOS grants motion access only from a user gesture
      for (let i = 0; i < 4 && !gravRef.current; i += 1) await new Promise((r) => setTimeout(r, 60));
    }
    let rot = 0;
    const gv = gravRef.current;
    const fresh = gv && (Date.now() - gv.t) < 1500;
    if (fresh && v.videoHeight > v.videoWidth) {
      // iOS reports accelerationIncludingGravity with the opposite sign to
      // Android: held upright, iOS gives y ≈ -9.8 while Android gives +9.8.
      // Without this flip every upright portrait shot on iPhone matched the
      // "upside down" branch and got rotated 180° — photos came out flipped.
      const S = IS_IOS ? -1 : 1;
      const gx = gv.x * S, gy = gv.y * S;
      if (Math.abs(gx) > Math.abs(gy) && Math.abs(gx) > 4) rot = gx > 0 ? -90 : 90;
      else if (Math.abs(gy) > Math.abs(gx) && gy < -4) rot = 180;
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
    else if (mode === 'extra') await saveExtra(dataUrl);
    else await saveGuided(dataUrl);
  };
  const onFile = async (event) => {
    const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
    const reader = new FileReader(); reader.onload = async () => {
      if (committed) return;
      const normalized = await dataUrlImage(reader.result, MAX, 0.8, zoomRef.current);
      if (mode === 'damage') onDamageCapture?.(normalized); else if (mode === 'extra') await saveExtra(normalized); else await saveGuided(normalized);
    }; reader.readAsDataURL(file);
  };
  const damage = () => { if (!committed && !addOnly) setMode('damage'); };
  const selectSlot = (i) => {
    if (addOnly && taken[WALK_SLOTS[i].key]) { showToast?.('That spot already has a photo — saved photos can’t be replaced.'); return; }
    interactedRef.current = true;
    setMode('guided'); setCurrent(i);
  };
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
  // Extra mode's bottom-left: last extra shot + count (display only).
  const lastExtra = extraShots.length ? photos[extraShots[extraShots.length - 1]]?.thumb : null;
  const extraThumb = (
    <div aria-label="Extra photos taken" style={{ position: 'relative', flex: 'none', width: 64, height: 64, border: '2px solid #fff', borderRadius: 12, background: '#000', overflow: 'visible' }}>
      {lastExtra ? <img src={lastExtra} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 9 }} /> : <span style={{ color: '#aaa092', fontSize: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>EXTRAS</span>}
      {extraShots.length > 0 && <span style={{ position: 'absolute', right: -6, top: -6, background: '#b0322a', color: '#fff', fontWeight: 700, fontSize: 12, minWidth: 20, height: 20, lineHeight: '20px', borderRadius: 10, padding: '0 4px' }}>{extraShots.length}</span>}
    </div>
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
    // onPointerDown: iOS only grants motion-sensor access from a user gesture,
    // and without it the rotation-lock fix has no gravity data — the FIRST tap
    // anywhere in the camera (not just the shutter) asks for permission, so
    // by the time the shutter fires the reading is already flowing. Without
    // this, the first shot of a session (or every shot, if permission was
    // asked mid-capture and dismissed) saved sideways when the phone was held
    // landscape with the iPhone orientation lock on.
    <div onPointerDown={enableMotion} style={{ position: 'fixed', inset: 0, zIndex: 200, background: '#171512', color: '#f5f3ee', display: 'flex', flexDirection: 'column' }}>
      <canvas ref={canvasRef} style={{ display: 'none' }} />
      <input ref={fileRef} type="file" accept="image/*" capture="environment" onChange={onFile} style={{ display: 'none' }} />
      {(!landscape || mode === 'review') && <div style={{ padding: 'calc(10px + env(safe-area-inset-top)) 14px 10px', display: 'flex', alignItems: 'center', gap: 12, background: '#000', flex: 'none' }}>
        <button aria-label="Close camera" onClick={requestClose} style={roundBtn}>×</button>
        <div style={{ flex: 1, textAlign: 'center' }}><div className="card-title" style={{ color: '#d9d2c4' }}>{mode === 'damage' ? 'DAMAGE CLOSE-UP' : mode === 'extra' ? 'EXTRA PHOTOS' : addOnly ? 'ADD MISSING PHOTOS' : 'WALK-AROUND'}</div><div style={{ fontSize: 11, color: '#aaa092' }}>{mode === 'extra' ? `${extraShots.length} added${pendingCount ? ` · sending ${pendingCount}…` : ''}` : mode === 'guided' ? `${progress.captured} / ${WALK_SLOTS.length} captured${pendingCount ? ` · sending ${pendingCount}…` : ''}` : 'Close-ups go to the AI for the body quote.'}</div></div>
        {mode === 'guided' ? <button style={chromeBtn} onClick={() => setMode('review')}>Review</button> : <span style={{ width: 40 }} />}
      </div>}
      {mode === 'extra' && !landscape && <div style={{ padding: '6px 14px', background: '#000', flex: 'none', textAlign: 'center', fontSize: 11, color: '#aaa092' }}>Every shot is added as a new photo — nothing already saved is touched.</div>}
      {mode === 'review' ? (
        <div style={{ padding: 16, overflow: 'auto' }}>
          <div className="card-title" style={{ color: '#d9d2c4', marginBottom: 12 }}>SHOT LIST · {progress.captured} TAKEN · {progress.skipped} SKIPPED</div>
          {['Exterior', 'Interior', 'Wheels / tires'].map((group) => <div key={group} style={{ marginBottom: 18 }}><div className="field-label" style={{ color: '#aaa092' }}>{group}</div><div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginTop: 7 }}>{WALK_SLOTS.filter((s) => s.group === group).map((s) => { const i = WALK_SLOTS.indexOf(s); return <button key={s.key} onClick={() => selectSlot(i)} style={{ aspectRatio: '1', padding: 0, overflow: 'hidden', borderRadius: 8, border: '1px solid #4a443c', background: taken[s.key] ? '#2e2a25' : '#25221e', color: '#d9d2c4', position: 'relative' }}>{photos[s.key]?.thumb ? <img src={photos[s.key].thumb} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span style={{ fontSize: 10, display: 'block', padding: 5 }}>{s.label}</span>}{skipped[s.key] && <b style={{ position: 'absolute', bottom: 3, left: 4, fontSize: 8, color: '#e7ad62' }}>SKIPPED</b>}</button>; })}</div></div>)}
          <button className="btn btn-red" onClick={() => setMode('guided')}>BACK TO CAMERA</button>
          {!addOnly && <button className="btn btn-outline" style={{ marginTop: 8, color: '#f5f3ee', borderColor: '#5c554b' }} onClick={damage}>+ ADD DAMAGE CLOSE-UP</button>}
        </div>
      ) : landscape ? (
        /* Landscape — like the iPhone camera turned sideways: full-height 4:3
           frame on the left, controls in a rail on the right. */
        <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'row', background: '#000', paddingLeft: 'env(safe-area-inset-left)' }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{frame}</div>
          <div style={{ flex: 'none', width: 118, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'space-between', padding: 'calc(8px + env(safe-area-inset-top)) calc(8px + env(safe-area-inset-right)) 8px 4px' }}>
            <button aria-label="Close camera" onClick={requestClose} style={roundBtn}>✕</button>
            {zoomDial(true)}
            {shutterBtn}
            {mode === 'damage' ? <button style={chromeBtn} onClick={skipOrCancel}>CANCEL</button> : mode === 'extra' ? extraThumb : galleryBtn}
          </div>
          {flash && <div style={{ position: 'absolute', inset: 0, background: '#fff', opacity: .9, pointerEvents: 'none' }} />}
        </div>
      ) : (
        /* Portrait — header on top, 3:4 frame, controls below on solid black. */
        <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column', background: '#000' }}>
          <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{frame}</div>
          <div style={{ flex: 'none', padding: '12px 18px calc(16px + env(safe-area-inset-bottom))', background: '#000' }}>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              {mode === 'damage' ? <button style={{ ...chromeBtn, width: 84 }} onClick={skipOrCancel}>CANCEL</button> : mode === 'extra' ? extraThumb : galleryBtn}
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