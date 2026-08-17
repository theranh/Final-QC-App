// Component tests for the VIN → vehicle auto-fill guard.
//
// The guard lives in src/hooks/useVinAutofill.js and is called from App.jsx.
// Tests import the real hook so any regression in that production file is caught.
//
// Three behaviours verified:
//   1. Auto-fill on valid VIN when vehicle field is empty.
//   2. No overwrite when the inspector already has text in the vehicle field
//      (both before and while the decode is in flight).
//   3. Field stays blank with no error when decode returns null (offline).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useState } from 'react';

const VALID_VIN = '1HGCM82633A004352'; // passes ISO 3779 check digit
const DECODED_DESC = '2003 Honda Accord EX';

// ---- mocks ----------------------------------------------------------------
// Keep real vinValid; stub only the network call so tests stay offline.
vi.mock('../lib/vin', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, decodeVinInfo: vi.fn() };
});

import { useVinAutofill } from '../hooks/useVinAutofill';
import { decodeVinInfo } from '../lib/vin';

afterEach(cleanup);

// ---- helpers --------------------------------------------------------------

// renderHook wrapper: combines useState + useVinAutofill exactly as App.jsx
// does, exposing draft state so assertions can read vehicle.
function useHarness(initialVin = '', initialVehicle = '') {
  const [draft, setDraft] = useState({ vin: initialVin, vehicle: initialVehicle });
  const showToast = vi.fn();
  const draftVin = (draft.vin || '').toUpperCase();
  useVinAutofill(draftVin, setDraft, showToast);
  return { draft, setDraft };
}

// ---- tests ----------------------------------------------------------------

describe('useVinAutofill (NewInspectionForm auto-fill guard)', () => {
  beforeEach(() => {
    vi.mocked(decodeVinInfo).mockReset();
  });

  it('auto-fills the vehicle field when decode resolves with a description', async () => {
    vi.mocked(decodeVinInfo).mockResolvedValue(DECODED_DESC);

    const { result } = renderHook(() => useHarness(VALID_VIN, ''));

    // Field starts empty.
    expect(result.current.draft.vehicle).toBe('');

    // After the async decode settles, vehicle should be filled.
    await act(async () => {});
    expect(result.current.draft.vehicle).toBe(DECODED_DESC);
    expect(decodeVinInfo).toHaveBeenCalledWith(VALID_VIN);
  });

  it('does NOT overwrite text the inspector typed before the decode resolves', async () => {
    vi.mocked(decodeVinInfo).mockResolvedValue(DECODED_DESC);

    const { result } = renderHook(() => useHarness(VALID_VIN, 'Typed By Inspector'));

    await act(async () => {});
    // Inspector's text must survive even after decode settles.
    expect(result.current.draft.vehicle).toBe('Typed By Inspector');
  });

  it('does NOT overwrite text typed while the decode is in flight', async () => {
    let resolveDecodeVin;
    vi.mocked(decodeVinInfo).mockReturnValue(
      new Promise((resolve) => { resolveDecodeVin = resolve; })
    );

    const { result } = renderHook(() => useHarness(VALID_VIN, ''));

    // Inspector types while the network call is pending.
    act(() => {
      result.current.setDraft((prev) => ({ ...prev, vehicle: 'Typed In Flight' }));
    });
    expect(result.current.draft.vehicle).toBe('Typed In Flight');

    // Decode now settles — the in-flight text must not be stomped.
    await act(async () => { resolveDecodeVin(DECODED_DESC); });
    expect(result.current.draft.vehicle).toBe('Typed In Flight');
  });

  it('leaves vehicle blank and throws no error when decode returns null (offline)', async () => {
    vi.mocked(decodeVinInfo).mockResolvedValue(null);

    const { result } = renderHook(() => useHarness(VALID_VIN, ''));

    await act(async () => {});
    expect(decodeVinInfo).toHaveBeenCalled();
    expect(result.current.draft.vehicle).toBe('');
  });
});
