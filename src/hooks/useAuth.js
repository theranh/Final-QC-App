import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Auth + access state for the signed-in user.
// status: 'loading' | 'signed_out' | 'domain_blocked' | 'pending' | 'inactive' | 'active'
export function useAuth() {
  const [state, setState] = useState({ status: 'loading', email: '', employee: null });
  const genRef = useRef(0); // only the latest refresh run may touch state

  const refresh = useCallback(async () => {
    const gen = ++genRef.current;
    const live = () => gen === genRef.current;
    // Server runs on an always-on Reserved VM, so there is no cold start to
    // wait out. One quick retry absorbs a momentary network blip; anything
    // beyond that is a real outage and should surface immediately.
    // 401 is definitive: signed out.
    setState((s) => ({ ...s, status: 'loading' }));
    const MAX_ATTEMPTS = 2;
    const RETRY_DELAY_MS = 1000;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const me = await api.me();
        if (!live()) return;
        setState({ status: me.access, email: me.email, employee: me.employee });
        return;
      } catch (err) {
        if (!live()) return;
        if (err.status === 401) {
          setState({ status: 'signed_out', email: '', employee: null });
          return;
        }
        if (attempt < MAX_ATTEMPTS - 1) {
          await sleep(RETRY_DELAY_MS);
          if (!live()) return;
        } else {
          const detail = err && err.message ? String(err.message) : 'Unknown error';
          setState({ status: 'error', email: '', employee: null, errorDetail: detail });
        }
      }
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Any API call that hits a 401 fires this event (see src/lib/api.js). Flip
  // to signed_out so a long-lived phone PWA shows the sign-in screen instead
  // of dead buttons once the session expires.
  useEffect(() => {
    const onExpired = () => {
      genRef.current += 1; // cancel any in-flight refresh
      setState({ status: 'signed_out', email: '', employee: null });
    };
    window.addEventListener('auth:expired', onExpired);
    return () => window.removeEventListener('auth:expired', onExpired);
  }, []);

  return { ...state, refresh };
}
