// Photo decode + downscale helpers shared by every capture/upload path.
//
// STORAGE CONTRACT: newly persisted JPEGs contain upright pixels and no EXIF
// orientation instruction. We parse the source orientation, remove EXIF from a
// temporary decode copy so the browser cannot auto-rotate it, transform the raw
// pixels ourselves, and re-encode. Future browser/app updates therefore cannot
// reinterpret the saved image differently.

function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const mime = dataUrl.slice(5, dataUrl.indexOf(';'));
  const bytes = atob(dataUrl.slice(comma + 1));
  const buf = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) buf[i] = bytes.charCodeAt(i);
  return new Blob([buf], { type: mime });
}

async function sourceToBlob(src) {
  if (typeof src !== 'string') return src;
  if (src.startsWith('data:')) return dataUrlToBlob(src);
  const response = await fetch(src, { cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) throw new Error('Could not read that image');
  return response.blob();
}

function parseExifOrientation(bytes, tiff) {
  if (tiff + 8 >= bytes.length) return null;
  const le = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
  const be = bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d;
  if (!le && !be) return null;
  const r16 = (at) => (le
    ? bytes[at] | (bytes[at + 1] << 8)
    : (bytes[at] << 8) | bytes[at + 1]);
  const r32 = (at) => (le
    ? (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0
    : ((bytes[at] * 0x1000000) + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3]));
  if (r16(tiff + 2) !== 42) return null;
  const ifd = tiff + r32(tiff + 4);
  if (ifd + 2 >= bytes.length) return null;
  const count = r16(ifd);
  for (let i = 0; i < count; i += 1) {
    const entry = ifd + 2 + i * 12;
    if (entry + 10 >= bytes.length) break;
    if (r16(entry) === 0x0112) {
      const value = r16(entry + 8);
      return value >= 1 && value <= 8 ? value : null;
    }
  }
  return null;
}

function analyzeAndStripJpegExif(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return { orientation: 1, bytes };
  }
  const exifRanges = [];
  let orientation = 1;
  let pos = 2;
  while (pos + 3 < bytes.length && bytes[pos] === 0xff) {
    const marker = bytes[pos + 1];
    if (marker === 0xda) break;
    const length = (bytes[pos + 2] << 8) | bytes[pos + 3];
    if (length < 2 || pos + 2 + length > bytes.length) break;
    if (
      marker === 0xe1
      && pos + 10 < bytes.length
      && String.fromCharCode(...bytes.slice(pos + 4, pos + 10)) === 'Exif\u0000\u0000'
    ) {
      const parsed = parseExifOrientation(bytes, pos + 10);
      if (parsed != null) orientation = parsed;
      exifRanges.push([pos, pos + 2 + length]);
    }
    pos += 2 + length;
  }
  if (!exifRanges.length) return { orientation, bytes };

  const removed = exifRanges.reduce((sum, [start, end]) => sum + end - start, 0);
  const stripped = new Uint8Array(bytes.length - removed);
  let sourceAt = 0;
  let targetAt = 0;
  for (const [start, end] of exifRanges) {
    stripped.set(bytes.slice(sourceAt, start), targetAt);
    targetAt += start - sourceAt;
    sourceAt = end;
  }
  stripped.set(bytes.slice(sourceAt), targetAt);
  return { orientation, bytes: stripped };
}

async function prepareDecodeSource(blob) {
  if (!/image\/jpeg/i.test(blob.type || '')) return { orientation: 1, blob };
  const source = new Uint8Array(await blob.arrayBuffer());
  const analyzed = analyzeAndStripJpegExif(source);
  return {
    orientation: analyzed.orientation,
    blob: analyzed.bytes === source
      ? blob
      : new Blob([analyzed.bytes], { type: 'image/jpeg' }),
  };
}

function decodeWithImage(blob) {
  const url = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve({
        source: image,
        rawWidth: image.naturalWidth || image.width,
        rawHeight: image.naturalHeight || image.height,
        done: () => {},
      });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read that image'));
    };
    image.src = url;
  });
}

