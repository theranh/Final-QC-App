import { describe, it, expect } from 'vitest';
import { convertOldReconBackup } from './exports';

const oldRec = (over = {}) => ({
  id: 'abc123',
  stockNumber: 'T555',
  mileage: '42000',
  truckInfo: { year: '2021', make: 'Ford', model: 'F-250', vin: '1FT8W3BT1MED12345' },
  inspector: 'Bob',
  notes: 'general note',
  status: 'passed',
  createdAt: '2026-06-01T10:00:00.000Z',
  completedAt: '2026-06-01T11:00:00.000Z',
  checklist: [
    { category: 'Mechanical', label: 'Cold start', checked: true, failed: false, deferred: false, note: '', photos: [] },
    { category: 'Electrical', label: 'Backup camera functional', checked: true, failed: false, deferred: false, note: '', photos: [] },
    { category: 'Cosmetic', label: 'Paint match', checked: false, failed: true, deferred: false, note: 'scratch', photos: ['file:///device/x.jpg', 'data:image/jpeg;base64,abcd'] },
    { category: 'Interior', label: 'Carpets', checked: false, failed: false, deferred: true, note: '', photos: [] },
  ],
  ...over,
});

describe('convertOldReconBackup (old Truck Recon Checklist app)', () => {
  it('converts completed records to this app import format, letting the server assign FQ numbers', () => {
    const { inspections, skippedInProgress } = convertOldReconBackup([
      oldRec(),
      oldRec({ status: 'failed', completedAt: '2026-06-02T09:00:00.000Z' }),
      oldRec({ status: 'in-progress' }),
      oldRec({ completedAt: 'not-a-date', createdAt: null }),
    ]);
    expect(skippedInProgress).toBe(2); // in-progress + unreadable date
    expect(inspections).toHaveLength(2);
    expect(inspections.every((i) => i.id === undefined)).toBe(true);
    const first = inspections[0];
    expect(first.vin).toBe('1FT8W3BT1MED12345');
    expect(first.stock).toBe('T555');
    expect(first.vehicle).toBe('2021 Ford F-250');
    expect(first.result).toBe('pass');
    expect(first.status).toBe('pass');
    expect(first.inspector).toBe('Bob');
    expect(first.ts).toBe(new Date('2026-06-01T11:00:00.000Z').getTime());
  });

  it('maps categories, marks, notes, and keeps only portable photos', () => {
    const { inspections } = convertOldReconBackup([oldRec()]);
    const items = inspections[0].items;
    // Mechanical + Electrical land in mech
    expect(items.mech.map((i) => i.mark)).toEqual(['p', 'p']);
    // Failed cosmetic item keeps note, drops device-file photo, keeps data: photo
    expect(items.cosm[0]).toMatchObject({ mark: 'f', note: 'scratch' });
    expect(items.cosm[0].photos).toEqual(['data:image/jpeg;base64,abcd']);
    // Deferred interior item is unchecked
    expect(items.detail[0].mark).toBe('n');
    expect(inspections[0].checked).toBe(3);
    expect(inspections[0].failCount).toBe(1);
  });

  it('marks old failed inspections as open re-checks', () => {
    const { inspections } = convertOldReconBackup([oldRec({ status: 'failed' })]);
    expect(inspections[0].result).toBe('fail');
    expect(inspections[0].status).toBe('open');
  });
});
