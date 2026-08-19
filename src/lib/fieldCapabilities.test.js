// Tests for passive capability checks and stock-label parser.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  cameraApiAvailable,
  nativeBarcodeAvailable,
  speechRecognitionAvailable,
  isOnline,
  storagePersistenceStatus,
  checkQueuePersistence,
  getQueuedUploadCount,
  getReadiness,
  parseStockLabel,
} from './fieldCapabilities';

// ---------- passive capability checks ----------

describe('cameraApiAvailable', () => {
  it('returns true when navigator.mediaDevices.getUserMedia is present', () => {
    const origMd = navigator.mediaDevices;
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: () => {} },
      configurable: true,
    });
    expect(cameraApiAvailable()).toBe(true);
    Object.defineProperty(navigator, 'mediaDevices', { value: origMd, configurable: true });
  });

  it('returns false when navigator.mediaDevices is absent', () => {
    const origMd = navigator.mediaDevices;
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
    expect(cameraApiAvailable()).toBe(false);
    Object.defineProperty(navigator, 'mediaDevices', { value: origMd, configurable: true });
  });
});

describe('nativeBarcodeAvailable', () => {
  it('returns true when window.BarcodeDetector is defined', () => {
    window.BarcodeDetector = class {};
    expect(nativeBarcodeAvailable()).toBe(true);
    delete window.BarcodeDetector;
  });

  it('returns false when window.BarcodeDetector is absent', () => {
    delete window.BarcodeDetector;
    expect(nativeBarcodeAvailable()).toBe(false);
  });
});

describe('speechRecognitionAvailable', () => {
  it('returns true when window.SpeechRecognition is present', () => {
    window.SpeechRecognition = class {};
    expect(speechRecognitionAvailable()).toBe(true);
    delete window.SpeechRecognition;
  });

  it('returns true when window.webkitSpeechRecognition is present', () => {
    window.webkitSpeechRecognition = class {};
    expect(speechRecognitionAvailable()).toBe(true);
    delete window.webkitSpeechRecognition;
  });

  it('returns false when neither speech API is present', () => {
    delete window.SpeechRecognition;
    delete window.webkitSpeechRecognition;
    expect(speechRecognitionAvailable()).toBe(false);
  });
});

describe('isOnline', () => {
  it('returns true when navigator.onLine is true', () => {
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    expect(isOnline()).toBe(true);
  });

  it('returns false when navigator.onLine is false (simulated offline)', () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    expect(isOnline()).toBe(false);
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  });
});

describe('storagePersistenceStatus', () => {
  it('returns "persistent" when navigator.storage.persisted() resolves true', async () => {
    const origStorage = navigator.storage;
    Object.defineProperty(navigator, 'storage', {
      value: { persisted: () => Promise.resolve(true) },
      configurable: true,
    });
    const result = await storagePersistenceStatus();
    expect(result).toBe('persistent');
    Object.defineProperty(navigator, 'storage', { value: origStorage, configurable: true });
  });

  it('returns "best-effort" when navigator.storage.persisted() resolves false', async () => {
    const origStorage = navigator.storage;
    Object.defineProperty(navigator, 'storage', {
      value: { persisted: () => Promise.resolve(false) },
      configurable: true,
    });
    const result = await storagePersistenceStatus();
    expect(result).toBe('best-effort');
    Object.defineProperty(navigator, 'storage', { value: origStorage, configurable: true });
  });

  it('returns "unknown" when navigator.storage is absent', async () => {
    const origStorage = navigator.storage;
    Object.defineProperty(navigator, 'storage', { value: undefined, configurable: true });
    const result = await storagePersistenceStatus();
    expect(result).toBe('unknown');
    Object.defineProperty(navigator, 'storage', { value: origStorage, configurable: true });
  });

  it('returns "unknown" when navigator.storage.persisted() throws', async () => {
    const origStorage = navigator.storage;
    Object.defineProperty(navigator, 'storage', {
      value: { persisted: () => Promise.reject(new Error('blocked')) },
      configurable: true,
    });
    const result = await storagePersistenceStatus();
    expect(result).toBe('unknown');
    Object.defineProperty(navigator, 'storage', { value: origStorage, configurable: true });
  });
});

describe('checkQueuePersistence', () => {
  it('returns true when probePersistenceFn resolves to true', async () => {
    const probe = vi.fn().mockResolvedValue(true);
    expect(await checkQueuePersistence(probe)).toBe(true);
  });

  it('returns false when probePersistenceFn resolves to false (private mode)', async () => {
    const probe = vi.fn().mockResolvedValue(false);
    expect(await checkQueuePersistence(probe)).toBe(false);
  });

  it('returns false when probePersistenceFn throws (IDB unavailable)', async () => {
    const probe = vi.fn().mockRejectedValue(new Error('IndexedDB unavailable'));
    expect(await checkQueuePersistence(probe)).toBe(false);
  });
});

describe('getQueuedUploadCount', () => {
  it('returns the number of pending jobs', async () => {
    const pendingFn = vi.fn().mockResolvedValue([{}, {}, {}]);
    expect(await getQueuedUploadCount(pendingFn)).toBe(3);
  });

  it('returns 0 when the queue is empty', async () => {
    const pendingFn = vi.fn().mockResolvedValue([]);
    expect(await getQueuedUploadCount(pendingFn)).toBe(0);
  });

  it('returns 0 on failure (offline / IDB error)', async () => {
    const pendingFn = vi.fn().mockRejectedValue(new Error('offline'));
    expect(await getQueuedUploadCount(pendingFn)).toBe(0);
  });
});

describe('getReadiness', () => {
  it('returns a complete readiness snapshot', async () => {
    const probePersistenceFn = vi.fn().mockResolvedValue(true);
    const pendingJobsFn = vi.fn().mockResolvedValue([{}, {}]);
    const origStorage = navigator.storage;
    Object.defineProperty(navigator, 'storage', {
      value: { persisted: () => Promise.resolve(true) },
      configurable: true,
    });

    const r = await getReadiness({ probePersistenceFn, pendingJobsFn });

    expect(typeof r.cameraSupported).toBe('boolean');
    expect(typeof r.nativeBarcode).toBe('boolean');
    expect(typeof r.speechSupported).toBe('boolean');
    expect(typeof r.online).toBe('boolean');
    expect(r.persistenceOk).toBe(true);
    expect(r.storagePersistence).toBe('persistent');
    expect(r.queuedUploads).toBe(2);

    Object.defineProperty(navigator, 'storage', { value: origStorage, configurable: true });
  });

  it('reports persistenceOk=false on private-mode IDB failure', async () => {
    const probePersistenceFn = vi.fn().mockResolvedValue(false);
    const pendingJobsFn = vi.fn().mockResolvedValue([]);
    const r = await getReadiness({ probePersistenceFn, pendingJobsFn });
    expect(r.persistenceOk).toBe(false);
  });

  it('Continue is still possible when readiness is degraded (snapshot only; no blocking)', async () => {
    // The function itself never throws — callers decide whether to block.
    const probePersistenceFn = vi.fn().mockRejectedValue(new Error('private mode'));
    const pendingJobsFn = vi.fn().mockRejectedValue(new Error('offline'));
    const r = await getReadiness({ probePersistenceFn, pendingJobsFn });
    // Degraded, but a value is returned — caller can always continue.
    expect(r).toBeDefined();
    expect(r.persistenceOk).toBe(false);
    expect(r.queuedUploads).toBe(0);
  });
});

// ---------- stock-label parser ----------

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
