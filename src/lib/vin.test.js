import { describe, it, expect } from 'vitest';
import { vinValid, extractVin17, vehicleDescFromDecode, scannedVinDecision } from './vin';

// Scan → intake seed gate: VinScanner calls onDetected(vin, vinValid(vin)) and
// IntakeScreen feeds that through scannedVinDecision before seeding an intake.
describe('scannedVinDecision (scan → intake seed path)', () => {
  const GOOD = '1HGCM82633A004352';
  const BAD_CHECK = '1HGCM82683A004352'; // check-digit position corrupted

  it('seeds when the scanned VIN passes the check digit', () => {
    expect(scannedVinDecision(GOOD, true)).toEqual({ seed: true, vin: GOOD, message: '' });
  });

  it('blocks a scanned VIN with a failing check digit — never silently seeds', () => {
    const d = scannedVinDecision(BAD_CHECK, false);
    expect(d.seed).toBe(false);
    expect(d.vin).toBe(BAD_CHECK);
    expect(d.message).toMatch(/check digit/i);
    expect(d.message).toMatch(/override/i);
  });

  it('recomputes validity itself when the scanner flag is missing', () => {
    expect(scannedVinDecision(GOOD).seed).toBe(true);
    expect(scannedVinDecision(BAD_CHECK).seed).toBe(false);
  });

  it('never trusts a stale "valid" flag over the actual VIN length', () => {
    const d = scannedVinDecision('1HGCM82633A00435', true); // 16 chars
    expect(d.seed).toBe(false);
    expect(d.message).toMatch(/17/);
  });

  it('normalizes casing and strips separators before deciding', () => {
    const d = scannedVinDecision(' 1hgcm82633a004352 ', undefined);
    expect(d).toEqual({ seed: true, vin: GOOD, message: '' });
  });
});

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

describe('vehicleDescFromDecode', () => {
  it('builds "Year Make Model Trim" from a vPIC result row', () => {
    expect(vehicleDescFromDecode({ ModelYear: '2013', Make: 'FORD', Model: 'F-150', Trim: 'XLT' })).toBe('2013 Ford F-150 XLT');
  });

  it('keeps short all-caps makes like GMC and RAM as-is', () => {
    expect(vehicleDescFromDecode({ ModelYear: '2021', Make: 'GMC', Model: 'Sierra 2500HD' })).toBe('2021 GMC Sierra 2500HD');
    expect(vehicleDescFromDecode({ ModelYear: '2019', Make: 'RAM', Model: '2500' })).toBe('2019 RAM 2500');
  });

  it('omits missing parts without extra whitespace', () => {
    expect(vehicleDescFromDecode({ ModelYear: '2013', Make: 'FORD', Model: 'F-150', Trim: '' })).toBe('2013 Ford F-150');
    expect(vehicleDescFromDecode({ Make: 'FORD' })).toBe('Ford');
  });

  it('returns null when the decode has no useful fields', () => {
    expect(vehicleDescFromDecode({})).toBeNull();
    expect(vehicleDescFromDecode(null)).toBeNull();
    expect(vehicleDescFromDecode({ Trim: 'XLT' })).toBeNull();
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
