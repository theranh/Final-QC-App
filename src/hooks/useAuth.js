import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Auth + access state for the signed-in user.
// status: 'loading' | 'signed_out' | 'domain_blocked' | 'pending' | 'inactive' | 'active'
// waking: true while retrying a failed startup call (autoscale cold start) —
// the UI shows "Waking up…" instead of an error until all retries fail.
export function useAuth() {
  const [state, setState] = useState({ status: 'loading', email: '', employee: null, waking: false });
  const genRef = useRef(0); // only the latest refresh run may touch state

  const refresh = useCallback(async () => {
    const gen = ++genRef.current;
    const live = () => gen === genRef.current;
    // 3 attempts with backoff: transient failures (cold starts, network
    // blips, brief 5xx) show "Waking up…" and retry; only after every
    // attempt fails do we surface the error screen. 401 is definitive:
    // signed out. Backoff gives an autoscale cold start (~10s) time to boot.
    setState((s) => ({ ...s, status: 'loading', waking: false }));
    // Real-world cold starts can exceed 10s, so the window is ~25s total.
    const MAX_ATTEMPTS = 5;
    const BACKOFF_MS = [2000, 4000, 7000, 10000]; // waits between attempts
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const me = await api.me();
        if (!live()) return;
        setState({ status: me.access, email: me.email, employee: me.employee, waking: false });
        return;
      } catch (err) {
        if (!live()) return;
        if (err.status === 401) {
          setState({ status: 'signed_out', email: '', employee: null, waking: false });
          return;
        }
        if (attempt < MAX_ATTEMPTS - 1) {
          setState((s) => ({ ...s, status: 'loading', waking: true }));
          await sleep(BACKOFF_MS[attempt]);
          if (!live()) return;
        } else {
          const detail = err && err.message ? String(err.message) : 'Unknown error';
          setState({ status: 'error', email: '', employee: null, waking: false, errorDetail: detail });
        }
      }
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { ...state, refresh };
}
