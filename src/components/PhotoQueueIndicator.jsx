import { useEffect, useState } from 'react';
import { flushQueue, subscribePending } from '../lib/photoQueue';

// Small floating pill shown while walk-around photos saved from an earlier
// session (or a weak-signal moment) are still being sent in the background.
// Also owns the background flusher: on app open, when the network returns,
// and on a slow interval, any photos left over from a force-closed camera
// session are pushed to the server automatically.
export default function PhotoQueueIndicator() {
  const [pending, setPending] = useState(0);

  useEffect(() => subscribePending(setPending), []);
  useEffect(() => {
    flushQueue(); // launch: send anything left over from a closed session
    const t = setInterval(flushQueue, 15000);
    window.addEventListener('online', flushQueue);
    return () => { clearInterval(t); window.removeEventListener('online', flushQueue); };
  }, []);

  if (!pending) return null;
  return (
    <div style={{ position: 'fixed', left: '50%', transform: 'translateX(-50%)', bottom: 'calc(72px + env(safe-area-inset-bottom))', zIndex: 150, background: 'rgba(35,32,26,.92)', color: '#f5f3ee', fontSize: 12, fontWeight: 600, letterSpacing: .3, padding: '8px 14px', borderRadius: 18, boxShadow: '0 2px 10px rgba(0,0,0,.35)', pointerEvents: 'none' }}>
      Sending {pending} photo{pending === 1 ? '' : 's'}…
    </div>
  );
}
