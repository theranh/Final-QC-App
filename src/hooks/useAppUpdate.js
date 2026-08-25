import { useEffect, useRef, useState } from 'react';
import { registerSW } from 'virtual:pwa-register';

// How often an open app checks the server for a newer published version.
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

// Updates wait behind the existing refresh banner. This is intentionally
// independent of what screen has focus: even an apparently idle screen can
// belong to a signed-in session with in-memory work elsewhere in the app.
export default function useAppUpdate() {
  const [updateReady, setUpdateReady] = useState(false);
  const updateFnRef = useRef(null);

  useEffect(() => {
    let intervalId = null;
    const updateSW = registerSW({
      immediate: true,
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

    // Normally prompt-mode workers only take control after applyUpdate. Keep
    // this listener for workers activated by another tab or an older
    // auto-update registration. An existing signed-in page must never reload
    // without its user choosing the refresh action.
    let hadController = Boolean(navigator.serviceWorker?.controller);
    const onControllerChange = () => {
      if (!hadController) {
        // First-ever install taking control — nothing stale to replace.
        hadController = true;
        return;
      }
      setUpdateReady(true);
    };
    navigator.serviceWorker?.addEventListener?.('controllerchange', onControllerChange);

    return () => {
      if (intervalId) clearInterval(intervalId);
      navigator.serviceWorker?.removeEventListener?.('controllerchange', onControllerChange);
    };
  }, []);

  const applyUpdate = () => {
    if (updateFnRef.current) updateFnRef.current(true);
    else window.location.reload();
  };

  return { updateReady, applyUpdate };
}
