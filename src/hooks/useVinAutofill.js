import { useRef, useEffect } from 'react';
import { vinValid, decodeVinInfo } from '../lib/vin';

/**
 * Auto-fills the vehicle field from the NHTSA vPIC decoder whenever a valid
 * 17-character VIN is present — but NEVER overwrites text the inspector typed
 * themselves.
 *
 * @param {string}   draftVin   - Current VIN from draft state (already upper-cased).
 * @param {Function} setDraft   - React state setter for the draft object.
 * @param {Function} showToast  - Called with a success message when auto-fill fires.
 */
export function useVinAutofill(draftVin, setDraft, showToast) {
  // Tracks the last VIN we decoded and the value we wrote, so we can tell
  // apart "our own auto-fill" from "text the inspector typed".
  const autoVehicleRef = useRef({ vin: null, value: null });

  useEffect(() => {
    if (draftVin.length !== 17 || !vinValid(draftVin)) return;
    if (autoVehicleRef.current.vin === draftVin) return;
    let cancelled = false;
    decodeVinInfo(draftVin).then((desc) => {
      if (cancelled || !desc) return;
      const prevAuto = autoVehicleRef.current.value;
      autoVehicleRef.current = { vin: draftVin, value: desc };
      setDraft((prev) => {
        const cur = (prev.vehicle || '').trim();
        if (cur && cur !== prevAuto) return prev; // inspector typed their own — leave it
        if (cur === desc) return prev;
        return { ...prev, vehicle: desc };
      });
      showToast('Vehicle filled from VIN ✓');
    });
    return () => {
      cancelled = true;
    };
    // draftVin is the only reactive input; setDraft/showToast are stable refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftVin]);
}
