// Photo decode + downscale helpers shared by every capture/upload path.
//
// ORIENTATION RULE: every photo must be decoded through loadOriented() so the
// camera's EXIF orientation tag is applied BEFORE the pixels hit a canvas.
// Decoding with plain `new Image()` + drawImage leaves some browsers (and all
// re-encoded data URLs) showing portrait shots sideways. createImageBitmap
// with imageOrientation:'from-image' bakes the rotation into the pixels; the
// <img> fallback covers older browsers, which also auto-apply EXIF on draw.

// Decode a File/Blob or data-URL string into a drawable whose pixels are
// already upright. Returns { source, width, height, done() } — call done()
// after drawing to free bitmap memory (important on iPhone).
export async function loadOriented(src) {
  const blob = typeof src === 'string' ? await (await fetch(src)).blob() : src;
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      return { source: bmp, width: bmp.width, height: bmp.height, done: () => { try { bmp.close(); } catch { /* noop */ } } };
    } catch { /* options unsupported or decode failed — fall through */ }
  }
  const url = URL.createObjectURL(blob);
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => { URL.revokeObjectURL(url); resolve(i); };
    i.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image')); };
    i.src = url;
  });
  return { source: img, width: img.width, height: img.height, done: () => {} };
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
