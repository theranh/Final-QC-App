// Tests for VinScanner mode prop backward-compatibility.
// The default VIN mode must behave exactly as before the mode prop was added.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';

const { prefetchZxing, zxingDecodeImageData } = vi.hoisted(() => ({
  prefetchZxing: vi.fn(() => Promise.resolve()),
  zxingDecodeImageData: vi.fn(() => null),
}));
vi.mock('../lib/zxingDecode', () => ({
  prefetchZxing,
  zxingDecodeImageData,
}));

vi.mock('../lib/vin', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod };
});

import VinScanner from './VinScanner';

// Stub getUserMedia to avoid the actual camera in jsdom.
const makeStream = () => {
  const track = { stop: vi.fn(), getCapabilities: () => ({}), applyConstraints: () => Promise.resolve() };
  return {
    track,
    getTracks: () => [track],
    getVideoTracks: () => [track],
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: vi.fn().mockRejectedValue(new Error('no camera in test')) },
    configurable: true,
  });
  Object.defineProperty(HTMLMediaElement.prototype, 'play', { value: vi.fn(() => Promise.resolve()), configurable: true });
  Object.defineProperty(window, 'BarcodeDetector', { value: undefined, configurable: true, writable: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
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

describe('VinScanner camera and decode reliability', () => {
  const GOOD_VIN = '1HGCM82633A004352';

  function makeFramesAvailable() {
    Object.defineProperties(HTMLVideoElement.prototype, {
      readyState: { value: 4, configurable: true },
      videoWidth: { value: 1280, configurable: true },
      videoHeight: { value: 720, configurable: true },
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ width: 100, height: 40, data: new Uint8ClampedArray(16000) })),
    });
  }

  it('reads a valid VIN through ZXing and returns it to the caller', async () => {
    makeFramesAvailable();
    const stream = makeStream();
    navigator.mediaDevices.getUserMedia.mockResolvedValue(stream);
    zxingDecodeImageData.mockReturnValue(GOOD_VIN);
    const onDetected = vi.fn();

    render(<VinScanner onDetected={onDetected} onCancel={() => {}} />);
    await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1));

    await waitFor(() => expect(onDetected).toHaveBeenCalledWith(GOOD_VIN, true));
  });

  it('does not wait for a hung native detector capability check before decoding', async () => {
    makeFramesAvailable();
    const stream = makeStream();
    navigator.mediaDevices.getUserMedia.mockResolvedValue(stream);
    zxingDecodeImageData.mockReturnValue(GOOD_VIN);
    class HangingDetector {
      static getSupportedFormats() { return new Promise(() => {}); }
    }
    Object.defineProperty(window, 'BarcodeDetector', { value: HangingDetector, configurable: true, writable: true });
    const onDetected = vi.fn();

    render(<VinScanner onDetected={onDetected} onCancel={() => {}} />);
    await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1));

    await waitFor(() => expect(onDetected).toHaveBeenCalledWith(GOOD_VIN, true));
  });

  it('abandons a hung native detect call and continues through ZXing', async () => {
    makeFramesAvailable();
    const stream = makeStream();
    navigator.mediaDevices.getUserMedia.mockResolvedValue(stream);
    zxingDecodeImageData.mockReturnValue(GOOD_VIN);
    class HangingDetector {
      static getSupportedFormats() { return Promise.resolve(['code_39']); }
      detect() { return new Promise(() => {}); }
    }
    Object.defineProperty(window, 'BarcodeDetector', { value: HangingDetector, configurable: true, writable: true });
    const onDetected = vi.fn();

    render(<VinScanner onDetected={onDetected} onCancel={() => {}} />);

    await waitFor(() => expect(onDetected).toHaveBeenCalledWith(GOOD_VIN, true));
  });

  it('never submits a VIN from an in-flight scan after the scanner closes', async () => {
    makeFramesAvailable();
    const stream = makeStream();
    navigator.mediaDevices.getUserMedia.mockResolvedValue(stream);
    zxingDecodeImageData.mockReturnValue(GOOD_VIN);
    let finishDetect;
    const detect = vi.fn(() => new Promise((resolve) => { finishDetect = resolve; }));
    class DelayedDetector {
      static getSupportedFormats() { return Promise.resolve(['code_39']); }
      detect(video) { return detect(video); }
    }
    Object.defineProperty(window, 'BarcodeDetector', { value: DelayedDetector, configurable: true, writable: true });
    const onDetected = vi.fn();

    const { unmount } = render(<VinScanner onDetected={onDetected} onCancel={() => {}} />);
    await waitFor(() => expect(detect).toHaveBeenCalled());
    unmount();
    await act(async () => {
      finishDetect([]);
      await Promise.resolve();
    });

    expect(onDetected).not.toHaveBeenCalled();
  });

  it('tells the user when the camera opens but never supplies frames', async () => {
    vi.useFakeTimers();
    Object.defineProperties(HTMLVideoElement.prototype, {
      readyState: { value: 0, configurable: true },
      videoWidth: { value: 0, configurable: true },
      videoHeight: { value: 0, configurable: true },
    });
    const stream = makeStream();
    navigator.mediaDevices.getUserMedia.mockResolvedValue(stream);

    render(<VinScanner onDetected={() => {}} onCancel={() => {}} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(screen.getByText(/no frames are available/i)).toBeInTheDocument();
  });

  it('falls back to an available camera when rear-camera constraints fail', async () => {
    const stream = makeStream();
    const constrainedError = Object.assign(new Error('constraint'), { name: 'OverconstrainedError' });
    navigator.mediaDevices.getUserMedia
      .mockRejectedValueOnce(constrainedError)
      .mockResolvedValueOnce(stream);

    render(<VinScanner onDetected={() => {}} onCancel={() => {}} />);
    await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2));

    expect(navigator.mediaDevices.getUserMedia.mock.calls[1][0].video.facingMode).toBeUndefined();
  });

  it('stops the camera stream when the scanner closes', async () => {
    const stream = makeStream();
    navigator.mediaDevices.getUserMedia.mockResolvedValue(stream);
    const { unmount } = render(<VinScanner onDetected={() => {}} onCancel={() => {}} />);
    await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1));

    unmount();

    expect(stream.track.stop).toHaveBeenCalled();
  });

  it('does not request another camera after closing during camera startup', async () => {
    let rejectCamera;
    navigator.mediaDevices.getUserMedia.mockImplementation(
      () => new Promise((_, reject) => { rejectCamera = reject; })
    );
    const { unmount } = render(<VinScanner onDetected={() => {}} onCancel={() => {}} />);
    await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1));

    unmount();
    await act(async () => {
      rejectCamera(Object.assign(new Error('constraint'), { name: 'OverconstrainedError' }));
      await Promise.resolve();
    });

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
  });
});
