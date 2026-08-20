// Keep the barcode engine in the application bundle. It was briefly loaded as
// a separate lazy chunk, but an updated PWA shell could retain a stale chunk
// URL and silently leave VIN scanning with only its weak legacy fallback.
// Scanning is field-critical, so availability wins over the modest bundle cost.
import { zxingDecodeImageData as decode } from './zxingDecodeImpl';

// Retained for call-site compatibility. The decoder is already present, so
// scanner-capable screens no longer depend on a late network request.
export function prefetchZxing() {
  return Promise.resolve();
}

export function zxingDecodeImageData(imageData, tryRotated = false) {
  return decode(imageData, tryRotated);
}
