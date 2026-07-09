import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';

// Auth + access state for the signed-in user.
// status: 'loading' | 'signed_out' | 'domain_blocked' | 'pending' | 'inactive' | 'active'
export function useAuth() {
  const [state, setState] = useState({ status: 'loading', email: '', employee: null });

  const refresh = useCallback(async () => {
    try {
      const me = await api.me();
      setState({ status: me.access, email: me.email, employee: me.employee });
    } catch (err) {
      if (err.status === 401) setState({ status: 'signed_out', email: '', employee: null });
      else setState({ status: 'error', email: '', employee: null });
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { ...state, refresh };
}
