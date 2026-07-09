import { useEffect, useRef, useState } from 'react';
import { extractVin17, fallbackDecodeFrame, vinValid } from '../lib/vin';

export default function VinScanner({ onDetected, onCancel }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const detectorRef = useRef(null);
  const timerRef = useRef(null);
  const scratchRef = useRef(null);
  const busyRef = useRef(false);
  const doneRef = useRef(false);
  const [status, setStatus] = useState('Starting camera…');

  useEffect(() => {
    scratchRef.current = document.createElement('canvas');
    let cancelled = false;

    async function begin() {
      if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
        setStatus('No camera on this device — type the VIN manually');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } } });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        try {
          await video.play();
        } catch {
          // autoplay can reject silently on some browsers; frames still flow
        }
        let detector = null;
        if (window.BarcodeDetector) {
          try {
            detector = new window.BarcodeDetector({ formats: ['code_39', 'code_128'] });
          } catch {
            detector = null;
          }
        }
        detectorRef.current = detector;
        setStatus(detector ? 'Scanning… aim at the VIN barcode' : 'Scanning (fallback decoder)… hold steady, fill the frame');
        timerRef.current = setInterval(scanFrame, 350);
      } catch {
        setStatus('Camera unavailable or permission denied — type the VIN manually');
      }
    }

    async function scanFrame() {
      if (busyRef.current || doneRef.current) return;
      busyRef.current = true;
      try {
        const v = videoRef.current;
        if (!v || v.readyState < 2) {
          busyRef.current = false;
          return;
        }
        let text = null;
        if (detectorRef.current) {
          try {
            const codes = await detectorRef.current.detect(v);
            if (codes && codes.length) text = codes[0].rawValue;
          } catch {
            // detector hiccup — fall through to fallback decode this pass
          }
        }
        if (!text) text = fallbackDecodeFrame(v, scratchRef.current);
        if (text) handleText(text);
      } catch {
        // ignore transient frame errors
      }
      busyRef.current = false;
    }

    function handleText(text) {
      const vin = extractVin17(text);
      if (!vin || doneRef.current) return;
      doneRef.current = true;
      onDetected(vin, vinValid(vin));
    }

    begin();
    return () => {
      cancelled = true;
      if (timerRef.current) clearInterval(timerRef.current);
      if (streamRef.current) {
        try {
          streamRef.current.getTracks().forEach((t) => t.stop());
        } catch {
          // stream may already be stopped
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="scan-overlay">
      <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 9, padding: '14px 16px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="oswald" style={{ fontWeight: 600, fontSize: 15, color: '#fff' }}>Scan VIN barcode</div>
          <div style={{ fontSize: 10, color: '#C9C1B8', marginTop: 1 }}>Door-jamb label · Code 39 / Code 128</div>
        </div>
        <div
          onClick={onCancel}
          style={{ width: 44, height: 44, borderRadius: 9, border: '1px solid rgba(255,255,255,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, color: '#fff', cursor: 'pointer', flex: '0 0 auto' }}
        >
          ✕
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
        <video ref={videoRef} autoPlay playsInline muted style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
        <div style={{ position: 'absolute', left: '8%', right: '8%', top: '36%', bottom: '36%', border: '2px solid rgba(255,255,255,0.85)', borderRadius: 10, boxShadow: '0 0 0 2000px rgba(25,22,20,0.45)' }} />
        <div style={{ position: 'absolute', left: '10%', right: '10%', top: '50%', height: 2, background: 'var(--red)' }} />
      </div>
      <div style={{ flex: '0 0 auto', padding: '14px 16px 18px' }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: '#fff', textAlign: 'center' }}>{status}</div>
        <div
          onClick={onCancel}
          style={{ marginTop: 11, height: 48, borderRadius: 11, background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.25)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
        >
          Cancel — type VIN manually
        </div>
      </div>
    </div>
  );
}
