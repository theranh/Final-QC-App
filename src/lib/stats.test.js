import { describe, it, expect } from 'vitest';
import { periodDefs, curPeriod, computeStats } from './stats';

function rec(over) {
  return {
    ts: Date.now(),
    inspector: 'R. Delgado',
    title: 'VRA',
    result: 'pass',
    status: 'pass',
    clearedTs: null,
    items: {},
    ...over,
  };
}

describe('periodDefs', () => {
  it('always includes Week to date and Month to date', () => {
    const defs = periodDefs([]);
    expect(defs.map((d) => d.k)).toContain('wtd');
    expect(defs.map((d) => d.k)).toContain('mtd');
    expect(defs[0].k).toBe('wtd');
    expect(defs[1].k).toBe('mtd');
  });

  it('adds a past-month entry once a record exists in that month, but not the current month twice', () => {
    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1, 15);
    const defs = periodDefs([rec({ ts: lastMonth.getTime() })]);
    const now = new Date();
    const curKey = 'm' + now.getFullYear() + '-' + now.getMonth();
    expect(defs.some((d) => d.k !== 'wtd' && d.k !== 'mtd')).toBe(true);
    expect(defs.filter((d) => d.k === curKey)).toHaveLength(0);
  });
});

describe('curPeriod', () => {
  it('filters records to those within the selected period window', () => {
    const inWindow = rec({ ts: Date.now() });
    const longAgo = rec({ ts: new Date(2000, 0, 1).getTime() });
    const p = curPeriod([inWindow, longAgo], 'mtd');
    expect(p.recs).toContain(inWindow);
    expect(p.recs).not.toContain(longAgo);
  });
});

describe('computeStats', () => {
  it('computes totals, pass/fail counts, and the first-pass rate', () => {
    const period = {
      start: 0,
      end: Infinity,
      recs: [rec({ result: 'pass' }), rec({ result: 'pass' }), rec({ result: 'fail', status: 'open' })],
    };
    const st = computeStats(period.recs, period);
    expect(st.total).toBe(3);
    expect(st.pass).toBe(2);
    expect(st.fail).toBe(1);
    expect(st.rate).toBeCloseTo(66.7, 1);
  });

  it('returns a null rate when there are zero inspections in the period', () => {
    const period = { start: 0, end: Infinity, recs: [] };
    expect(computeStats([], period).rate).toBeNull();
  });

  it('tallies fails by category and finds the most-failed item', () => {
    const failingRec = rec({
      result: 'fail',
      status: 'open',
      items: {
        mech: [{ item: 'Cold start & idle', mark: 'f' }],
        cosm: [{ item: 'Panel paint match', mark: 'f' }],
      },
    });
    const period = { start: 0, end: Infinity, recs: [failingRec, failingRec] };
    const st = computeStats([failingRec, failingRec], period);
    expect(st.catFails.mech).toBe(2);
    expect(st.catFails.cosm).toBe(2);
    expect(st.top[0]).toMatchObject({ item: 'Cold start & idle', count: 2 });
  });

  it('counts currently-open re-checks from the full record set, not just the period', () => {
    const openElsewhere = rec({ status: 'open', ts: new Date(2000, 0, 1).getTime() });
    const period = { start: Date.now() - 1000, end: Infinity, recs: [] };
    const st = computeStats([openElsewhere], period);
    expect(st.openNow).toBe(1);
  });

  it('computes avg fail-to-cleared days for re-checks cleared within the period', () => {
    const clearedRec = rec({
      status: 'cleared',
      ts: new Date(2026, 0, 1).getTime(),
      clearedTs: new Date(2026, 0, 4).getTime(), // 3 days later
    });
    const period = { start: new Date(2026, 0, 1).getTime(), end: new Date(2026, 1, 1).getTime(), recs: [] };
    const st = computeStats([clearedRec], period);
    expect(st.cleared).toBe(1);
    expect(st.avgClear).toBe(3);
  });
});
