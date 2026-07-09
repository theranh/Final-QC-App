import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadLS,
  saveLS,
  migrateRecord,
  newDraft,
  stripRc,
  persistDraftBundle,
  initDraftBoot,
  hasLegacyData,
  loadLegacyData,
  legacyImportDone,
  markLegacyImported,
} from './storage';

beforeEach(() => {
  localStorage.clear();
});

describe('loadLS / saveLS', () => {
  it('round-trips a JSON-serializable value', () => {
    expect(saveLS('widget', { a: 1, b: [1, 2, 3] })).toBe(true);
    expect(loadLS('widget', null)).toEqual({ a: 1, b: [1, 2, 3] });
  });

  it('returns the fallback when the key is missing', () => {
    expect(loadLS('does-not-exist', 'fallback')).toBe('fallback');
  });

  it('returns the fallback (not a crash) when stored JSON is corrupt', () => {
    localStorage.setItem('fqc_broken', '{not json');
    expect(loadLS('broken', 'fallback')).toBe('fallback');
  });
});

describe('migrateRecord', () => {
  it('derives status from result on legacy records missing it', () => {
    const passRec = migrateRecord({ result: 'pass', items: {} });
    expect(passRec.status).toBe('pass');
    expect(passRec.rechecks).toEqual([]);
    expect(passRec.openItems).toEqual([]);
  });

  it('marks a legacy failed record as open with its fails carried into openItems', () => {
    const failRec = migrateRecord({
      result: 'fail',
      items: { mech: [{ item: 'Cold start & idle', mark: 'f', note: 'rough', photos: [] }] },
    });
    expect(failRec.status).toBe('open');
    expect(failRec.openItems).toHaveLength(1);
    expect(failRec.openItems[0]).toMatchObject({ cat: 'mech', item: 'Cold start & idle', note: 'rough' });
  });

  it('leaves an already-migrated record untouched', () => {
    const rec = { result: 'pass', status: 'cleared', rechecks: [{ ts: 1 }], openItems: [], items: {} };
    expect(migrateRecord({ ...rec })).toEqual(rec);
  });
});

describe('stripRc', () => {
  it('removes re-check-scoped keys but keeps everything else', () => {
    const m = { 'mech|0': 'p', 'rc|0': 'f', 'rc|1': 'p' };
    expect(stripRc(m)).toEqual({ 'mech|0': 'p' });
  });
  it('handles an empty/undefined map', () => {
    expect(stripRc(undefined)).toEqual({});
  });
});

describe('newDraft', () => {
  it('creates an empty draft pre-assigned to the given inspector', () => {
    expect(newDraft('me')).toEqual({ stock: '', vehicle: '', vin: '', uid: 'me' });
  });
});

describe('persistDraftBundle', () => {
  it('only keeps stage when it is "sheet" or "form", and strips rc| scoped state', () => {
    const ok = persistDraftBundle({
      draft: { stock: 'T-1', vehicle: 'Truck', vin: '', uid: 'me' },
      marks: { 'mech|0': 'p', 'rc|0': 'f' },
      notes: { 'rc|0': 'note' },
      photos: {},
      optOut: {},
      stage: 'result',
    });
    expect(ok).toBe(true);
    const saved = loadLS('draft', null);
    expect(saved.stage).toBeNull();
    expect(saved.marks).toEqual({ 'mech|0': 'p' });
    expect(saved.notes).toEqual({});
  });

  it('keeps stage "form" as-is', () => {
    persistDraftBundle({ draft: newDraft('me'), marks: {}, notes: {}, photos: {}, optOut: {}, stage: 'form' });
    expect(loadLS('draft', null).stage).toBe('form');
  });
});

describe('initDraftBoot', () => {
  it('boots with an empty draft and no stage on a fresh device', () => {
    const boot = initDraftBoot();
    expect(boot.draft).toEqual({ stock: '', vehicle: '', vin: '', uid: 'me' });
    expect(boot.stage).toBeNull();
    expect(boot.marks).toEqual({});
  });

  it('resumes an in-progress draft that was mid-checklist when last saved', () => {
    saveLS('draft', { draft: { stock: 'T-1', vehicle: 'Truck', vin: '', uid: 'me' }, marks: { 'mech|0': 'p' }, notes: {}, photos: {}, optOut: {}, stage: 'sheet' });
    const boot = initDraftBoot();
    expect(boot.stage).toBe('sheet');
    expect(boot.draft.stock).toBe('T-1');
    expect(boot.marks).toEqual({ 'mech|0': 'p' });
  });
});

describe('legacy on-device data', () => {
  it('detects legacy inspections and migrates them for import', () => {
    expect(hasLegacyData()).toBe(false);
    saveLS('inspections', [{ id: 'FQ-1001', ts: 1, result: 'fail', items: {} }]);
    saveLS('seq', 1002);
    expect(hasLegacyData()).toBe(true);
    const data = loadLegacyData();
    expect(data.seq).toBe(1002);
    expect(data.inspections[0].status).toBe('open');
  });

  it('tracks the one-time import flag', () => {
    expect(legacyImportDone()).toBe(false);
    markLegacyImported();
    expect(legacyImportDone()).toBe(true);
  });
});
