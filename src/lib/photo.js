// Photo decode + downscale helpers shared by every capture/upload path.
//
// ORIENTATION RULE: every photo must be decoded through loadOriented() so the
// camera's EXIF orientation tag is applied BEFORE the pixels hit a canvas.
// Decoding with plain `new Image()` + drawImage leaves some browsers (and all
// re-encoded data URLs) showing portrait shots sideways. createImageBitmap
// with imageOrientation:'from-image' bakes the rotation into the pixels; the
// <img> fallback covers older browsers, which also auto-apply EXIF on draw.

// Convert a data-URL to a Blob without going through fetch().
// fetch(data:...) can silently fail in iOS Safari PWA and private-browsing
// contexts; this synchronous path always works.
function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const mime = dataUrl.slice(5, dataUrl.indexOf(';'));
  const bytes = atob(dataUrl.slice(comma + 1));
  const buf = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
  return new Blob([buf], { type: mime });
}

// Probe whether createImageBitmap actually applies the imageOrientation option.
// Some early iOS Safari 15.x builds accept the call but silently return
// un-rotated pixels. We detect this once per page load by inserting an EXIF
// orientation-6 tag into a 2×1 JPEG and checking whether the bitmap comes
// back as 1×2 (option honored) or 2×1 (option silently ignored).
//
// Result: null = not yet tested, true = honored, false = ignored/unavailable.
let _orientationProbeResult = null;

async function probeOrientationSupport() {
  if (_orientationProbeResult !== null) return _orientationProbeResult;
  if (typeof createImageBitmap !== 'function') {
    _orientationProbeResult = false;
    return false;
  }
  try {
    // Build a 2×1 white JPEG via canvas and splice in an EXIF APP1 segment
    // that declares orientation 6 (rotate 90° CW → corrected dims become 1×2).
    const cv = document.createElement('canvas');
    cv.width = 2; cv.height = 1;
    cv.getContext('2d').fillRect(0, 0, 2, 1);
    const base = await new Promise((res) => cv.toBlob(res, 'image/jpeg', 1));
    const raw = new Uint8Array(await base.arrayBuffer());

    // EXIF APP1: orientation = 6 (rotate 90° CW)
    const exif = new Uint8Array([
      0xFF, 0xE1, 0x00, 0x22,                                   // APP1, length=34
      0x45, 0x78, 0x69, 0x66, 0x00, 0x00,                       // "Exif\0\0"
      0x4D, 0x4D, 0x00, 0x2A, 0x00, 0x00, 0x00, 0x08,           // TIFF big-endian, IFD at 8
      0x00, 0x01,                                                 // IFD: 1 entry
      0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01,           // tag=Orientation, SHORT, count=1
      0x00, 0x06, 0x00, 0x00,                                     // value=6
      0x00, 0x00, 0x00, 0x00,                                     // next IFD=0
    ]);

    // Replace any JFIF APP0 segment (FF E0) with the EXIF APP1: JPEG decoders
    // are happy with EXIF-only; keeping both markers is harmless but wasteful.
    let rest = 2; // skip SOI (FF D8)
    if (raw[2] === 0xFF && raw[3] === 0xE0) rest = 2 + 2 + ((raw[4] << 8) | raw[5]);
    const jpeg = new Uint8Array(2 + exif.length + (raw.length - rest));
    jpeg[0] = 0xFF; jpeg[1] = 0xD8;
    jpeg.set(exif, 2);
    jpeg.set(raw.subarray(rest), 2 + exif.length);

    const bmp = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }), { imageOrientation: 'from-image' });
    // Orientation 6 on a 2×1 raw JPEG → corrected bitmap must be 1 wide × 2 tall.
    _orientationProbeResult = bmp.width < bmp.height;
    try { bmp.close(); } catch { /* noop */ }
  } catch {
    // createImageBitmap threw or canvas is unavailable — fall back to <img>.
    _orientationProbeResult = false;
  }
  return _orientationProbeResult;
}

// For tests: reset the cached probe result so each test starts fresh.
export function _resetOrientationProbe() { _orientationProbeResult = null; }

// Decode a File/Blob or data-URL string into a drawable whose pixels are
// already upright. Returns { source, width, height, done() } — call done()
// after drawing to free bitmap memory (important on iPhone).
export async function loadOriented(src) {
  const blob = typeof src === 'string' ? dataUrlToBlob(src) : src;
  if (await probeOrientationSupport()) {
    try {
      const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      return { source: bmp, width: bmp.width, height: bmp.height, done: () => { try { bmp.close(); } catch { /* noop */ } } };
    } catch { /* decode failed — fall through to <img> */ }
  }
  // <img> fallback: modern iOS/Android Safari applies EXIF orientation when
  // drawing to canvas (CSS image-orientation: from-image default).
  // naturalWidth/naturalHeight give intrinsic pixel dimensions regardless of
  // DOM placement or CSS sizing, and reflect EXIF-corrected dims on modern iOS.
  const url = URL.createObjectURL(blob);
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => { URL.revokeObjectURL(url); resolve(i); };
    i.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image')); };
    i.src = url;
  });
  return { source: img, width: img.naturalWidth, height: img.naturalHeight, done: () => {} };
}

// Downscale any photo source to an upright JPEG data URL.
// zoom > 1 center-crops before scaling (used by the camera's digital zoom).
export async function orientedJpegDataUrl(src, max, quality, zoom = 1) {
  const d = await loadOriented(src);
  try {
    const scale = Math.min(1, max / Math.max(d.width, d.height));
    const sw = d.width / zoom; const sh = d.height / zoom;
    const sx = (d.width - sw) / 2; const sy = (d.height - sh) / 2;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(sw * scale));
    c.height = Math.max(1, Math.round(sh * scale));
    c.getContext('2d').drawImage(d.source, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', quality);
  } finally {
    d.done();
  }
}

// Downscale + JPEG-compress a captured photo so localStorage can hold many of them as data URLs.
export function compressImageFile(file) {
  return orientedJpegDataUrl(file, 1000, 0.55);
}
