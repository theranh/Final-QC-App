import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export default function Lightbox({ src, alt = 'Enlarged photo', onClose, children }) {
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const returnFocusRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!src) return undefined;
    returnFocusRef.current = document.activeElement;
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
      } else if (event.key === 'Tab') {
        const focusable = [...dialogRef.current.querySelectorAll('button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])')];
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = priorOverflow;
      const target = returnFocusRef.current;
      if (target?.isConnected) target.focus?.();
    };
  }, [src]);

  if (!src) return null;
  return createPortal(
    <div className="lightbox-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={dialogRef} className="lightbox-dialog" role="dialog" aria-modal="true" aria-label="Photo viewer" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
        <button ref={closeRef} type="button" className="lightbox-close" aria-label="Close photo viewer" onClick={onClose}>✕</button>
        <img className="lightbox-img" src={src} alt={alt} />
        {children && <div className="lightbox-actions">{children}</div>}
      </div>
    </div>,
    document.body,
  );
}