// Decode a File/Blob or data URL into raw pixels plus the explicit transform
// still required. The source blob has already had EXIF removed, so browser
// orientation behavior cannot cause a second rotation.
export async function loadOriented(src) {
  const input = await sourceToBlob(src);
  const prepared = await prepareDecodeSource(input);
  let decoded;
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(prepared.blob);
      decoded = {
        source: bitmap,
        rawWidth: bitmap.width,
        rawHeight: bitmap.height,
        done: () => { try { bitmap.close(); } catch { /* noop */ } },
      };
    } catch { /* Fall back to <img> decoding of the same EXIF-free blob. */ }
  }
  if (!decoded) decoded = await decodeWithImage(prepared.blob);
  const swap = prepared.orientation >= 5 && prepared.orientation <= 8;
  return {
    ...decoded,
    width: swap ? decoded.rawHeight : decoded.rawWidth,
    height: swap ? decoded.rawWidth : decoded.rawHeight,
    orientation: prepared.orientation,
  };
}

function drawUpright(ctx, decoded) {
  const { orientation, rawWidth: w, rawHeight: h, source } = decoded;
  switch (orientation) {
    case 2: ctx.transform(-1, 0, 0, 1, w, 0); break;
    case 3: ctx.transform(-1, 0, 0, -1, w, h); break;
    case 4: ctx.transform(1, 0, 0, -1, 0, h); break;
    case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
    case 6: ctx.transform(0, 1, -1, 0, h, 0); break;
    case 7: ctx.transform(0, -1, -1, 0, h, w); break;
    case 8: ctx.transform(0, -1, 1, 0, 0, w); break;
    default: break;
  }
  ctx.drawImage(source, 0, 0, w, h);
}

// Downscale any photo source to an upright, metadata-free JPEG data URL.
// zoom > 1 center-crops in upright coordinates.
export async function orientedJpegDataUrl(src, max, quality, zoom = 1) {
  const decoded = await loadOriented(src);
  try {
    const scale = Math.min(1, max / Math.max(decoded.width, decoded.height));
    const sw = decoded.width / zoom;
    const sh = decoded.height / zoom;
    const sx = (decoded.width - sw) / 2;
    const sy = (decoded.height - sh) / 2;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sw * scale));
    canvas.height = Math.max(1, Math.round(sh * scale));
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.scale(scale, scale);
    ctx.translate(-sx, -sy);
    drawUpright(ctx, decoded);
    ctx.restore();
    return canvas.toDataURL('image/jpeg', quality);
  } finally {
    decoded.done();
  }
}

// Deliberately rotate a stored photo after first canonicalizing any source EXIF.
// This is the repair path for older photos whose pixel direction was already
// wrong. The output is always a metadata-free JPEG, so the same repair renders
// identically in Safari, Chrome, thumbnails, and full-size views.
export async function rotateJpegDataUrl(src, degrees = 90, max = 1600, quality = 0.8) {
  const canonical = await orientedJpegDataUrl(src, max, quality);
  const decoded = await loadOriented(canonical);
  try {
    const normalized = ((Number(degrees) % 360) + 360) % 360;
    if (normalized === 0) return canonical;
    const swap = normalized === 90 || normalized === 270;
    const canvas = document.createElement('canvas');
    canvas.width = swap ? decoded.height : decoded.width;
    canvas.height = swap ? decoded.width : decoded.height;
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(normalized * Math.PI / 180);
    ctx.drawImage(
      decoded.source,
      -decoded.width / 2,
      -decoded.height / 2,
      decoded.width,
      decoded.height,
    );
    ctx.restore();
    return canvas.toDataURL('image/jpeg', quality);
  } finally {
    decoded.done();
  }
}

export function compressImageFile(file) {
  return orientedJpegDataUrl(file, 1000, 0.55);
}