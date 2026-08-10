import { describe, it, expect } from 'vitest';
import { mergeQuoteSnapshot, quoteExtras } from '../components/QuoteScreen.jsx';

describe('quote flags/keep/notes snapshot (stale-autosave fix)', () => {
  it('override wins over the previous-render snapshot', () => {
    // stateRef holds the PREVIOUS render's empty flags; the mutator passes the
    // just-computed next value as an override — that must be what gets saved.
    const prevRender = { flags: [], keep: { tires: false, wheels: false, set: false }, notes: '' };
    const nextFlags = [{ id: 'glass', done: false }];
    const merged = mergeQuoteSnapshot(prevRender, { flags: nextFlags });
    expect(merged.flags).toBe(nextFlags);
    expect(quoteExtras(merged).flags).toEqual([{ id: 'glass', done: false }]);
  });

  it('first flag is never saved as an empty list', () => {
    const merged = mergeQuoteSnapshot({ flags: [] }, { flags: [{ id: 'pdr', done: false }] });
    expect(quoteExtras(merged).flags).toEqual([{ id: 'pdr', done: false }]);
  });

  it('a toggle saves the new done state, not the prior value', () => {
    const merged = mergeQuoteSnapshot(
      { flags: [{ id: 'glass', done: false }] },
      { flags: [{ id: 'glass', done: true }] }
    );
    expect(quoteExtras(merged).flags).toEqual([{ id: 'glass', done: true }]);
  });

  it('keep override is persisted with all three booleans', () => {
    const merged = mergeQuoteSnapshot(
      { keep: { tires: false, wheels: false, set: false } },
      { keep: { tires: true, wheels: false, set: false } }
    );
    expect(quoteExtras(merged).keep).toEqual({ tires: true, wheels: false, set: false });
  });

  it('notes override is persisted', () => {
    const merged = mergeQuoteSnapshot({ notes: 'old' }, { notes: 'new note' });
    expect(quoteExtras(merged).notes).toBe('new note');
  });

  it('without an override, the live snapshot round-trips unchanged', () => {
    const live = {
      notes: 'keeps',
      flags: [{ id: 'smoker', done: true }],
      keep: { tires: true, wheels: true, set: false },
    };
    // No override → imported quote values must survive (no clobbering).
    expect(quoteExtras(mergeQuoteSnapshot(live, undefined))).toEqual({
      notes: 'keeps',
      flags: [{ id: 'smoker', done: true }],
      keep: { tires: true, wheels: true, set: false },
    });
  });

  it('normalizes truthy/undefined into booleans and defaults', () => {
    expect(quoteExtras(undefined)).toEqual({
      notes: '',
      flags: [],
      keep: { tires: false, wheels: false, set: false },
    });
    expect(quoteExtras({ flags: [{ id: 'x', done: 1 }], keep: { tires: 1 } }).flags[0].done).toBe(true);
    expect(quoteExtras({ keep: { tires: 1 } }).keep).toEqual({ tires: true, wheels: false, set: false });
  });
});
