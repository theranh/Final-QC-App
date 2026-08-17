#!/usr/bin/env node
/**
 * Generates minimal but structurally realistic JPEG/EXIF fixtures for unit tests.
 *
 * Each fixture has a genuine multi-entry IFD0 (Make, Model, Orientation,
 * XResolution, YResolution, ResolutionUnit) matching the layout that real
 * iPhone (little-endian) and Android (big-endian) devices produce.
 *
 * Run once: node server/__fixtures__/generate-fixtures.js
 */
const fs = require("fs");
const path = require("path");

/**
 * Build a JPEG buffer with a realistic multi-entry APP1/EXIF segment.
 *
 * @param {object} opts
 * @param {boolean} opts.littleEndian   true = 'II' (iPhone), false = 'MM' (Android)
 * @param {number}  opts.orientation    EXIF orientation value (1–8)
 * @param {string}  opts.make           Camera make string (null-terminated)
 * @param {string}  opts.model          Camera model string (null-terminated)
 */
function buildJpeg({ littleEndian, orientation, make, model }) {
  const le = littleEndian;

  function u16(v) {
    const b = Buffer.alloc(2);
    if (le) b.writeUInt16LE(v, 0); else b.writeUInt16BE(v, 0);
    return b;
  }
  function u32(v) {
    const b = Buffer.alloc(4);
    if (le) b.writeUInt32LE(v, 0); else b.writeUInt32BE(v, 0);
    return b;
  }
  function u16BE(v) { const b = Buffer.alloc(2); b.writeUInt16BE(v, 0); return b; }

  // ----- data area (values too big for 4-byte inline field) -----
  const makeStr = Buffer.from(make + "\0", "latin1");        // ASCII + NUL
  const modelStr = Buffer.from(model + "\0", "latin1");
  // XResolution and YResolution: RATIONAL = two 32-bit ints (numerator, denominator)
  const xRes = Buffer.concat([u32(72), u32(1)]);             // 72/1
  const yRes = Buffer.concat([u32(72), u32(1)]);

  // ----- IFD0 entries (must be in ascending tag order per EXIF spec) -----
  // Each entry: tag(2) + type(2) + count(4) + value/offset(4) = 12 bytes
  // TIFF header is 8 bytes; IFD0 starts at offset 8.
  // 6 entries × 12 bytes = 72 bytes; plus 2-byte count + 4-byte next-IFD = 78 bytes total.
  // Data area starts at TIFF offset 8 + 78 = 86.

  const IFD0_OFFSET = 8;   // from TIFF header start
  const ENTRY_COUNT = 6;
  const DATA_START = IFD0_OFFSET + 2 + ENTRY_COUNT * 12 + 4; // = 86

  let dataOffset = DATA_START;
  function reserveData(buf) {
    const off = dataOffset;
    dataOffset += buf.length;
    return { off, buf };
  }

  const makeData  = reserveData(makeStr);
  const modelData = reserveData(modelStr);
  const xResData  = reserveData(xRes);
  const yResData  = reserveData(yRes);

  // ASCII type = 2, SHORT type = 3, RATIONAL type = 5

  // For an inline value (fits in 4 bytes), the TIFF spec requires it to be
  // left-justified within the 4-byte field.  For a SHORT (2 bytes):
  //   LE: [lo, hi, 0, 0]  — readUInt16LE(0) == value  ✓
  //   BE: [hi, lo, 0, 0]  — readUInt16BE(0) == value  ✓
  // Using u32(v) in BE produces [0, 0, hi, lo] which readUInt16BE reads as 0.
  function inlineShort(v) {
    const b = Buffer.alloc(4, 0);
    if (le) b.writeUInt16LE(v, 0); else b.writeUInt16BE(v, 0);
    return b;
  }

  function entryOffset(tag, type, count, offset) {
    return Buffer.concat([u16(tag), u16(type), u32(count), u32(offset)]);
  }
  function entryShort(tag, v) {
    return Buffer.concat([u16(tag), u16(3), u32(1), inlineShort(v)]);
  }

  const entries = Buffer.concat([
    entryOffset(0x010F, 2, makeData.buf.length, makeData.off),  // Make (ASCII)
    entryOffset(0x0110, 2, modelData.buf.length, modelData.off),// Model (ASCII)
    entryShort(0x0112, orientation),                             // Orientation (SHORT, inline)
    entryOffset(0x011A, 5, 1, xResData.off),                    // XResolution (RATIONAL)
    entryOffset(0x011B, 5, 1, yResData.off),                    // YResolution (RATIONAL)
    entryShort(0x0128, 2),                                       // ResolutionUnit: inches (inline)
  ]);

  // IFD0 block
  const ifd0 = Buffer.concat([
    u16(ENTRY_COUNT),
    entries,
    u32(0),  // next IFD = none
  ]);

  // Data blobs
  const dataBlobs = Buffer.concat([
    makeData.buf, modelData.buf, xResData.buf, yResData.buf,
  ]);

  // TIFF header
  const byteOrder = le ? Buffer.from([0x49, 0x49]) : Buffer.from([0x4d, 0x4d]);
  const magic = le
    ? Buffer.from([0x2a, 0x00])   // 42 LE
    : Buffer.from([0x00, 0x2a]);  // 42 BE
  const ifd0OffsetBuf = u32(IFD0_OFFSET);
  const tiffHeader = Buffer.concat([byteOrder, magic, ifd0OffsetBuf]);

  // Full EXIF payload: "Exif\0\0" + TIFF
  const tiff = Buffer.concat([tiffHeader, ifd0, dataBlobs]);
  const exifPayload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);

  // APP1 segment length (big-endian per JPEG spec) = 2 (length field) + payload
  const app1Len = u16BE(2 + exifPayload.length);

  // Final JPEG: SOI + APP1 + EOI
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),        // SOI
    Buffer.from([0xff, 0xe1]),        // APP1 marker
    app1Len,
    exifPayload,
    Buffer.from([0xff, 0xd9]),        // EOI
  ]);
}

const OUT = path.join(__dirname);

// iPhone portrait: LE, orientation=6 (90° CW)
fs.writeFileSync(
  path.join(OUT, "iphone_portrait_o6.jpg"),
  buildJpeg({ littleEndian: true, orientation: 6, make: "Apple", model: "iPhone 14 Pro" }),
);

// iPhone upright: LE, orientation=1
fs.writeFileSync(
  path.join(OUT, "iphone_upright_o1.jpg"),
  buildJpeg({ littleEndian: true, orientation: 1, make: "Apple", model: "iPhone 14 Pro" }),
);

// Android portrait rotated: BE (Motorola), orientation=6
fs.writeFileSync(
  path.join(OUT, "android_portrait_o6_be.jpg"),
  buildJpeg({ littleEndian: false, orientation: 6, make: "Google", model: "Pixel 7" }),
);

// Android upright: BE, orientation=1
fs.writeFileSync(
  path.join(OUT, "android_upright_o1_be.jpg"),
  buildJpeg({ littleEndian: false, orientation: 1, make: "Google", model: "Pixel 7" }),
);

// Android 90° CCW: BE, orientation=8
fs.writeFileSync(
  path.join(OUT, "android_sideways_o8_be.jpg"),
  buildJpeg({ littleEndian: false, orientation: 8, make: "Samsung", model: "Galaxy S23" }),
);

console.log("Fixtures written to", OUT);
for (const f of fs.readdirSync(OUT).filter(f => f.endsWith(".jpg"))) {
  console.log(" ", f, fs.statSync(path.join(OUT, f)).size, "bytes");
}
