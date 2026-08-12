// Autosave failure visibility: a failed quote save must ALWAYS produce a
// visible warning — including the very first failure — so an edit made during
// an outage or against a locked quote is never lost silently.
import { describe, expect, it, vi } from 'vitest';
import { createSaveFailureNotifier } from './QuoteScreen';

describe('createSaveFailureNotifier', () => {
  it('warns on the FIRST failed save (single putQuote rejection is visible)', async () => {
    const notify = vi.fn();
    const notifier = createSaveFailureNotifier(notify, () => 1000);
    // Simulate the autosave wiring: putQuote rejects once, catch -> failed(e).
    const putQuote = vi.fn().mockRejectedValue(Object.assign(new Error('fetch failed'), { status: 0 }));
    await putQuote({ id: 'q1', data: {} }).catch((e) => notifier.failed(e));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatch(/not saving/i);
  });

  it('throttles repeat warnings within 15s but keeps warning after', () => {
    let now = 0;
    const notify = vi.fn();
    const n = createSaveFailureNotifier(notify, () => now);
    n.failed(new Error('down'));       // t=0 -> warn
    now = 5000; n.failed(new Error('down'));  // throttled
    now = 14999; n.failed(new Error('down')); // throttled
    expect(notify).toHaveBeenCalledTimes(1);
    now = 16000; n.failed(new Error('down')); // window elapsed -> warn again
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('always warns immediately on 409 (locked/committed quote), with a lock message', () => {
    let now = 0;
    const notify = vi.fn();
    const n = createSaveFailureNotifier(notify, () => now);
    n.failed(new Error('down'));                          // generic warn at t=0
    n.failed(Object.assign(new Error('409'), { status: 409 })); // not throttled
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1][0]).toMatch(/signed off and locked/i);
  });

  it('a successful save resets the failure state', () => {
    let now = 0;
    const notify = vi.fn();
    const n = createSaveFailureNotifier(notify, () => now);
    n.failed(new Error('down'));
    expect(n.failCount).toBe(1);
    n.succeeded();
    expect(n.failCount).toBe(0);
    now = 1000; n.failed(new Error('down')); // fresh failure after success -> warns
    expect(notify).toHaveBeenCalledTimes(2);
  });
});
