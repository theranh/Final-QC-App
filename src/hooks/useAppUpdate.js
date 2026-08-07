import { useEffect, useRef, useState } from 'react';
import { registerSW } from 'virtual:pwa-register';

// How often an open app checks the server for a newer published version.
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

// The service worker is registered with `autoUpdate`: a newly published
// version installs and activates by itself, so every fresh page load gets
// the latest app with no banner tap required. For pages that are already
// open when the new version activates, we reload automatically — unless a
// form/dialog is mid-edit, in which case we fall back to showing the
// refresh banner so no in-progress work is interrupted.
export default function useAppUpdate() {
  const [updateReady, setUpdateReady] = useState(false);
  const updateFnRef = useRef(null);

  useEffect(() => {
    let intervalId = null;
    const updateSW = registerSW({
      immediate: true,
      onNeedRefresh() {
        // autoUpdate normally handles this itself; kept as a fallback.
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

    // When the new service worker takes control of an already-open page,
    // reload so the visible app matches the newest published version —
    // but never yank the page out from under active typing or an open
    // camera/dialog; show the banner instead in that case.
    let hadController = Boolean(navigator.serviceWorker?.controller);
    const onControllerChange = () => {
      if (!hadController) {
        // First-ever install taking control — nothing stale to replace.
        hadController = true;
        return;
      }
      const busy =
        document.activeElement &&
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
      const dialogOpen = document.querySelector('dialog[open], [data-modal-open="true"], video');
      if (busy || dialogOpen) {
        setUpdateReady(true);
      } else {
        window.location.reload();
      }
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
