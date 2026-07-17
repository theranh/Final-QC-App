import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Auth + access state for the signed-in user.
// status: 'loading' | 'signed_out' | 'domain_blocked' | 'pending' | 'inactive' | 'active'
export function useAuth() {
  const [state, setState] = useState({ status: 'loading', email: '', employee: null });

  const refresh = useCallback(async () => {
    // Retry transient failures (network blips, cold starts, brief 5xx) with
    // backoff before surfacing the error screen. 401 is definitive: signed out.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const me = await api.me();
        setState({ status: me.access, email: me.email, employee: me.employee });
        return;
      } catch (err) {
        if (err.status === 401) {
          setState({ status: 'signed_out', email: '', employee: null });
          return;
        }
        if (attempt < 2) await sleep(1000 * (attempt + 1));
        else setState({ status: 'error', email: '', employee: null });
      }
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { ...state, refresh };
}
