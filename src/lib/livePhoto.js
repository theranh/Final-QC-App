// Live MediaStream capture has one browser-specific wrinkle: on some iPhones,
// the <video> compositor presents an upright preview while canvas.drawImage()
// exposes a quarter-turned backing frame. Dimensions and device gravity cannot
// prove that semantic mapping, so iOS calibrates it once per browser/camera/
// screen-orientation profile and reuses the explicit answer.

const STORAGE_KEY = 'finalqc.live-camera-orientation.v1';
const VALID_CORRECTIONS = new Set([-90, 0, 90, 180]);

function normalizedCorrection(value) {
  const number = Number(value);
  return VALID_CORRECTIONS.has(number) ? number : null;
}

export function isAppleMobile(navigatorObject = globalThis.navigator) {
  if (!navigatorObject) return false;
  return /iP(hone|ad|od)/.test(navigatorObject.userAgent || '')
    || (navigatorObject.platform === 'MacIntel' && navigatorObject.maxTouchPoints > 1);
}

function browserEngineProfile(navigatorObject = globalThis.navigator) {
  const ua = navigatorObject?.userAgent || '';
  const browser = ua.match(/CriOS\/(\d+)/)?.[1]
    ? `crios${ua.match(/CriOS\/(\d+)/)[1]}`
    : ua.match(/FxiOS\/(\d+)/)?.[1]
      ? `fxios${ua.match(/FxiOS\/(\d+)/)[1]}`
      : ua.match(/Version\/(\d+)/)?.[1]
        ? `safari${ua.match(/Version\/(\d+)/)[1]}`
        : 'webkit';
  const ios = ua.match(/OS (\d+)[._]/)?.[1] || 'unknown';
  return `${browser}-ios${ios}`;
}

export function currentScreenAngle(windowObject = globalThis.window) {
  const screenAngle = Number(windowObject?.screen?.orientation?.angle);
  if (Number.isFinite(screenAngle)) return ((screenAngle % 360) + 360) % 360;
  const legacyAngle = Number(windowObject?.orientation);
  if (Number.isFinite(legacyAngle)) return ((legacyAngle % 360) + 360) % 360;
  return 0;
}

export function liveCameraProfile(
  video,
  {
    navigatorObject = globalThis.navigator,
    windowObject = globalThis.window,
  } = {},
) {
  const track = video?.srcObject?.getVideoTracks?.()[0];
  const settings = track?.getSettings?.() || {};
  const facingMode = settings.facingMode || 'environment';
  const frameOrientation = video.videoWidth >= video.videoHeight ? 'landscape' : 'portrait';
  const previewWidth = video.clientWidth || video.videoWidth;
  const previewHeight = video.clientHeight || video.videoHeight;
  const previewOrientation = previewWidth >= previewHeight ? 'landscape' : 'portrait';
  return [
    browserEngineProfile(navigatorObject),
    facingMode,
    previewOrientation,
    currentScreenAngle(windowObject),
    frameOrientation,
  ].join('|');
}

function safeStorage(storage) {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function readCorrections(storage) {
  try {
    const parsed = JSON.parse(safeStorage(storage)?.getItem(STORAGE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function liveCameraCorrection(
  video,
  {
    navigatorObject = globalThis.navigator,
    windowObject = globalThis.window,
    storage,
  } = {},
) {
  const profile = liveCameraProfile(video, { navigatorObject, windowObject });
  // Android and desktop browsers retain the established no-rotation contract.
  // Apple mobile browsers get an explicit one-time confirmation because both
  // normalized and raw-backing-frame behavior exist in the field.
  if (!isAppleMobile(navigatorObject)) return { profile, correction: 0, needsReview: false };
  const correction = normalizedCorrection(readCorrections(storage)[profile]);
  return {
    profile,
    correction: correction ?? 0,
    needsReview: correction == null,
  };
}

export function saveLiveCameraCorrection(
  profile,
  correction,
  storage,
) {
  const normalized = normalizedCorrection(correction);
  if (!profile || normalized == null) throw new Error('Invalid camera orientation correction');
  try {
    safeStorage(storage)?.setItem(STORAGE_KEY, JSON.stringify({
      ...readCorrections(storage),
      [profile]: normalized,
    }));
  } catch {
    // Private browsing/quota failures are covered by the component's session
    // cache. Persistence is helpful, but never required to save the photo.
  }
  return normalized;
}

function drawRotatedSource(source, correction, sourceWidth, sourceHeight) {
  if (!correction) {
    return {
      source,
      width: sourceWidth,
      height: sourceHeight,
    };
  }
  const swap = Math.abs(correction) === 90;
  const canvas = document.createElement('canvas');
  canvas.width = swap ? sourceHeight : sourceWidth;
  canvas.height = swap ? sourceWidth : sourceHeight;
  const ctx = canvas.getContext('2d');
  ctx.save();
  if (correction === 90) {
    ctx.translate(canvas.width, 0);
    ctx.rotate(Math.PI / 2);
  } else if (correction === -90) {
    ctx.translate(0, canvas.height);
    ctx.rotate(-Math.PI / 2);
  } else {
    ctx.translate(canvas.width, canvas.height);
    ctx.rotate(Math.PI);
  }
  ctx.drawImage(source, 0, 0, sourceWidth, sourceHeight);
  ctx.restore();
  return { source: canvas, width: canvas.width, height: canvas.height };
}

// Render the calibrated backing frame, then apply the same centered
// object-fit:cover crop and digital zoom the technician saw in the preview.
export function drawLiveVideoFrame(
  source,
  canvas,
  {
    correction = 0,
    max = 1600,
    zoom = 1,
    nativeZoom = false,
    previewWidth = source?.clientWidth,
    previewHeight = source?.clientHeight,
    sourceWidth = source?.videoWidth || source?.width,
    sourceHeight = source?.videoHeight || source?.height,
  } = {},
) {
  if (!source || !sourceWidth || !sourceHeight) throw new Error('Camera frame is not ready');
  const normalized = normalizedCorrection(correction);
  if (normalized == null) throw new Error('Invalid camera orientation correction');

  const oriented = drawRotatedSource(source, normalized, sourceWidth, sourceHeight);
  let sx = 0;
  let sy = 0;
  let sw = oriented.width;
  let sh = oriented.height;
  const ew = Number(previewWidth);
  const eh = Number(previewHeight);
  if (ew > 0 && eh > 0) {
    const frameAspect = oriented.width / oriented.height;
    const previewAspect = ew / eh;
    if (frameAspect > previewAspect) {
      sw = Math.round(oriented.height * previewAspect);
      sx = Math.round((oriented.width - sw) / 2);
    } else if (frameAspect < previewAspect) {
      sh = Math.round(oriented.width / previewAspect);
      sy = Math.round((oriented.height - sh) / 2);
    }
  }

  const digitalZoom = nativeZoom ? 1 : Math.max(1, Number(zoom) || 1);
  if (digitalZoom > 1) {
    const nextWidth = sw / digitalZoom;
    const nextHeight = sh / digitalZoom;
    sx += (sw - nextWidth) / 2;
    sy += (sh - nextHeight) / 2;
    sw = nextWidth;
    sh = nextHeight;
  }

  const scale = Math.min(1, max / Math.max(sw, sh));
  const width = Math.max(1, Math.round(sw * scale));
  const height = Math.max(1, Math.round(sh * scale));
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(oriented.source, sx, sy, sw, sh, 0, 0, width, height);
  return {
    correction: normalized,
    sourceWidth: oriented.width,
    sourceHeight: oriented.height,
    sx,
    sy,
    sw,
    sh,
    width,
    height,
  };
}