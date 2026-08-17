// Fleet-scan resume checkpoint tests (Task #71)
//
// Verifies that:
// 1. After a mid-scan error the checkpoint contains the correct offset
//    (= photos scanned through the last *successful* page).
// 2. Resuming from that checkpoint passes the saved offset as the starting
//    point — no photos are double-counted or skipped.
// 3. Resuming a partial scan and finishing produces exactly the same candidate
//    list as a fresh full scan.
// 4. Passing resumeFrom=null (Restart from beginning) always starts at
//    offset 0 regardless of any saved checkpoint.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  runFleetScanLoop,
  saveFleetProgress,
  loadFleetProgress,
  removeFleetProgress,
  FLEET_SCAN_KEY,
} from './SettingsScreen';

// ── sessionStorage stub ───────────────────────────────────────────────────────
const store = {};
const ssStub = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
beforeEach(() => {
  Object.keys(store).forEach((k) => delete store[k]);
  vi.stubGlobal('sessionStorage', ssStub);
});

// ── helpers ───────────────────────────────────────────────────────────────────

/** Build a deterministic API mock that serves `pages` in order.
 *  After the last page, if `failAfter` is true, it throws instead of done. */
function makeApiFn(pages, { failAt = null } = {}) {
  // pages: [{scanned, candidates?, done?}]
  const calls = [];
  return vi.fn(async (offset) => {
    calls.push(offset);
    const idx = calls.length - 1;
    if (failAt !== null && idx === failAt) {
      throw new Error(`simulated network failure at call ${idx}`);
    }
    const page = pages[idx];
    if (!page) throw new Error(`unexpected call ${idx} with offset ${offset}`);
    return page;
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe('runFleetScanLoop — checkpoint offset after error', () => {
  it('saves offset = cumulative photos scanned through the last successful page', async () => {
    // Page 1: 50 photos, 1 candidate.  Page 2: throws → never saved.
    const pages = [
      { scanned: 50, candidates: [{ id: 'p1', quoteId: 'Q1' }], done: false },
    ];
    const apiFn = makeApiFn(pages, { failAt: 1 }); // fails on 2nd call
    // page[1] would be the second call; but we only have one entry so the mock
    // throws on the second index. Add a dummy page so the mock sees it:
    pages.push({ scanned: 50, candidates: [], done: true }); // will never be reached

    const checkpoints = [];
    await expect(
      runFleetScanLoop(apiFn, null, {
        onPage: ({ offset, totalScanned, accumulated }) => {
          checkpoints.push({ offset, totalScanned, accumulated });
          // Simulate what the component does: write to sessionStorage
          saveFleetProgress(offset, accumulated, totalScanned);
        },
      }),
    ).rejects.toThrow('simulated network failure at call 1');

    // Only one checkpoint was written (page 1 succeeded, page 2 threw)
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].offset).toBe(50);          // offset advanced by 50
    expect(checkpoints[0].totalScanned).toBe(50);
    expect(checkpoints[0].accumulated).toEqual([{ id: 'p1', quoteId: 'Q1' }]);

    // The sessionStorage checkpoint also reflects page 1
    const saved = loadFleetProgress();
    expect(saved).not.toBeNull();
    expect(saved.offset).toBe(50);
    expect(saved.totalScanned).toBe(50);
    expect(saved.accumulated).toEqual([{ id: 'p1', quoteId: 'Q1' }]);
  });

  it('advances checkpoint offset by r.scanned on every successful page', async () => {
    const pages = [
      { scanned: 30, candidates: [],                            done: false },
      { scanned: 40, candidates: [{ id: 'p2', quoteId: 'Q2' }], done: false },
    ];
    const apiFn = makeApiFn(pages, { failAt: 2 }); // fails on 3rd call
    pages.push({ scanned: 0, candidates: [], done: true }); // dummy third

    const offsets = [];
    await expect(
      runFleetScanLoop(apiFn, null, {
        onPage: ({ offset }) => offsets.push(offset),
      }),
    ).rejects.toThrow();

    expect(offsets).toEqual([30, 70]); // 30 then 30+40
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('runFleetScanLoop — resume uses the saved offset', () => {
  it('first API call after resume uses checkpoint.offset, not 0', async () => {
    const resumeFrom = { offset: 100, totalScanned: 100, accumulated: [{ id: 'p1', quoteId: 'Q1' }] };
    const pages = [
      { scanned: 50, candidates: [{ id: 'p2', quoteId: 'Q2' }], done: true },
    ];
    const apiFn = vi.fn(async () => pages[0]);

    await runFleetScanLoop(apiFn, resumeFrom, {});

    // The very first (and only) call must carry offset=100
    expect(apiFn).toHaveBeenCalledTimes(1);
    expect(apiFn).toHaveBeenCalledWith(100);
  });

  it('accumulated candidates from the checkpoint are not duplicated', async () => {
    const prior = [{ id: 'p1', quoteId: 'Q1' }];
    const resumeFrom = { offset: 50, totalScanned: 50, accumulated: prior };
    const pages = [
      { scanned: 50, candidates: [{ id: 'p2', quoteId: 'Q2' }], done: true },
    ];
    const apiFn = vi.fn(async () => pages[0]);

    const { accumulated } = await runFleetScanLoop(apiFn, resumeFrom, {});

    expect(accumulated).toHaveLength(2);
    expect(accumulated[0]).toEqual({ id: 'p1', quoteId: 'Q1' });
    expect(accumulated[1]).toEqual({ id: 'p2', quoteId: 'Q2' });
  });

  it('totalScanned after resume equals checkpoint.totalScanned + new scanned', async () => {
    const resumeFrom = { offset: 100, totalScanned: 100, accumulated: [] };
    const pages = [
      { scanned: 60, candidates: [], done: true },
    ];
    const apiFn = vi.fn(async () => pages[0]);

    const { totalScanned } = await runFleetScanLoop(apiFn, resumeFrom, {});
    expect(totalScanned).toBe(160);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('runFleetScanLoop — resume produces same result as a fresh full scan', () => {
  // Database layout: 3 pages of 50 photos each with candidates on pages 1 and 3.
  const FULL_PAGES = [
    { scanned: 50, candidates: [{ id: 'c1', quoteId: 'Q1' }], done: false },
    { scanned: 50, candidates: [],                            done: false },
    { scanned: 50, candidates: [{ id: 'c2', quoteId: 'Q2' }], done: true },
  ];

  it('fresh full scan accumulates all candidates', async () => {
    let callIdx = 0;
    const apiFn = vi.fn(async () => FULL_PAGES[callIdx++]);

    const { accumulated, totalScanned } = await runFleetScanLoop(apiFn, null, {});

    expect(totalScanned).toBe(150);
    expect(accumulated).toEqual([
      { id: 'c1', quoteId: 'Q1' },
      { id: 'c2', quoteId: 'Q2' },
    ]);
  });

  it('scan interrupted after page 1, then resumed — same final result', async () => {
    // --- Phase A: page 0 succeeds; page 1 throws ---
    let callIdxA = 0;
    const apiFnA = vi.fn(async () => {
      if (callIdxA++ === 0) return FULL_PAGES[0];
      throw new Error('network error mid-scan');
    });

    let checkpoint = null;
    await expect(
      runFleetScanLoop(apiFnA, null, {
        onPage: ({ offset, totalScanned, accumulated }) => {
          checkpoint = { offset, totalScanned, accumulated };
        },
      }),
    ).rejects.toThrow('network error mid-scan');

    // Checkpoint was written after page 0 (50 photos scanned)
    expect(checkpoint).not.toBeNull();
    expect(checkpoint.offset).toBe(50);
    expect(checkpoint.accumulated).toEqual([{ id: 'c1', quoteId: 'Q1' }]);

    // --- Phase B: resume from checkpoint; remaining pages are 1 and 2 ---
    const remainingPages = [FULL_PAGES[1], FULL_PAGES[2]];
    let callIdxB = 0;
    const apiFnB = vi.fn(async (offset) => {
      // First resume call must use the checkpointed offset, not 0
      if (callIdxB === 0) expect(offset).toBe(50);
      return remainingPages[callIdxB++];
    });

    const { accumulated, totalScanned } = await runFleetScanLoop(apiFnB, checkpoint, {});

    // totalScanned = 50 (from checkpoint) + 50 + 50 (two remaining pages)
    expect(totalScanned).toBe(150);
    expect(accumulated).toEqual([
      { id: 'c1', quoteId: 'Q1' },
      { id: 'c2', quoteId: 'Q2' },
    ]);
    expect(apiFnB).toHaveBeenNthCalledWith(1, 50);  // resumed at correct offset
    expect(apiFnB).toHaveBeenNthCalledWith(2, 100); // advanced correctly
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('runFleetScanLoop — restart from beginning', () => {
  it('null resumeFrom always starts at offset 0, ignoring any saved checkpoint', async () => {
    // Simulate a leftover checkpoint from a previous interrupted scan
    saveFleetProgress(999, [{ id: 'stale', quoteId: 'OLD' }], 999);
    expect(loadFleetProgress()?.offset).toBe(999);

    const apiFn = vi.fn(async () => ({ scanned: 10, candidates: [], done: true }));

    await runFleetScanLoop(apiFn, null, {});

    // Must have called the API with 0, not 999
    expect(apiFn).toHaveBeenCalledWith(0);
  });

  it('null resumeFrom does not inherit prior accumulated candidates', async () => {
    const apiFn = vi.fn(async () => ({
      scanned: 10,
      candidates: [{ id: 'fresh', quoteId: 'NEW' }],
      done: true,
    }));

    const { accumulated } = await runFleetScanLoop(apiFn, null, {});

    // Only the newly-found candidate — nothing from the old checkpoint
    expect(accumulated).toEqual([{ id: 'fresh', quoteId: 'NEW' }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('saveFleetProgress / loadFleetProgress / removeFleetProgress', () => {
  it('round-trips offset, accumulated, and totalScanned', () => {
    const cands = [{ id: 'x', quoteId: 'Q9' }];
    saveFleetProgress(77, cands, 77);
    const loaded = loadFleetProgress();
    expect(loaded).toEqual({ offset: 77, accumulated: cands, totalScanned: 77 });
  });

  it('loadFleetProgress returns null when nothing is stored', () => {
    expect(loadFleetProgress()).toBeNull();
  });

  it('removeFleetProgress clears the stored checkpoint', () => {
    saveFleetProgress(50, [], 50);
    removeFleetProgress();
    expect(loadFleetProgress()).toBeNull();
    expect(sessionStorage.getItem(FLEET_SCAN_KEY)).toBeNull();
  });
});
