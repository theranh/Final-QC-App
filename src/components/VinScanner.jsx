import { useEffect, useRef, useState } from 'react';
import { extractVin17, fallbackDecodeFrame, vinValid } from '../lib/vin';
import { prefetchZxing, zxingDecodeImageData } from '../lib/zxingDecode';
import { parseStockLabel } from '../lib/fieldCapabilities';

const NATIVE_FORMATS = ['code_39', 'code_128', 'qr_code', 'data_matrix', 'pdf417'];

// mode='vin'   (default) — existing VIN scanning; onDetected(vin, valid) unchanged.
// mode='stock' — accepts any barcode/QR text as a stock-label shortcut.
//                Applies parseStockLabel to filter junk; if the parsed result
//                looks like a VIN (17 alphanum chars) it is still treated as a
//                stock label so the caller can decide.  onDetected(code, true)
//                where code is the cleaned stock label string.
export default function VinScanner({ onDetected, onCancel, mode = 'vin' }) {
  const isStock = mode === 'stock';

  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const detectorRef = useRef(null);
  const timerRef = useRef(null);
  const scratchRef = useRef(null);
  const busyRef = useRef(false);
  const doneRef = useRef(false);
  const passRef = useRef(0);
  const frameFailuresRef = useRef(0);
  const unreadyFramesRef = useRef(0);
  const [status, setStatus] = useState('Starting camera…');
  const [torchOn, setTorchOn] = useState(false);
  const [torchAvailable, setTorchAvailable] = useState(false);

  const toggleTorch = () => {
    const track = streamRef.current && streamRef.current.getVideoTracks()[0];
    if (!track) return;
    const next = !torchOn;
    track
      .applyConstraints({ advanced: [{ torch: next }] })
      .then(() => setTorchOn(next))
      .catch(() => {});
  };

  useEffect(() => {
    scratchRef.current = document.createElement('canvas');
    prefetchZxing(); // safety net — screens prefetch earlier, this covers direct mounts
    let cancelled = false;

    async function begin() {
      if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
        setStatus(
          isStock
            ? 'No camera on this device — type the stock number manually'
            : 'No camera on this device — type the VIN manually'
        );
        return;
      }
      try {
        let stream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: { ideal: 'environment' },
              width: { ideal: 1920 },
              height: { ideal: 1080 },
            },
            audio: false,
          });
        } catch (cameraError) {
          // Some older browsers reject the rear-camera constraint even though
          // they have a usable camera. Never retry a denied permission.
          if (cancelled) return;
          if (cameraError?.name === 'NotAllowedError' || cameraError?.name === 'SecurityError') throw cameraError;
          stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1920 }, height: { ideal: 1080 } },
            audio: false,
          });
        }
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) {
          stream.getTracks().forEach((t) => t.stop());
          streamRef.current = null;
          return;
        }
        video.srcObject = stream;
        try {
          await video.play();
        } catch {
          // autoplay can reject silently on some browsers; frames still flow
        }
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          streamRef.current = null;
          return;
        }

        // Torch (flashlight) support — big help on dark door jambs.
        const track = stream.getVideoTracks()[0];
        try {
          const caps = track.getCapabilities ? track.getCapabilities() : {};
          if (caps.torch) setTorchAvailable(true);
          // Ask for continuous autofocus where supported.
          if (caps.focusMode && caps.focusMode.includes('continuous')) {
            track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
          }
        } catch {
          // capabilities probing is best-effort
        }

        // Start the ZXing loop immediately. Native BarcodeDetector capability
        // discovery is optional and has hung on some mobile browsers; it must
        // never prevent the software decoder from reading a VIN.
        void configureNativeDetector();
        setStatus('Scanning… line the code up in the frame');
        timerRef.current = setInterval(scanFrame, 250);
      } catch {
        if (!cancelled) {
          setStatus(
            isStock
              ? 'Camera unavailable or permission denied — type the stock number manually'
              : 'Camera unavailable or permission denied — type the VIN manually'
          );
        }
      }
    }

    async function configureNativeDetector() {
      if (!window.BarcodeDetector) return;
      try {
        let formats = NATIVE_FORMATS;
        if (window.BarcodeDetector.getSupportedFormats) {
          const supported = await Promise.race([
            window.BarcodeDetector.getSupportedFormats(),
            new Promise((resolve) => setTimeout(() => resolve(null), 750)),
          ]);
          if (Array.isArray(supported)) formats = NATIVE_FORMATS.filter((f) => supported.includes(f));
        }
        if (!cancelled && formats.length) detectorRef.current = new window.BarcodeDetector({ formats });
      } catch {
        // ZXing remains active when native detector creation is unavailable.
        detectorRef.current = null;
      }
    }

    // Grab a region of the video into ImageData, capped at maxW pixels wide.
    function grabRegion(v, sx, sy, sw, sh, maxW) {
      const c = scratchRef.current;
      const scale = Math.min(1, maxW / sw);
      const W = Math.max(1, Math.round(sw * scale));
      const H = Math.max(1, Math.round(sh * scale));
      c.width = W;
      c.height = H;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(v, sx, sy, sw, sh, 0, 0, W, H);
      return ctx.getImageData(0, 0, W, H);
    }

    function detectNative(detector, video) {
      return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          settled = true;
          resolve({ codes: null, timedOut: true });
        }, 120);
        try {
          Promise.resolve(detector.detect(video)).then(
            (codes) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resolve({ codes, timedOut: false });
            },
            () => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resolve({ codes: null, timedOut: false });
            }
          );
        } catch {
          settled = true;
          clearTimeout(timer);
          resolve({ codes: null, timedOut: false });
        }
      });
    }

    async function scanFrame() {
      if (busyRef.current || doneRef.current) return;
      busyRef.current = true;
      try {
        const v = videoRef.current;
        if (!v || v.readyState < 2 || !v.videoWidth) {
          unreadyFramesRef.current += 1;
          if (!cancelled && unreadyFramesRef.current >= 8) {
            setStatus('Camera started, but no frames are available — close and try again');
          }
          return;
        }
        unreadyFramesRef.current = 0;
        let text = null;

        // 1) Native hardware-accelerated detector (fastest, most tolerant).
        if (detectorRef.current) {
          const detector = detectorRef.current;
          const { codes, timedOut } = await detectNative(detector, v);
          if (cancelled || doneRef.current) return;
          // A hanging native detector must not hold busyRef forever. Disable it
          // for this scanner session and let the bundled ZXing reader take over.
          if (timedOut && detectorRef.current === detector) detectorRef.current = null;
          if (codes && codes.length) text = codes[0].rawValue;
        }

        // 2) ZXing multi-format decode. Alternate between the center band
        //    (higher effective resolution where the user is aiming) and the
        //    full frame with a rotation retry for vertical barcodes.
        if (!text) {
          const W = v.videoWidth;
          const H = v.videoHeight;
          const pass = passRef.current++;
          if (pass % 2 === 0) {
            const img = grabRegion(v, W * 0.03, H * 0.28, W * 0.94, H * 0.44, 1280);
            text = zxingDecodeImageData(img, false);
          } else {
            const img = grabRegion(v, 0, 0, W, H, 1024);
            text = zxingDecodeImageData(img, true);
          }
        }

        // 3) Last-resort legacy Code 39 line scan.
        if (!text) text = fallbackDecodeFrame(v, scratchRef.current);

        if (text) handleText(text);
      } catch {
        frameFailuresRef.current += 1;
        if (!cancelled && frameFailuresRef.current >= 4) {
          setStatus('Camera is on, but frames cannot be read — close and try again');
        }
      } finally {
        busyRef.current = false;
      }
    }

    function handleText(text) {
      if (doneRef.current) return;

      if (isStock) {
        // Stock-label mode: accept any parseable label; reject junk.
        const code = parseStockLabel(text);
        if (!code) return;
        doneRef.current = true;
        onDetected(code, true);
      } else {
        // VIN mode: unchanged behaviour.
        const vin = extractVin17(text);
        if (!vin) return;
        doneRef.current = true;
        onDetected(vin, vinValid(vin));
      }
    }

    begin();
    return () => {
      cancelled = true;
      doneRef.current = true;
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
      if (streamRef.current) {
        try {
          streamRef.current.getTracks().forEach((t) => t.stop());
        } catch {
          // stream may already be stopped
        }
        streamRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // UI labels vary by mode.
  const title = isStock ? 'Scan stock label' : 'Scan VIN barcode';
  const subtitle = isStock
    ? 'Stock tag · barcode or QR code'
    : 'Door-jamb label · barcode or QR / Data Matrix';
  const cancelLabel = isStock ? 'Cancel — type stock manually' : 'Cancel — type VIN manually';

  return (
    <div className="scan-overlay">
      <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 9, padding: '14px 16px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="oswald" style={{ fontWeight: 600, fontSize: 15, color: '#fff' }}>{title}</div>
          <div style={{ fontSize: 10, color: '#C9C1B8', marginTop: 1 }}>{subtitle}</div>
        </div>
        {torchAvailable && (
          <div
            onClick={toggleTorch}
            style={{
              width: 44, height: 44, borderRadius: 9,
              border: torchOn ? '1px solid #FFD766' : '1px solid rgba(255,255,255,0.3)',
              background: torchOn ? 'rgba(255,215,102,0.18)' : 'transparent',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 17, cursor: 'pointer', flex: '0 0 auto',
            }}
            title={torchOn ? 'Turn flashlight off' : 'Turn flashlight on'}
          >
            {torchOn ? '🔦' : '💡'}
          </div>
        )}
        <div
          onClick={onCancel}
          style={{ width: 44, height: 44, borderRadius: 9, border: '1px solid rgba(255,255,255,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, color: '#fff', cursor: 'pointer', flex: '0 0 auto' }}
        >
          ✕
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
        <video ref={videoRef} autoPlay playsInline muted style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
        <div style={{ position: 'absolute', left: '8%', right: '8%', top: '32%', bottom: '32%', border: '2px solid rgba(255,255,255,0.85)', borderRadius: 10, boxShadow: '0 0 0 2000px rgba(25,22,20,0.45)' }} />
        <div style={{ position: 'absolute', left: '10%', right: '10%', top: '50%', height: 2, background: 'var(--red)' }} />
      </div>
      <div style={{ flex: '0 0 auto', padding: '14px 16px 18px' }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: '#fff', textAlign: 'center' }}>{status}</div>
        <div style={{ fontSize: 9.5, color: '#C9C1B8', textAlign: 'center', marginTop: 4 }}>
          Fill the frame with the code · move slowly closer / farther if it won't read
        </div>
        <div
          onClick={onCancel}
          style={{ marginTop: 11, height: 48, borderRadius: 11, background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.25)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
        >
          {cancelLabel}
        </div>
      </div>
    </div>
  );
}
