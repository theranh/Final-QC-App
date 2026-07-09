// Robust multi-format barcode decoding via ZXing (pure JS — works offline, no wasm).
// Handles the formats found on VIN labels: Code 39, Code 128, QR, Data Matrix, PDF-417.
import {
  MultiFormatReader,
  DecodeHintType,
  BarcodeFormat,
  RGBLuminanceSource,
  BinaryBitmap,
  HybridBinarizer,
} from '@zxing/library';

const hints = new Map();
hints.set(DecodeHintType.POSSIBLE_FORMATS, [
  BarcodeFormat.CODE_39,
  BarcodeFormat.CODE_128,
  BarcodeFormat.QR_CODE,
  BarcodeFormat.DATA_MATRIX,
  BarcodeFormat.PDF_417,
]);
hints.set(DecodeHintType.TRY_HARDER, true);
hints.set(DecodeHintType.ALSO_INVERTED, true);

const reader = new MultiFormatReader();
reader.setHints(hints);

function toLuminance(imageData) {
  const { data, width, height } = imageData;
  const lum = new Uint8ClampedArray(width * height);
  for (let i = 0, j = 0; i < lum.length; i++, j += 4) {
    lum[i] = (data[j] * 299 + data[j + 1] * 587 + data[j + 2] * 114 + 500) / 1000;
  }
  return { lum, width, height };
}

function rotate90(lum, width, height) {
  const out = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      out[x * height + (height - 1 - y)] = lum[y * width + x];
    }
  }
  return { lum: out, width: height, height: width };
}

function decodeLuminance(lum, width, height) {
  try {
    const source = new RGBLuminanceSource(lum, width, height);
    const bitmap = new BinaryBitmap(new HybridBinarizer(source));
    const result = reader.decodeWithState(bitmap);
    return result ? result.getText() : null;
  } catch {
    return null; // NotFoundException — nothing decodable in this frame
  }
}

// Decode barcodes/QR from an ImageData. Tries normal orientation, then 90°
// (for vertically-mounted barcodes) when `tryRotated` is set.
export function zxingDecodeImageData(imageData, tryRotated = false) {
  const { lum, width, height } = toLuminance(imageData);
  let text = decodeLuminance(lum, width, height);
  if (!text && tryRotated) {
    const r = rotate90(lum, width, height);
    text = decodeLuminance(r.lum, r.width, r.height);
  }
  return text;
}
