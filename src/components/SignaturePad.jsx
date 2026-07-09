import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';

const SignaturePad = forwardRef(function SignaturePad({ onSignedChange }, ref) {
  const canvasRef = useRef(null);
  const [signed, setSigned] = useState(false);

  useImperativeHandle(ref, () => ({
    clear() {
      const el = canvasRef.current;
      if (el) el.getContext('2d').clearRect(0, 0, el.width, el.height);
      setSigned(false);
      onSignedChange && onSignedChange(false);
    },
    toDataURL() {
      const el = canvasRef.current;
      return el ? el.toDataURL('image/png') : null;
    },
    isSigned() {
      return signed;
    },
  }));

  useEffect(() => {
    const el = canvasRef.current;
    if (!el || el._wired) return;
    el._wired = true;
    const ctx = el.getContext('2d');
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#3A3532';
    let drawing = false;
    const pos = (e) => {
      const r = el.getBoundingClientRect();
      return [((e.clientX - r.left) * el.width) / r.width, ((e.clientY - r.top) * el.height) / r.height];
    };
    const down = (e) => {
      drawing = true;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // ignore — pointer capture not supported/needed on this device
      }
      const [x, y] = pos(e);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 0.5, y + 0.5);
      ctx.stroke();
      e.preventDefault();
    };
    const move = (e) => {
      if (!drawing) return;
      const [x, y] = pos(e);
      ctx.lineTo(x, y);
      ctx.stroke();
      e.preventDefault();
    };
    const up = () => {
      if (drawing) {
        drawing = false;
        setSigned(true);
        onSignedChange && onSignedChange(true);
      }
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="sig-pad">
      {!signed && <span className="sig-placeholder">Draw signature here</span>}
      <canvas ref={canvasRef} width={760} height={220} />
    </div>
  );
});

export default SignaturePad;
