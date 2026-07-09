import { describe, it, expect } from 'vitest';
import { CATS } from './constants';
import { statusMeta, failList, filterRecords, recheckDatesLabel } from './records';

function makeRecord(overrides = {}) {
  return {
    id: 'FQ-1001',
    ts: new Date(2026, 0, 10, 9, 0).getTime(),
    stock: 'T-4821',
    vehicle: '2021 F-150 XLT',
    vin: '1HGCM82633A004352',
    inspector: 'R. Delgado',
    title: 'VRA',
    result: 'pass',
    status: 'pass',
    clearedTs: null,
    rechecks: [],
    items: { mech: [{ item: 'Cold start & idle', mark: 'p' }] },
    checked: 1,
    failCount: 0,
    ...overrides,
  };
}

describe('statusMeta', () => {
  it('labels a clean pass', () => {
    expect(statusMeta(makeRecord()).label).toBe('PASS');
  });
  it('labels an open re-check', () => {
    expect(statusMeta(makeRecord({ status: 'open' })).label).toBe('OPEN RE-CHECK');
  });
  it('labels a pass after re-check', () => {
    expect(statusMeta(makeRecord({ status: 'cleared' })).label).toBe('PASS · RE-CHECK');
  });
});

describe('failList', () => {
  it('collects only failed items across categories, with category label/segment', () => {
    const r = makeRecord({
      items: {
        mech: [{ item: 'Cold start & idle', mark: 'f', note: 'rough idle', photos: ['data:x'] }, { item: 'Fluid leaks', mark: 'p' }],
        cosm: [{ item: 'Panel paint match', mark: 'f', note: 'scratch', photos: [] }],
      },
    });
    const fails = failList(r, CATS);
    expect(fails).toHaveLength(2);
    expect(fails[0]).toMatchObject({ k: 'mech', seg: 'MECH', item: 'Cold start & idle', note: 'rough idle', photos: ['data:x'] });
    expect(fails[1]).toMatchObject({ k: 'cosm', item: 'Panel paint match', note: 'scratch' });
  });

  it('returns an empty array when nothing failed', () => {
    expect(failList(makeRecord(), CATS)).toHaveLength(0);
  });
});

describe('recheckDatesLabel', () => {
  it('joins re-check timestamps', () => {
    const fmtDT = (ts) => `T${ts}`;
    const r = makeRecord({ rechecks: [{ ts: 1 }, { ts: 2 }] });
    expect(recheckDatesLabel(r, fmtDT)).toBe('T1; T2');
  });
  it('is empty when there are no re-checks', () => {
    const fmtDT = (ts) => `T${ts}`;
    expect(recheckDatesLabel(makeRecord(), fmtDT)).toBe('');
  });
});

describe('filterRecords', () => {
  const recs = [
    makeRecord({ id: 'FQ-1001', stock: 'T-4821', vehicle: '2021 F-150 XLT', inspector: 'R. Delgado', status: 'pass', ts: new Date(2026, 0, 5).getTime() }),
    makeRecord({ id: 'FQ-1002', stock: 'T-9999', vehicle: '2019 RAM 2500', inspector: 'Theran', vin: '1FTFW1ET5BFC10312', status: 'open', ts: new Date(2026, 0, 10).getTime() }),
  ];

  it('filters by free-text search across stock/vehicle/vin/inspector/id', () => {
    expect(filterRecords(recs, { q: 'ram', fRes: 'all', fFrom: '', fTo: '' })).toHaveLength(1);
    expect(filterRecords(recs, { q: 'theran', fRes: 'all', fFrom: '', fTo: '' })[0].id).toBe('FQ-1002');
    expect(filterRecords(recs, { q: 'fq-1001', fRes: 'all', fFrom: '', fTo: '' })).toHaveLength(1);
  });

  it('filters by result: pass excludes open re-checks, fail/open excludes everything else', () => {
    expect(filterRecords(recs, { q: '', fRes: 'pass', fFrom: '', fTo: '' }).map((r) => r.id)).toEqual(['FQ-1001']);
    expect(filterRecords(recs, { q: '', fRes: 'fail', fFrom: '', fTo: '' }).map((r) => r.id)).toEqual(['FQ-1002']);
  });

  it('filters by date range (inclusive)', () => {
    const inRange = filterRecords(recs, { q: '', fRes: 'all', fFrom: '2026-01-06', fTo: '2026-01-31' });
    expect(inRange.map((r) => r.id)).toEqual(['FQ-1002']);
  });

  it('returns everything when no filters are set', () => {
    expect(filterRecords(recs, { q: '', fRes: 'all', fFrom: '', fTo: '' })).toHaveLength(2);
  });
});
