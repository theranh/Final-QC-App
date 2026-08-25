import { useEffect, useState } from 'react';
import {
  clearQueueFailure,
  photoQueueLabel,
  reconcileQueuedPhotos,
  subscribePendingDetails,
  subscribePhotoReconciliation,
  subscribeQueueFailure,
} from '../lib/photoQueue';

// Small floating pill shown while walk-around photos saved from an earlier
// session (or a weak-signal moment) are still being sent in the background.
// Also owns the background flusher: on app open, when the network returns,
// and on a slow interval, any photos left over from a force-closed camera
// session are pushed to the server automatically.
export default function PhotoQueueIndicator() {
  const [pending, setPending] = useState([]);
  const [failure, setFailure] = useState(null);
  const [confirmed, setConfirmed] = useState(null);

  useEffect(() => subscribePendingDetails(setPending), []);
  useEffect(() => subscribeQueueFailure(setFailure), []);
  useEffect(() => {
    let timer;
    const unsubscribe = subscribePhotoReconciliation((result) => {
      if (!result?.complete || !result.confirmedCount) return;
      setConfirmed(result);
      clearTimeout(timer);
      timer = setTimeout(() => setConfirmed(null), 5000);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    const flushAndConfirm = () => { void reconcileQueuedPhotos(); };
    flushAndConfirm(); // launch: send leftovers, then confirm them in the server manifest
    const t = setInterval(flushAndConfirm, 15000);
    window.addEventListener('online', flushAndConfirm);
    return () => { clearInterval(t); window.removeEventListener('online', flushAndConfirm); };
  }, []);

  if (failure) {
    return (
      <div role="alert" style={{ position: 'fixed', left: '50%', transform: 'translateX(-50%)', bottom: 'calc(72px + env(safe-area-inset-bottom))', zIndex: 150, width: 'min(360px, calc(100vw - 28px))', background: 'rgba(116,31,31,.96)', color: '#fff', fontSize: 12, fontWeight: 600, padding: '10px 12px', borderRadius: 12, boxShadow: '0 2px 10px rgba(0,0,0,.35)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ flex: 1 }}>A queued photo couldn’t be saved. Reopen the vehicle and retake that photo.</span>
        <button type="button" aria-label="Dismiss photo warning" onClick={clearQueueFailure} style={{ border: 0, background: 'transparent', color: '#fff', fontSize: 20, cursor: 'pointer' }}>×</button>
      </div>
    );
  }
  if (!pending.length) {
    if (!confirmed) return null;
    return (
      <div role="status" aria-live="polite" style={{ position: 'fixed', left: '50%', transform: 'translateX(-50%)', bottom: 'calc(72px + env(safe-area-inset-bottom))', zIndex: 150, background: 'rgba(35,92,53,.96)', color: '#fff', fontSize: 12, fontWeight: 700, padding: '9px 14px', borderRadius: 18, boxShadow: '0 2px 10px rgba(0,0,0,.35)', pointerEvents: 'none' }}>
        All queued photos are on the server ✓
      </div>
    );
  }
  return (
    <div role="status" aria-live="polite" style={{ position: 'fixed', left: '50%', transform: 'translateX(-50%)', bottom: 'calc(72px + env(safe-area-inset-bottom))', zIndex: 150, width: 'min(360px, calc(100vw - 28px))', background: 'rgba(35,32,26,.94)', color: '#f5f3ee', fontSize: 12, fontWeight: 600, letterSpacing: .2, padding: '9px 14px', borderRadius: 14, boxShadow: '0 2px 10px rgba(0,0,0,.35)', pointerEvents: 'none' }}>
      <div>Safely queued · sending {pending.length} photo{pending.length === 1 ? '' : 's'}…</div>
      <div style={{ marginTop: 4, fontSize: 10.5, opacity: .88 }}>
        {pending.slice(0, 4).map(photoQueueLabel).join(' · ')}
        {pending.length > 4 ? ` · +${pending.length - 4} more` : ''}
      </div>
    </div>
  );
}
