import { describe, it, expect } from 'vitest';
import { initials, csvEsc, fmtDT, fmtD, fmtShort } from './format';

describe('initials', () => {
  it('takes the first letter of the first two words', () => {
    expect(initials('R. Delgado')).toBe('RD');
    expect(initials('Theran')).toBe('T');
    expect(initials('Ryan')).toBe('R');
  });

  it('falls back to a placeholder when nothing alphabetic is present', () => {
    expect(initials('123')).toBe('?');
  });
});

describe('csvEsc', () => {
  it('passes plain values through unescaped', () => {
    expect(csvEsc('T-4821')).toBe('T-4821');
    expect(csvEsc(42)).toBe('42');
  });

  it('quotes and escapes values containing commas', () => {
    expect(csvEsc('Mechanical, Cosmetic')).toBe('"Mechanical, Cosmetic"');
  });

  it('quotes and doubles embedded quotes', () => {
    expect(csvEsc('Fail note: "loose bolt"')).toBe('"Fail note: ""loose bolt"""');
  });

  it('quotes values containing newlines', () => {
    expect(csvEsc('line1\nline2')).toBe('"line1\nline2"');
  });

  it('renders null/undefined as an empty string', () => {
    expect(csvEsc(null)).toBe('');
    expect(csvEsc(undefined)).toBe('');
  });
});

describe('date formatters', () => {
  // Fixed timestamp: Jan 5, 2026, 14:30 local time.
  const ts = new Date(2026, 0, 5, 14, 30).getTime();

  it('fmtDT includes a 12-hour time with AM/PM', () => {
    expect(fmtDT(ts)).toBe('Jan 5 · 2:30 PM');
  });

  it('fmtD renders a full date with year', () => {
    expect(fmtD(ts)).toBe('Jan 5, 2026');
  });

  it('fmtShort renders month + day only', () => {
    expect(fmtShort(ts)).toBe('Jan 5');
  });
});
