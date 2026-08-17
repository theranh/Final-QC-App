/**
 * Read the EXIF Orientation tag from a raw JPEG buffer.
 * Returns 1–8 per the EXIF spec, or null if absent/unreadable.
 *   1 = upright (normal)
 *   3 = 180°
 *   6 = 90° CW  (most common iPhone portrait shot stored sideways)
 *   8 = 90° CCW (phone portrait stored sideways the other way)
 */
export function readJpegExifOrientation(buf: Buffer): number | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let pos = 2;
  while (pos < buf.length - 3) {
    if (buf[pos] !== 0xff) break;
    const marker = buf[pos + 1];
    if (pos + 3 >= buf.length) break;
    const segLen = buf.readUInt16BE(pos + 2); // includes 2-byte length field
    if (marker === 0xe1 && pos + 10 < buf.length) { // APP1
      if (buf.slice(pos + 4, pos + 10).toString("latin1") === "Exif\0\0") {
        const t = pos + 10; // TIFF header start
        const le = buf[t] === 0x49; // 'II' = little-endian; 'MM' = big-endian
        const r16 = (o: number) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
        const r32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
        if (t + 8 >= buf.length) break;
        const ifd0 = t + r32(t + 4);
        if (ifd0 + 2 >= buf.length) break;
        const count = r16(ifd0);
        for (let i = 0; i < count; i++) {
          const e = ifd0 + 2 + i * 12;
          if (e + 10 >= buf.length) break;
          if (r16(e) === 0x0112) return r16(e + 8); // Orientation tag
        }
      }
    } else if (marker === 0xda) {
      break; // Start of Scan — no more metadata segments
    }
    pos += 2 + segLen;
  }
  return null;
}
