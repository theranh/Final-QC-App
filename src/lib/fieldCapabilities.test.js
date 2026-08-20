import { describe, it, expect } from 'vitest';
import { parseStockLabel } from './fieldCapabilities';

describe('parseStockLabel', () => {
  // Valid cases
  it('parses a plain stock code', () => {
    expect(parseStockLabel('T-0000')).toBe('T-0000');
  });

  it('parses tightly scoped plain numeric and short-prefix stock codes', () => {
    expect(parseStockLabel('48210')).toBe('48210');
    expect(parseStockLabel('ABC123')).toBe('ABC123');
  });

  it('parses STOCK: prefix', () => {
    expect(parseStockLabel('STOCK: ABC123')).toBe('ABC123');
  });

  it('parses STOCK # prefix with hyphen in code', () => {
    expect(parseStockLabel('STOCK # ABC-123')).toBe('ABC-123');
  });

  it('parses STK prefix', () => {
    expect(parseStockLabel('STK ABC123')).toBe('ABC123');
  });

  it('parses STK# prefix', () => {
    expect(parseStockLabel('STK# T1234')).toBe('T1234');
  });

  it('parses UNIT prefix', () => {
    expect(parseStockLabel('UNIT ABC123')).toBe('ABC123');
  });

  it('parses UNIT: prefix', () => {
    expect(parseStockLabel('UNIT:XYZ789')).toBe('XYZ789');
  });

  it('normalises internal spaces to hyphens', () => {
    expect(parseStockLabel('STOCK: AB CD')).toBe('AB-CD');
  });

  it('upper-cases the result', () => {
    expect(parseStockLabel('stock: abc123')).toBe('ABC123');
  });

  it('handles leading and trailing whitespace', () => {
    expect(parseStockLabel('  T-9999  ')).toBe('T-9999');
  });

  // Invalid / junk cases
  it('returns null for empty string', () => {
    expect(parseStockLabel('')).toBeNull();
  });

  it('returns null for null', () => {
    expect(parseStockLabel(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(parseStockLabel(undefined)).toBeNull();
  });

  it('returns null for string of only separators', () => {
    expect(parseStockLabel('---')).toBeNull();
  });

  it('returns null for code longer than 30 characters', () => {
    expect(parseStockLabel('A'.repeat(31))).toBeNull();
  });

  it('returns null for string of only control characters', () => {
    expect(parseStockLabel('\x00\x01\x1f')).toBeNull();
  });

  it('returns null for string with no alphanumeric characters', () => {
    expect(parseStockLabel('STOCK: ---')).toBeNull();
  });

  it('rejects an embedded control character instead of changing the scan', () => {
    expect(parseStockLabel('ABC\x00' + '123')).toBeNull();
  });

  it('rejects arbitrary QR URLs and prose', () => {
    expect(parseStockLabel('https://example.com/stock/ABC123')).toBeNull();
    expect(parseStockLabel('this is not a stock label')).toBeNull();
  });

  it('rejects arbitrary one-token QR payloads', () => {
    expect(parseStockLabel('HELLO')).toBeNull();
    expect(parseStockLabel('RANDOM123')).toBeNull();
    expect(parseStockLabel('STOCKADE')).toBeNull();
  });

  it('accepts a 30-character code at the boundary', () => {
    const code = 'A'.repeat(30);
    expect(parseStockLabel(`STOCK: ${code}`)).toBe(code);
  });

  it('rejects a 31-character code just over the boundary', () => {
    expect(parseStockLabel(`STOCK: ${'A'.repeat(31)}`)).toBeNull();
  });
});
