import { describe, it, expect, vi } from 'vitest';
import { createSaveTracker } from './saveTracker';

describe('createSaveTracker', () => {
  it('starts idle and reports syncing/saved through a full cycle', () => {
    const t = createSaveTracker();
    expect(t.status()).toBe('idle');
    const tok = t.begin('intake');
    expect(t.status()).toBe('syncing');
    t.succeed('intake', tok);
    expect(t.status()).toBe('saved');
  });

  it('never shows saved from a stale (out-of-order) response', () => {
    const t = createSaveTracker();
    const first = t.begin('quote');
    const second = t.begin('quote'); // newer save started
    t.succeed('quote', first); // stale response lands late
    expect(t.status()).toBe('syncing'); // still waiting on the newer save
    t.fail('quote', second, 'error');
    expect(t.status()).toBe('error');
    t.succeed('quote', first); // stale success can't clear a newer failure
    expect(t.status()).toBe('error');
  });

  it('distinguishes local (device-only) from error (needs explicit retry)', () => {
    const t = createSaveTracker();
    const tok = t.begin('intake');
    t.fail('intake', tok, 'local');
    expect(t.status()).toBe('local');
    expect(t.channelState('intake')).toBe('local');
    const tok2 = t.begin('intake');
    t.fail('intake', tok2); // default = error
    expect(t.status()).toBe('error');
  });

  it('aggregates worst state across channels: error > syncing > local > saved', () => {
    const t = createSaveTracker();
    const a = t.begin('intake'); t.succeed('intake', a);       // saved
    const b = t.begin('notes'); t.fail('notes', b, 'local');   // local
    expect(t.status()).toBe('local');
    t.begin('quote');                                          // syncing
    expect(t.status()).toBe('syncing');
    const d = t.begin('photos'); t.fail('photos', d, 'error'); // error
    expect(t.status()).toBe('error');
  });

  it('a retry (new begin) clears a failed state back to syncing then saved', () => {
    const t = createSaveTracker();
    const tok = t.begin('notes');
    t.fail('notes', tok);
    expect(t.status()).toBe('error');
    const retry = t.begin('notes');
    expect(t.status()).toBe('syncing');
    t.succeed('notes', retry);
    expect(t.status()).toBe('saved');
  });

  it('reset forgets a channel and notifies subscribers', () => {
    const seen = [];
    const t = createSaveTracker((s) => seen.push(s));
    const tok = t.begin('quote');
    t.fail('quote', tok);
    t.reset('quote');
    expect(t.status()).toBe('idle');
    expect(seen).toEqual(['syncing', 'error', 'idle']);
  });

  it('saved requires a confirmed channel — resets alone never fabricate it', () => {
    const t = createSaveTracker();
    t.begin('a');
    t.reset('a');
    expect(t.status()).toBe('idle');
  });

  it('unknown-channel success/failure is a no-op (defensive)', () => {
    const t = createSaveTracker();
    t.succeed('ghost', 1);
    expect(t.status()).toBe('idle');
  });
});
