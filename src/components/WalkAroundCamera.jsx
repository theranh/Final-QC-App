import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { WALK_SLOTS, nextUntakenSlot, putSlotPhoto, walkProgress } from '../lib/walkSlots';
import { persistJob, removeJob, removeJobsForPhoto, pendingJobs, newJobKey, setCameraOpen } from '../lib/photoQueue';
import { orientedJpegDataUrl } from '../lib/photo';
import {
  drawLiveVideoFrame,
  liveCameraCorrection,
  saveLiveCameraCorrection,
} from '../lib/livePhoto';
import { analyzeDataUrl } from '../lib/photoQuality';
import PhotoQualityReview from './PhotoQualityReview';
import LivePhotoOrientationReview from './LivePhotoOrientationReview';
import { photoRoleOf, photoUrl } from '../../shared/photoRoles';

const MAX = 1600;
// EXIF-aware decode + downscale — portrait/landscape uploads come out upright.
function dataUrlImage(dataUrl, max = MAX, quality = 0.8, zoom = 1) {
  return orientedJpegDataUrl(dataUrl, max, quality, zoom);
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
  const queueRef = useRef([]); // newest failed job per photo id
  const retryBusyRef = useRef(false);
  const closeWarnRef = useRef(0);
  const latestCaptureRef = useRef(new Map()); // photo id -> newest capture key
  const uploadChainsRef = useRef(new Map()); // photo id -> serialized upload promise
  const captureClockRef = useRef(0);
  const nextCaptureTs = () => {
    const ts = Math.max(Date.now(), captureClockRef.current + 1);
    captureClockRef.current = ts;
    return ts;
  };
  const takenRef = useRef({}); // latest taken map for async callbacks
  useEffect(() => { takenRef.current = taken; }, [taken]);
  const interactedRef = useRef(false); // user captured/picked a slot already

  // While the camera is open it owns the retry loop for camera slots, so the
  // app-level flusher leaves those alone (it keeps sending damage close-ups,
  // which the camera never retries). Any photos persisted for this quote in
  // an earlier force-closed session are picked back up into the in-memory
  // queue here.
  useEffect(() => {
    setCameraOpen(true);
    let live = true;
    if (quoteId) {
      pendingJobs(quoteId).then((jobs) => {
        if (!live) return;
        for (const job of jobs) {
          latestCaptureRef.current.set(job.id, job.key);
          captureClockRef.current = Math.max(
            captureClockRef.current,
            Number(job.captureTs || job.addedAt || 0),
          );
          if (!queueRef.current.some((j) => j.key === job.key)) queueRef.current.push(job);
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
        if (photoRoleOf(p) !== 'walk' || !walkKeys.has(p.slot)) continue;
        takenMap[p.slot] = true;
        photoMap[p.slot] = { id: p.id, thumb: photoUrl(p) };
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
  const cameraStartRef = useRef(null);
  const cameraEpochRef = useRef(0);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraStarting, setCameraStarting] = useState(false);
  const fileRef = useRef(null); const canvasRef = useRef(null);
  // Retained for the shop's existing motion-permission handshake only. Live
  // pixel orientation is calibrated from captured output, never from gravity.
  const gravRef = useRef(null);
  const motionOnRef = useRef(false);
  const motionRequestRef = useRef(null);
  const motionPermissionSettledRef = useRef(false);
  const [accessPrepared, setAccessPrepared] = useState(false);
  // Advisory quality review: null = no pending review; otherwise { dataUrl, warnings, action }
  // where action is the deferred save function to call on Keep.
  const [qualityReview, setQualityReview] = useState(null);
  const qualityBusyRef = useRef(false);
  const qualityDecisionRef = useRef(false);
  const [orientationReview, setOrientationReview] = useState(null);
  const orientationDecisionRef = useRef(false);
  const sessionCorrectionsRef = useRef(new Map());
  // One shutter press owns one immutable guided slot until the image has been
  // normalized, persisted, and reflected in state. This prevents rapid taps
  // from reusing the same render's slot before React advances the sequence.
  const shotBusyRef = useRef(false);
  const [shotBusy, setShotBusy] = useState(false);
  const releaseShot = () => {
    shotBusyRef.current = false;
    setShotBusy(false);
  };
  const progress = walkProgress(WALK_SLOTS, taken, skipped);
  const slot = WALK_SLOTS[current] || WALK_SLOTS[0];
  const zooms = useMemo(() => [0.5, 1, 2, 3, 5], []);

  const stopCamera = useCallback(() => {
    cameraEpochRef.current += 1;
    if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    trackRef.current = null;
    setCameraReady(false);
  }, []);
  const startCamera = useCallback(async () => {
    if (streamRef.current) {
      if (videoRef.current && videoRef.current.srcObject !== streamRef.current) {
        videoRef.current.srcObject = streamRef.current;
      }
      setCameraReady(true);
      return true;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Live camera is unavailable. Choose a photo from your device instead.');
      return false;
    }
    if (cameraStartRef.current) return cameraStartRef.current;
    const epoch = cameraEpochRef.current;
    const request = (async () => {
      setCameraStarting(true);
      setError('');
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false });
        if (epoch !== cameraEpochRef.current) {
          stream.getTracks().forEach((t) => t.stop());
          return false;
        }
        streamRef.current = stream;
        trackRef.current = stream.getVideoTracks()[0];
        if (videoRef.current) videoRef.current.srcObject = stream;
        const caps = trackRef.current.getCapabilities ? trackRef.current.getCapabilities() : {};
        setZoomCaps(caps.zoom || null);
        if (caps.zoom) trackRef.current.applyConstraints({ advanced: [{ zoom: Math.max(caps.zoom.min, Math.min(caps.zoom.max, zoomRef.current)) }] }).catch(() => {});
        setCameraReady(true);
        return true;
      } catch (e) {
        if (epoch === cameraEpochRef.current) {
          setCameraReady(false);
          setError(e?.name === 'NotAllowedError'
            ? 'Allow camera access to use the live camera, or choose a photo from your device.'
            : 'Camera unavailable. Choose a photo from your device instead.');
        }
        return false;
      } finally {
        if (epoch === cameraEpochRef.current) setCameraStarting(false);
        cameraStartRef.current = null;
      }
    })();
    cameraStartRef.current = request;
    return request;
  }, []);
  useEffect(() => {
    void startCamera();
    return stopCamera;
  }, [startCamera, stopCamera]);
  // Review mode removes the live <video> from the DOM. Reattach the existing
  // stream whenever the camera frame mounts again (for example, Add Damage).
  useEffect(() => {
    if (mode !== 'review' && videoRef.current && streamRef.current
      && videoRef.current.srcObject !== streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
    }
  }, [mode]);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  // Keep the existing permission flow, but treat motion as non-authoritative:
  // gravity cannot reveal whether WebKit normalized drawImage(video) pixels.
  const onMotion = useCallback((e) => {
    const g = e.accelerationIncludingGravity;
    if (g && (g.x != null)) gravRef.current = { x: g.x, y: g.y, t: Date.now() };
  }, []);
  // Resolves once the listener is attached (or permission is denied).
  const enableMotion = useCallback(() => {
    if (motionOnRef.current || motionPermissionSettledRef.current) return Promise.resolve();
    if (motionRequestRef.current) return motionRequestRef.current;
    const attach = () => { motionOnRef.current = true; window.addEventListener('devicemotion', onMotion); };
    const request = (async () => {
      try {
        if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
          const result = await DeviceMotionEvent.requestPermission();
          if (result === 'granted') attach();
        } else if (typeof DeviceMotionEvent !== 'undefined') {
          attach();
        }
      } catch {
        // Denial is allowed: the camera still works, just without gravity data.
      } finally {
        motionPermissionSettledRef.current = true;
        motionRequestRef.current = null;
      }
    })();
    motionRequestRef.current = request;
    return request;
  }, [onMotion]);
  useEffect(() => {
    return () => { if (motionOnRef.current) window.removeEventListener('devicemotion', onMotion); };
  }, [onMotion]);
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
    const isLatest = () => latestCaptureRef.current.get(job.id) === job.key;
    try {
      await api.putQuotePhoto({
        id: job.id,
        quoteId,
        slot: job.slotKey,
        role: 'walk',
        dataUrl: job.dataUrl,
        captureTs: job.captureTs,
      });
      queueRef.current = queueRef.current.filter((j) => j.key !== job.key);
      setPendingCount(queueRef.current.length);
      // Clear only THIS capture's on-disk copy: a retake of the same slot may
      // already have persisted a newer record, which must stay queued.
      removeJob(job.key);
      if (isLatest()) latestCaptureRef.current.delete(job.id);
      return true;
    } catch (e) {
      if (e.status === 413 || e.status === 409 || e.status === 403) {
        // Permanent — retrying won't help. Restore what the slot showed before
        // this shot (a prior server photo stays visible; an empty slot empties).
        queueRef.current = queueRef.current.filter((j) => j.key !== job.key);
        setPendingCount(queueRef.current.length);
        removeJob(job.key); // retrying can never succeed — drop the on-disk copy too
        if (isLatest()) {
          latestCaptureRef.current.delete(job.id);
          setTaken((p) => {
            const restored = { ...p, [job.slotKey]: !!job.prev };
            takenRef.current = restored;
            return restored;
          });
          setPhotos((p) => ({ ...p, [job.slotKey]: job.prev || undefined }));
          showToast?.(e.status === 413 ? 'Photo is too large — try again closer or with less zoom.' : 'This quote is locked and cannot accept photos.');
        }
        return false;
      }
      // Transient (offline / server blip / signed out): keep it queued —
      // in memory AND on disk — for auto-retry. A 401 clears itself once the
      // tech signs back in, so the shot must survive until then.
      if (isLatest() && !queueRef.current.some((j) => j.key === job.key)) {
        queueRef.current.push(job);
      } else if (!isLatest()) {
        removeJob(job.key);
      }
      setPendingCount(queueRef.current.length);
      if (!fromRetry && isLatest()) showToast?.(e.status === 401 ? 'Signed out — photo saved, it will send after you sign in again.' : 'Weak signal — photo saved on screen, sending in background…');
      return false;
    }
  }, [quoteId, showToast]);

  // Different guided slots upload in parallel, but retakes of the same stable
  // photo id are serialized in capture order. Combined with captureTs on the
  // server, this also stays safe if the app closes and the global flusher runs.
  const scheduleUpload = useCallback((job, options) => {
    const prior = uploadChainsRef.current.get(job.id) || Promise.resolve();
    let tracked;
    tracked = prior
      .catch(() => {})
      .then(() => uploadPhoto(job, options))
      .finally(() => {
        if (uploadChainsRef.current.get(job.id) === tracked) {
          uploadChainsRef.current.delete(job.id);
        }
      });
    uploadChainsRef.current.set(job.id, tracked);
    return tracked;
  }, [uploadPhoto]);

  // Auto-retry loop: every 5s while shots are waiting, plus immediately when
  // the network comes back.
  useEffect(() => {
    const flush = async () => {
      if (retryBusyRef.current || !queueRef.current.length) return;
      retryBusyRef.current = true;
      try {
        for (const job of [...queueRef.current]) {
          await scheduleUpload(job, { fromRetry: true });
        }
      } finally { retryBusyRef.current = false; }
    };
    const t = setInterval(flush, 5000);
    window.addEventListener('online', flush);
    return () => { clearInterval(t); window.removeEventListener('online', flush); };
  }, [scheduleUpload]);

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
    const captureTs = nextCaptureTs();
    // Same durable path as guided shots: persist to disk before the upload
    // attempt so a force-close or dead battery can't lose an extra photo.
    const key = newJobKey(id);
    const job = { key, id, quoteId, slotKey, role: 'walk', dataUrl, captureTs };
    latestCaptureRef.current.set(id, key);
    await persistJob(job);
    setPhotos((p) => putSlotPhoto(p, slotKey, { id, thumb, dataUrl }));
    void scheduleUpload(job);
  };
  const extraShots = Object.keys(photos).filter((k) => k.startsWith('xtra_') && photos[k]);

  const saveGuided = async (dataUrl, targetSlot) => {
    if (committed) return;
    if (!targetSlot) throw new Error('No guided photo slot was reserved');
    if (addOnly) {
      // Never overwrite a saved photo: wait until we know which spots the
      // server already has, and refuse occupied ones.
      if (!serverLoaded) { showToast?.('Checking which photos exist — try again in a second.'); return; }
      if (takenRef.current[targetSlot.key]) { showToast?.('That spot already has a photo — saved photos can’t be replaced.'); return; }
    }
    const thumb = await dataUrlImage(dataUrl, 340, 0.7, 1);
    const id = `${quoteId}_${targetSlot.key}`.slice(0, 60);
    const slotKey = targetSlot.key;
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
    const captureTs = nextCaptureTs();
    const job = { key, id, quoteId, slotKey, role: 'walk', dataUrl, captureTs, prev };
    latestCaptureRef.current.set(id, key);
    await persistJob(job);
    // This shot supersedes any earlier queued capture of the same slot —
    // purge them (disk + memory) so a stale retry can't overwrite it.
    await removeJobsForPhoto(id, key);
    queueRef.current = queueRef.current.filter((j) => j.id !== id);
    setPendingCount(queueRef.current.length);
    setPhotos((p) => putSlotPhoto(p, slotKey, { id, thumb, dataUrl }));
    const nextTaken = { ...takenRef.current, [slotKey]: true };
    takenRef.current = nextTaken;
    setTaken(nextTaken);
    setSkipped((p) => ({ ...p, [slotKey]: false }));
    const targetIndex = WALK_SLOTS.findIndex((candidate) => candidate.key === slotKey);
    const next = nextUntakenSlot(WALK_SLOTS, nextTaken, targetIndex + 1);
    if (next >= 0) setCurrent(next);
    else {
      // All 24 guided spots are done — keep the camera rolling in extra mode
      // (also in add-only: extras are additive and never touch saved photos)
      // so the crew can take as many additional shots as they want.
      setMode('extra');
      showToast?.('All 24 angles captured — keep taking as many photos as you need. Tap ✕ when finished.');
    }
    void scheduleUpload(job);
  };

  // Advisory quality gate: run a lightweight local analysis on the captured
  // data URL and show the review overlay only when obvious issues are found.
  // If analysis throws or returns no warnings, the action runs immediately.
  // The exact original dataUrl is passed through unchanged on Keep.
  const maybeReview = async (dataUrl, action) => {
    if (qualityBusyRef.current) return false;
    qualityBusyRef.current = true;
    try {
      const warnings = await analyzeDataUrl(dataUrl);
      if (warnings.length > 0) {
        setQualityReview({ dataUrl, warnings, action });
        return true;
      }
    } catch {
      // Fail open — never block saving.
    } finally {
      qualityBusyRef.current = false;
    }
    await action(dataUrl);
    return false;
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
  // Most browsers expose the same upright pixels shown in the <video>. Some
  // iPhone WebKit camera profiles expose a quarter-turned backing frame to
  // drawImage(), though, so Apple mobile calibrates that mapping once from an
  // actual captured preview. Gravity never decides pixel orientation.
  const capture = async () => {
    const v = videoRef.current;
    if (!accessPrepared) return;
    // Never let the first shutter press become a hidden fallback capture: the
    // permission gate must be resolved before any photo can be taken.
    if (!v?.videoWidth) { await startCamera(); return; }
    if (shotBusyRef.current) return;
    shotBusyRef.current = true;
    setShotBusy(true);
    const captureMode = mode;
    const targetSlot = captureMode === 'guided' ? slot : null;
    if (targetSlot) interactedRef.current = true; // preload must not steer the camera anymore
    setFlash(true); setTimeout(() => setFlash(false), 160);
    let reviewPending = false;
    try {
    const storedCalibration = liveCameraCorrection(v);
    const sessionCorrection = sessionCorrectionsRef.current.get(storedCalibration.profile);
    const correction = sessionCorrection ?? storedCalibration.correction;
    const needsOrientationReview = sessionCorrection == null && storedCalibration.needsReview;
    const frameOptions = {
      max: MAX,
      zoom: zoomRef.current,
      nativeZoom: nativeZooms.length > 0,
      previewWidth: v.clientWidth,
      previewHeight: v.clientHeight,
      sourceWidth: v.videoWidth,
      sourceHeight: v.videoHeight,
    };
    let captureSource = v;
    if (needsOrientationReview) {
      // Freeze the exact backing frame before showing the calibration prompt.
      // The chosen turn is then applied to this same frame before crop/zoom,
      // so the first saved shot follows the identical path as later shots.
      captureSource = document.createElement('canvas');
      captureSource.width = v.videoWidth;
      captureSource.height = v.videoHeight;
      captureSource.getContext('2d').drawImage(v, 0, 0, v.videoWidth, v.videoHeight);
    }
    const canvas = canvasRef.current || document.createElement('canvas');
    drawLiveVideoFrame(captureSource, canvas, {
      correction,
      ...frameOptions,
    });
    const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
    let action;
    if (captureMode === 'damage') {
      if (!committed) {
        action = async (url) => {
          damageCloseUpRef.current = url;
          setMode('damage_wide');
        };
      }
    } else if (captureMode === 'damage_wide') {
      if (!committed) {
        const closeUp = damageCloseUpRef.current;
        action = async (url) => {
          damageCloseUpRef.current = null;
          setMode('guided');
          onDamageCapture?.(closeUp, url);
        };
      }
    } else if (captureMode === 'extra') action = saveExtra;
    else action = (url) => saveGuided(url, targetSlot);
    if (action && needsOrientationReview) {
      setOrientationReview({
        dataUrl,
        action,
        profile: storedCalibration.profile,
        source: captureSource,
        frameOptions,
      });
      reviewPending = true;
    } else if (action) {
      reviewPending = await maybeReview(dataUrl, action);
    }
    } catch (err) {
      showToast?.(err instanceof Error ? err.message : 'Could not save that photo');
    } finally {
      if (!reviewPending) releaseShot();
    }
  };
  const onFile = async (event) => {
    const file = event.target.files?.[0]; event.target.value = ''; if (!file || shotBusyRef.current) return;
    shotBusyRef.current = true;
    setShotBusy(true);
    const captureMode = mode;
    const targetSlot = captureMode === 'guided' ? slot : null;
    if (targetSlot) interactedRef.current = true;
    let reviewPending = false;
    try {
      if (committed) return;
      const source = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('Could not read that photo'));
        reader.readAsDataURL(file);
      });
      const normalized = await dataUrlImage(source, MAX, 0.8, zoomRef.current);
      if (captureMode === 'damage') {
        reviewPending = await maybeReview(normalized, async (url) => {
          damageCloseUpRef.current = url;
          setMode('damage_wide');
        });
      } else if (captureMode === 'damage_wide') {
        const closeUp = damageCloseUpRef.current;
        reviewPending = await maybeReview(normalized, async (url) => {
          damageCloseUpRef.current = null;
          setMode('guided');
          onDamageCapture?.(closeUp, url);
        });
      } else if (captureMode === 'extra') reviewPending = await maybeReview(normalized, saveExtra);
      else reviewPending = await maybeReview(normalized, (url) => saveGuided(url, targetSlot));
    } catch (err) {
      showToast?.(err instanceof Error ? err.message : 'Could not read that photo');
    } finally {
      if (!reviewPending) releaseShot();
    }
  };
  // Holds the close-up dataUrl while the camera waits for the matching wide shot.
  const damageCloseUpRef = useRef(null);
  const damage = () => { if (!committed && !addOnly) setMode('damage'); };
  const selectSlot = (i) => {
    if (addOnly && taken[WALK_SLOTS[i].key]) { showToast?.('That spot already has a photo — saved photos can’t be replaced.'); return; }
    interactedRef.current = true;
    setMode('guided'); setCurrent(i);
  };
  const skipOrCancel = () => {
    if (mode === 'damage_wide') {
      // Skip the wide shot — send just the close-up that was already captured.
      const closeUp = damageCloseUpRef.current;
      damageCloseUpRef.current = null;
      setMode('guided');
      if (closeUp) onDamageCapture?.(closeUp);
    } else if (mode === 'damage') {
      setMode('guided');
    } else {
      setSkipped((p) => ({ ...p, [slot.key]: true }));
      const next = nextUntakenSlot(WALK_SLOTS, taken, current + 1);
      if (next >= 0) setCurrent(next);
    }
  };
  // Translucent dark camera-chrome buttons (never the app's white .btn styles)
  const chromeBtn = { border: '1px solid rgba(255,255,255,.28)', borderRadius: 20, background: 'rgba(28,26,23,.65)', color: '#f5f3ee', fontSize: 12, fontWeight: 600, letterSpacing: 1, padding: '10px 14px' };
  const roundBtn = { ...chromeBtn, borderRadius: '50%', width: 42, height: 42, padding: 0, fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(35,32,26,.72)', border: '2px solid rgba(255,255,255,.5)' };
  // Shutter styled like the old Body Quoter: solid white with a translucent ring.
  const shutterBtn = <button onClick={capture} disabled={shotBusy} aria-busy={shotBusy} aria-label="Take photo" style={{ width: 78, height: 78, borderRadius: '50%', background: '#fff', backgroundClip: 'padding-box', border: '5px solid rgba(255,255,255,.4)', flex: 'none', padding: 0, opacity: shotBusy ? 0.55 : 1 }} />;
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
      {lastExtra ? <img src={lastExtra} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 9 }} /> : <span style={{ color: '#aaa092', fontSize: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>PHOTOS</span>}
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
      {(!cameraReady || !accessPrepared) && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: 'rgba(0,0,0,.76)', textAlign: 'center' }}>
          <div style={{ maxWidth: 270 }}>
            <div style={{ color: '#fff', fontWeight: 700, fontSize: 15 }}>{cameraStarting ? 'REQUESTING CAMERA ACCESS…' : 'ALLOW CAMERA ACCESS BEFORE TAKING PHOTOS'}</div>
            <button
              className="btn btn-outline"
              style={{ width: '100%', marginTop: 12, color: '#fff', borderColor: '#fff' }}
              disabled={cameraStarting}
              onClick={async () => {
                const cameraOk = await startCamera();
                await enableMotion();
                if (cameraOk) setAccessPrepared(true);
              }}
            >
              {cameraStarting ? 'OPENING CAMERA…' : 'ENABLE CAMERA'}
            </button>
            <button
              className="btn btn-outline"
              style={{ width: '100%', marginTop: 8, color: '#d9d2c4', borderColor: '#5c554b' }}
              onClick={() => fileRef.current?.click()}
            >
              CHOOSE PHOTO INSTEAD
            </button>
          </div>
        </div>
      )}
      {error && <div style={{ position: 'absolute', bottom: 16, left: 16, right: 16, padding: 12, borderRadius: 8, background: 'rgba(58,54,47,.9)', color: '#f2c8a8', textAlign: 'center', fontSize: 12 }}>{error}</div>}
      {!landscape && !error && <div style={{ position: 'absolute', bottom: 10, left: 0, right: 0, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}><div style={{ pointerEvents: 'auto' }}>{zoomDial(false)}</div></div>}
    </div>
  );
  return (
    // Keep the explicit motion-permission handshake requested by the shop, but
    // never use noisy/stale gravity data to rotate photo pixels.
    <div onPointerDown={enableMotion} style={{ position: 'fixed', inset: 0, zIndex: 200, background: '#171512', color: '#f5f3ee', display: 'flex', flexDirection: 'column' }}>
      {qualityReview && (
        <PhotoQualityReview
          dataUrl={qualityReview.dataUrl}
          warnings={qualityReview.warnings}
          onKeep={async (url) => {
            if (qualityDecisionRef.current) return;
            qualityDecisionRef.current = true;
            const action = qualityReview.action;
            setQualityReview(null);
            try {
              await action(url);
            } catch (err) {
              showToast?.(err instanceof Error ? err.message : 'Could not save that photo');
            } finally {
              qualityDecisionRef.current = false;
              releaseShot();
            }
          }}
          onRetake={() => {
            if (qualityDecisionRef.current) return;
            qualityDecisionRef.current = true;
            setQualityReview(null);
            queueMicrotask(() => {
              qualityDecisionRef.current = false;
              releaseShot();
            });
          }}
        />
      )}
      {orientationReview && (
        <LivePhotoOrientationReview
          dataUrl={orientationReview.dataUrl}
          onChoose={async (correction) => {
            if (orientationDecisionRef.current) return;
            orientationDecisionRef.current = true;
            const pending = orientationReview;
            setOrientationReview(null);
            try {
              sessionCorrectionsRef.current.set(pending.profile, correction);
              saveLiveCameraCorrection(pending.profile, correction);
              const canvas = canvasRef.current || document.createElement('canvas');
              drawLiveVideoFrame(pending.source, canvas, {
                correction,
                ...pending.frameOptions,
              });
              const corrected = canvas.toDataURL('image/jpeg', 0.8);
              const qualityPending = await maybeReview(corrected, pending.action);
              if (!qualityPending) releaseShot();
            } catch (err) {
              showToast?.(err instanceof Error ? err.message : 'Could not orient that photo');
              releaseShot();
            } finally {
              orientationDecisionRef.current = false;
            }
          }}
        />
      )}
      <canvas ref={canvasRef} style={{ display: 'none' }} />
      <input ref={fileRef} type="file" accept="image/*" capture="environment" onChange={onFile} style={{ display: 'none' }} />
      {(!landscape || mode === 'review') && <div style={{ padding: 'calc(10px + env(safe-area-inset-top)) 14px 10px', display: 'flex', alignItems: 'center', gap: 12, background: '#000', flex: 'none' }}>
        <button aria-label="Close camera" onClick={requestClose} style={roundBtn}>×</button>
        <div style={{ flex: 1, textAlign: 'center' }}><div className="card-title" style={{ color: '#d9d2c4' }}>CAMERA</div><div style={{ fontSize: 11, color: '#aaa092' }}>{mode === 'extra' ? `${progress.captured + extraShots.length} photos${pendingCount ? ` · sending ${pendingCount}…` : ''}` : mode === 'guided' ? `${progress.captured} / ${WALK_SLOTS.length} captured${pendingCount ? ` · sending ${pendingCount}…` : ''}` : pendingCount ? `sending ${pendingCount}…` : ''}</div></div>
        {mode === 'guided' ? <button style={chromeBtn} onClick={() => setMode('review')}>Review</button> : <span style={{ width: 40 }} />}
      </div>}
      {mode === 'review' ? (
        <div style={{ padding: 16, overflow: 'auto' }}>
          <div className="card-title" style={{ color: '#d9d2c4', marginBottom: 12 }}>SHOT LIST · {progress.captured} TAKEN · {progress.skipped} SKIPPED</div>
          {['Exterior', 'Wheels / tires', 'Interior'].map((group) => <div key={group} style={{ marginBottom: 18 }}><div className="field-label" style={{ color: '#aaa092' }}>{group}</div><div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginTop: 7 }}>{WALK_SLOTS.filter((s) => s.group === group).map((s) => { const i = WALK_SLOTS.indexOf(s); return <button key={s.key} aria-label={s.label} onClick={() => selectSlot(i)} style={{ aspectRatio: '1', padding: 0, overflow: 'hidden', borderRadius: 8, border: '1px solid #4a443c', background: taken[s.key] ? '#2e2a25' : '#25221e', color: '#d9d2c4', position: 'relative' }}>{photos[s.key]?.thumb ? <img src={photos[s.key].thumb} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span style={{ fontSize: 10, display: 'block', padding: 5 }}>{s.label}</span>}{skipped[s.key] && <b style={{ position: 'absolute', bottom: 3, left: 4, fontSize: 8, color: '#e7ad62' }}>SKIPPED</b>}</button>; })}</div></div>)}
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
            {(mode === 'damage' || mode === 'damage_wide') ? <button style={chromeBtn} onClick={skipOrCancel}>{mode === 'damage_wide' ? 'SKIP' : 'CANCEL'}</button> : mode === 'extra' ? extraThumb : galleryBtn}
          </div>
          {flash && <div style={{ position: 'absolute', inset: 0, background: '#fff', opacity: .9, pointerEvents: 'none' }} />}
        </div>
      ) : (
        /* Portrait — header on top, 3:4 frame, controls below on solid black. */
        <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column', background: '#000' }}>
          <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{frame}</div>
          <div style={{ flex: 'none', padding: '12px 18px calc(16px + env(safe-area-inset-bottom))', background: '#000' }}>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              {(mode === 'damage' || mode === 'damage_wide') ? <button style={{ ...chromeBtn, width: 84 }} onClick={skipOrCancel}>{mode === 'damage_wide' ? 'SKIP' : 'CANCEL'}</button> : mode === 'extra' ? extraThumb : galleryBtn}
              <span style={{ flex: 1 }} />
              {shutterBtn}
              <span style={{ flex: 1 }} />
              <span style={{ flex: 'none', width: (mode === 'damage' || mode === 'damage_wide') ? 84 : 64 }} />
            </div>
          </div>
          {flash && <div style={{ position: 'absolute', inset: 0, background: '#fff', opacity: .9, pointerEvents: 'none' }} />}
        </div>
      )}
    </div>
  );
}