import { describe, it, expect } from 'vitest';
import { vinValid, extractVin17 } from './vin';

describe('vinValid', () => {
  it('accepts a real, correctly-checksummed 17-character VIN', () => {
    expect(vinValid('1HGCM82633A004352')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(vinValid('1hgcm82633a004352')).toBe(true);
  });

  it('rejects a VIN with a wrong check digit', () => {
    // Same real VIN with the check-digit position (index 8, was '3') corrupted to '8'.
    expect(vinValid('1HGCM82683A004352')).toBe(false);
  });

  it('rejects anything that is not exactly 17 characters', () => {
    expect(vinValid('1HGCM82633A00435')).toBe(false); // 16 chars
    expect(vinValid('1HGCM82633A0043522')).toBe(false); // 18 chars
    expect(vinValid('')).toBe(false);
    expect(vinValid(null)).toBe(false);
    expect(vinValid(undefined)).toBe(false);
  });

  it('rejects VINs containing the forbidden letters I, O, Q', () => {
    expect(vinValid('1HGCM8263IA004352')).toBe(false);
    expect(vinValid('1HGCM8263OA004352')).toBe(false);
    expect(vinValid('1HGCM8263QA004352')).toBe(false);
  });
});

describe('extractVin17', () => {
  it('pulls a 17-char VIN out of noisy scanned text', () => {
    expect(extractVin17('  1hgcm82633a004352 \n')).toBe('1HGCM82633A004352');
  });

  it('returns null when no 17-char run of valid characters exists', () => {
    expect(extractVin17('not a vin')).toBeNull();
    expect(extractVin17('')).toBeNull();
    expect(extractVin17(null)).toBeNull();
  });
});
