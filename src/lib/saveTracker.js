// Shared per-truck save/sync status tracker.
//
// Aggregates any number of named save "channels" (intake autosave, quote
// autosave, notes PATCH, photo queue…) into one honest status:
//
//   'saved'   — every channel confirmed by the server (never shown optimistically)
//   'syncing' — at least one request is in flight (or queued work is draining)
//   'local'   — work is safe on this device but has NOT reached the server
//   'error'   — a save failed in a way the user should retry explicitly
//   'idle'    — nothing has been saved this session yet
//
// Each begin() returns a token; success/failure with a stale token is ignored,
// so an out-of-order response can never overwrite a newer save's status.
// Pure JS (no React) so it's unit-testable; components subscribe via onChange.

const PRECEDENCE = ['error', 'syncing', 'local', 'saved', 'idle'];

export function createSaveTracker(onChange) {
  const channels = new Map(); // name -> { state, seq }

  const get = (name) => {
    if (!channels.has(name)) channels.set(name, { state: 'idle', seq: 0 });
    return channels.get(name);
  };

  const emit = () => { if (onChange) onChange(status()); };

  function status() {
    let agg = 'idle';
    let confirmedAny = false;
    for (const { state } of channels.values()) {
      if (state === 'saved') confirmedAny = true;
      if (PRECEDENCE.indexOf(state) < PRECEDENCE.indexOf(agg)) agg = state;
    }
    // 'saved' only counts when at least one channel actually confirmed.
    if (agg === 'saved' && !confirmedAny) agg = 'idle';
    return agg;
  }

  return {
    // Mark a channel as syncing; returns a token for success/failure.
    begin(name) {
      const c = get(name);
      c.seq += 1;
      c.state = 'syncing';
      emit();
      return c.seq;
    },
    // Server confirmed persistence. Ignored if a newer save started since.
    succeed(name, token) {
      const c = get(name);
      if (token !== c.seq) return;
      c.state = 'saved';
      emit();
    },
    // Save failed. kind 'local' = work is safe on-device and will retry
    // (offline); kind 'error' = needs an explicit user retry.
    fail(name, token, kind = 'error') {
      const c = get(name);
      if (token !== c.seq) return;
      c.state = kind === 'local' ? 'local' : 'error';
      emit();
    },
    // Forget a channel (e.g. its record was committed/locked elsewhere).
    reset(name) {
      channels.delete(name);
      emit();
    },
    status,
    channelState: (name) => (channels.has(name) ? channels.get(name).state : 'idle'),
  };
}
