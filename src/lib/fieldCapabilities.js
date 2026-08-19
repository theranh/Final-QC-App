// Passive capability / readiness detection for the field-assist layer.
//
// IMPORTANT: These checks are deliberately passive — no permission dialogs,
// no getUserMedia calls.  Everything here is feature-detection only.
//
// External helpers used (must NOT be imported from here; callers import them
// directly to avoid circular deps):
//   probePersistence()  — from photoQueue.js
//   pendingJobs()       — from photoQueue.js

// ---------- camera availability (passive) ----------
// Reports whether the browser API is present.  getUserMedia is NOT called
// here; that is the camera component's job once the user says Continue.
export function cameraApiAvailable() {
  return !!(
    typeof navigator !== 'undefined' &&
    navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function'
  );
}

// ---------- native barcode-detector availability ----------
export function nativeBarcodeAvailable() {
  return typeof window !== 'undefined' && typeof window.BarcodeDetector !== 'undefined';
}

// ---------- speech recognition availability ----------
export function speechRecognitionAvailable() {
  if (typeof window === 'undefined') return false;
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

// ---------- connectivity ----------
export function isOnline() {
  if (typeof navigator === 'undefined') return true; // SSR / test default
  return navigator.onLine !== false;
}

// ---------- navigator.storage persistent-storage status ----------
// Returns 'persistent' | 'best-effort' | 'unknown' (async).
export async function storagePersistenceStatus() {
  try {
    if (
      typeof navigator !== 'undefined' &&
      navigator.storage &&
      typeof navigator.storage.persisted === 'function'
    ) {
      const ok = await navigator.storage.persisted();
      return ok ? 'persistent' : 'best-effort';
    }
  } catch {
    // ignore
  }
  return 'unknown';
}

// ---------- IndexedDB queue health ----------
// Uses probePersistence (from photoQueue) to test whether IndexedDB is writable.
// Callers pass probePersistence as an argument to keep this module free of
// circular imports with photoQueue.
export async function checkQueuePersistence(probePersistenceFn) {
  try {
    const ok = await probePersistenceFn();
    return ok === true;
  } catch {
    return false;
  }
}

// ---------- pending upload count ----------
// Returns the number of jobs currently in the durable queue.
// Callers pass pendingJobsFn to avoid a circular dep.
export async function getQueuedUploadCount(pendingJobsFn) {
  try {
    const jobs = await pendingJobsFn();
    return Array.isArray(jobs) ? jobs.length : 0;
  } catch {
    return 0;
  }
}

// ---------- full readiness snapshot (async) ----------
// Returns a plain object with all passive readiness indicators.
// probePersistenceFn and pendingJobsFn should be the real functions from
// photoQueue.js; they are injected to keep this module importable in tests.
export async function getReadiness({ probePersistenceFn, pendingJobsFn } = {}) {
  const [persistenceOk, queuedCount, storageStatus] = await Promise.all([
    probePersistenceFn ? checkQueuePersistence(probePersistenceFn) : Promise.resolve(null),
    pendingJobsFn ? getQueuedUploadCount(pendingJobsFn) : Promise.resolve(0),
    storagePersistenceStatus(),
  ]);

  return {
    cameraSupported: cameraApiAvailable(),
    nativeBarcode: nativeBarcodeAvailable(),
    speechSupported: speechRecognitionAvailable(),
    online: isOnline(),
    persistenceOk,          // null = not checked, true/false from IDB probe
    storagePersistence: storageStatus, // 'persistent' | 'best-effort' | 'unknown'
    queuedUploads: queuedCount,
  };
}

// ---------- stock-label parser ----------
// Recognises common stock-label formats and returns a trimmed upper-case code,
// or null when the input is clearly junk.
//
// Accepted prefixes (case-insensitive, optional separators # : space –):
//   STOCK:ABC123    STOCK # ABC-123    STOCK ABC123
//   STK ABC123      STK:ABC123         STK# ABC123
//   UNIT ABC123     UNIT:ABC123
//   T-0000          (plain code — no prefix)
//
// Rejects: empty, control characters, codes longer than 30 characters.
// Match known prefixes followed by optional separator chars.
// Pattern: prefix word, then optional spaces, then one optional separator char (#, :, -),
// then optional spaces.
const STOCK_PREFIX_RE = /^(?:stock|stk|unit)\b\s*[:#-]?\s*/i;

export function parseStockLabel(raw) {
  if (!raw || typeof raw !== 'string') return null;

  // A scanner payload containing controls is not a stock code. Reject it
  // rather than quietly changing the decoded value.
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code < 32 || code === 127) return null;
  }
  const stripped = raw.trim();
  if (!stripped) return null;

  // Attempt to strip a known prefix.
  let candidate = stripped;
  let explicitlyLabelled = false;
  const prefixMatch = stripped.match(STOCK_PREFIX_RE);
  if (prefixMatch) {
    explicitlyLabelled = true;
    const afterPrefix = stripped.slice(prefixMatch[0].length).trim();
    if (/[A-Za-z0-9]/.test(afterPrefix)) {
      // Valid prefix + alphanumeric remainder → use the remainder as the code.
      candidate = afterPrefix;
    } else {
      // Known prefix but no alphanumeric remainder → junk, reject immediately.
      return null;
    }
  } else if (/\s/.test(stripped)) {
    // A plain supported code is one token. Spaces are accepted only after an
    // explicit STOCK/STK/UNIT prefix; otherwise an arbitrary QR sentence would
    // be mistaken for a stock number.
    return null;
  }

  // Normalise whitespace inside the code to a single hyphen (common on
  // dealer labels that print spaces between groups).
  const normalised = candidate.replace(/\s+/g, '-').toUpperCase();

  // Plain QR payloads can be URLs or arbitrary prose. A supported stock code
  // is deliberately conservative: alphanumeric at both ends, with only the
  // separators dealerships commonly use in between.
  if (!normalised || normalised.length > 30) return null;
  if (!/^[A-Z0-9](?:[A-Z0-9._/-]{0,28}[A-Z0-9])?$/.test(normalised)) return null;
  if (!explicitlyLabelled && !/^(?:\d{2,10}|[A-Z]{1,3}-?\d{1,10}[A-Z]?)$/.test(normalised)) return null;

  return normalised;
}
