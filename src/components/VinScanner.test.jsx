// Tests for VinScanner mode prop backward-compatibility.
// The default VIN mode must behave exactly as before the mode prop was added.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('../lib/zxingDecode', () => ({
  prefetchZxing: vi.fn(),
  zxingDecodeImageData: vi.fn(() => null),
}));

vi.mock('../lib/vin', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod };
});

import VinScanner from './VinScanner';

// Stub getUserMedia to avoid the actual camera in jsdom.
const mockStream = {
  getTracks: () => [{ stop: vi.fn(), getCapabilities: () => ({}), applyConstraints: () => Promise.resolve() }],
  getVideoTracks: () => [{ stop: vi.fn(), getCapabilities: () => ({}), applyConstraints: () => Promise.resolve() }],
};
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: vi.fn().mockRejectedValue(new Error('no camera in test')) },
    configurable: true,
  });
});
afterEach(() => {
  cleanup();
});

describe('VinScanner — default VIN mode (no mode prop)', () => {
  it('renders without crashing when no mode prop is given', () => {
    expect(() =>
      render(<VinScanner onDetected={() => {}} onCancel={() => {}} />)
    ).not.toThrow();
  });

  it('shows "Scan VIN barcode" heading', async () => {
    render(<VinScanner onDetected={() => {}} onCancel={() => {}} />);
    expect(screen.getAllByText(/Scan VIN barcode/i).length).toBeGreaterThan(0);
  });

  it('shows "Cancel — type VIN manually" when camera fails', async () => {
    render(<VinScanner onDetected={() => {}} onCancel={() => {}} />);
    // After camera fails the cancel button appears with VIN text
    expect(screen.getAllByText(/type VIN manually/i).length).toBeGreaterThan(0);
  });
});

describe('VinScanner — stock mode', () => {
  it('renders without crashing with mode="stock"', () => {
    expect(() =>
      render(<VinScanner mode="stock" onDetected={() => {}} onCancel={() => {}} />)
    ).not.toThrow();
  });

  it('shows "Scan stock label" heading', () => {
    render(<VinScanner mode="stock" onDetected={() => {}} onCancel={() => {}} />);
    expect(screen.getAllByText(/Scan stock label/i).length).toBeGreaterThan(0);
  });

  it('shows "Cancel — type stock manually" button', () => {
    render(<VinScanner mode="stock" onDetected={() => {}} onCancel={() => {}} />);
    expect(screen.getAllByText(/type stock manually/i).length).toBeGreaterThan(0);
  });
});

describe('VinScanner — explicit mode="vin"', () => {
  it('behaves identically to the default (no mode prop)', () => {
    render(<VinScanner mode="vin" onDetected={() => {}} onCancel={() => {}} />);
    expect(screen.getAllByText(/Scan VIN barcode/i).length).toBeGreaterThan(0);
  });
});
