import { describe, expect, it } from 'vitest';
import { reportRangeForPeriod } from './reportRange';

describe('reportRangeForPeriod', () => {
  it('uses the Chicago calendar day even when UTC is already the next day', () => {
    const now = Date.parse('2026-01-01T05:30:00Z'); // Dec 31, 11:30pm in Chicago
    expect(reportRangeForPeriod('mtd', now)).toEqual({ from: '2025-12-01', to: '2025-12-31' });
  });

  it('builds week-to-date from the configured week start', () => {
    const now = Date.parse('2026-08-19T18:00:00Z'); // Wednesday in Chicago
    expect(reportRangeForPeriod('wtd', now)).toEqual({ from: '2026-08-17', to: '2026-08-19' });
  });

  it('builds exact prior-month bounds from the existing period key', () => {
    expect(reportRangeForPeriod('m2024-1', Date.parse('2026-08-19T18:00:00Z')))
      .toEqual({ from: '2024-02-01', to: '2024-02-29' });
  });
});