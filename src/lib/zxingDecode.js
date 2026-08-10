// Thin lazy-loading wrapper around the ZXing decode implementation.
// The heavy @zxing/library code lives in zxingDecodeImpl.js and is
// code-split out of the main bundle via dynamic import. Call
// prefetchZxing() when a screen that can open the scanner mounts so
// the decoder is ready before the first frame arrives.

let impl = null;
let loading = null;

export function prefetchZxing() {
  if (!loading) {
    loading = import('./zxingDecodeImpl').then((m) => {
      impl = m;
      return m;
    });
  }
  return loading;
}

// Decode barcodes/QR from an ImageData. Returns null until the
// implementation chunk has loaded (it also kicks off the load), which
// is harmless: the scanner retries every frame.
export function zxingDecodeImageData(imageData, tryRotated = false) {
  if (!impl) {
    prefetchZxing();
    return null;
  }
  return impl.zxingDecodeImageData(imageData, tryRotated);
}
