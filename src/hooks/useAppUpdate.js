import { useEffect, useRef, useState } from 'react';
import { registerSW } from 'virtual:pwa-register';

// How often an open app checks the server for a newer published version.
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

// Detects when a new version of the app has been published. Returns
// { updateReady, applyUpdate } — when updateReady is true the UI should
// show a banner telling the employee to refresh; applyUpdate() swaps in
// the new version and reloads.
export default function useAppUpdate() {
  const [updateReady, setUpdateReady] = useState(false);
  const updateFnRef = useRef(null);

  useEffect(() => {
    let intervalId = null;
    const updateSW = registerSW({
      onNeedRefresh() {
        setUpdateReady(true);
      },
      onRegisteredSW(swUrl, registration) {
        if (!registration) return;
        // Re-check for a new version periodically so long-lived open apps
        // (a phone left on the home screen) still learn about revisions.
        if (intervalId) clearInterval(intervalId);
        intervalId = setInterval(() => {
          registration.update().catch(() => {});
        }, CHECK_INTERVAL_MS);
      },
    });
    updateFnRef.current = updateSW;
    return () => {
      if (intervalId) clearInterval(intervalId);
    };
  }, []);

  const applyUpdate = () => {
    if (updateFnRef.current) updateFnRef.current(true);
    else window.location.reload();
  };

  return { updateReady, applyUpdate };
}
