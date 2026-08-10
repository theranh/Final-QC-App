// ISO 3779 VIN check-digit validation.
export function vinValid(v) {
  v = String(v || '').toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(v)) return false;
  const map = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9 };
  const wt = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const ch = v[i];
    const val = ch >= '0' && ch <= '9' ? Number(ch) : map[ch];
    sum += val * wt[i];
  }
  const r = sum % 11;
  return v[8] === (r === 10 ? 'X' : String(r));
}

// Code 39 bar-width pattern table (narrow/wide), used by the camera-frame fallback decoder
// when the browser has no native BarcodeDetector support.
const C39 = {
  nnnwwnwnn: '0', wnnwnnnnw: '1', nnwwnnnnw: '2', wnwwnnnnn: '3', nnnwwnnnw: '4', wnnwwnnnn: '5', nnwwwnnnn: '6', nnnwnnwnw: '7', wnnwnnwnn: '8', nnwwnnwnn: '9',
  wnnnnwnnw: 'A', nnwnnwnnw: 'B', wnwnnwnnn: 'C', nnnnwwnnw: 'D', wnnnwwnnn: 'E', nnwnwwnnn: 'F', nnnnnwwnw: 'G', wnnnnwwnn: 'H', nnwnnwwnn: 'I', nnnnwwwnn: 'J',
  wnnnnnnww: 'K', nnwnnnnww: 'L', wnwnnnnwn: 'M', nnnnwnnww: 'N', wnnnwnnwn: 'O', nnwnwnnwn: 'P', nnnnnnwww: 'Q', wnnnnnwwn: 'R', nnwnnnwwn: 'S', nnnnwnwwn: 'T',
  wwnnnnnnw: 'U', nwwnnnnnw: 'V', wwwnnnnnn: 'W', nwnnwnnnw: 'X', wwnnwnnnn: 'Y', nwwnwnnnn: 'Z',
  nwnnnnwnw: '-', wwnnnnwnn: '.', nwwnnnwnn: ' ', nwnnwnwnn: '*', nwnwnwnnn: '$', nwnwnnnwn: '/', nwnnnwnwn: '+', nnnwnwnwn: '%',
};

function read39Char(runs, i) {
  if (i + 9 > runs.length) return null;
  if (runs[i].b !== 1) return null;
  const widths = [];
  for (let j = 0; j < 9; j++) widths.push(runs[i + j].len);
  const sorted = widths.slice().sort((a, b) => a - b);
  const nMax = sorted[5];
  const wMin = sorted[6];
  if (wMin < nMax * 1.35) return null;
  const thr = (nMax + wMin) / 2;
  let pat = '';
  for (let j = 0; j < 9; j++) pat += widths[j] > thr ? 'w' : 'n';
  return C39[pat] || null;
}

function decode39(runs) {
  for (let start = 0; start < runs.length - 19; start++) {
    if (runs[start].b !== 1) continue;
    if (read39Char(runs, start) !== '*') continue;
    let out = '';
    let i = start + 10;
    let guard = 0;
    let ok = true;
    while (guard < 40) {
      guard++;
      if (i + 9 > runs.length) {
        ok = false;
        break;
      }
      const ch = read39Char(runs, i);
      if (ch == null) {
        ok = false;
        break;
      }
      if (ch === '*') break;
      out += ch;
      i += 10;
    }
    if (ok && out.length >= 10) return out;
  }
  return null;
}

// Best-effort fallback barcode decode from a <video> frame when BarcodeDetector is unavailable.
export function fallbackDecodeFrame(video, scratchCanvas) {
  try {
    const c = scratchCanvas;
    const W = 800;
    const H = Math.max(1, Math.round((video.videoHeight / (video.videoWidth || 1)) * W)) || 600;
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, W, H);
    const rows = [0.38, 0.44, 0.48, 0.52, 0.56, 0.62].map((f) => Math.round(H * f));
    for (let ri = 0; ri < rows.length; ri++) {
      const dt = ctx.getImageData(0, rows[ri], W, 1).data;
      const g = new Array(W);
      let mn = 255, mx = 0;
      for (let x = 0; x < W; x++) {
        const l = dt[x * 4] * 0.299 + dt[x * 4 + 1] * 0.587 + dt[x * 4 + 2] * 0.114;
        g[x] = l;
        if (l < mn) mn = l;
        if (l > mx) mx = l;
      }
      if (mx - mn < 45) continue;
      const thr = (mn + mx) / 2;
      const runs = [];
      let cur = g[0] < thr ? 1 : 0;
      let len = 1;
      for (let x = 1; x < W; x++) {
        const b = g[x] < thr ? 1 : 0;
        if (b === cur) len++;
        else {
          runs.push({ b: cur, len });
          cur = b;
          len = 1;
        }
      }
      runs.push({ b: cur, len });
      let t = decode39(runs);
      if (t) return t;
      t = decode39(runs.slice().reverse());
      if (t) return t;
    }
  } catch {
    // ignore — frame just wasn't decodable this pass
  }
  return null;
}

// Build a "Year Make Model Trim" description from a vPIC DecodeVinValues result row.
export function vehicleDescFromDecode(r) {
  r = r || {};
  const clean = (v) => String(v || '').trim();
  const year = clean(r.ModelYear);
  const rawMake = clean(r.Make);
  // vPIC returns makes in ALL CAPS ("FORD", "GMC"). Title-case long names, keep short ones (GMC, RAM, BMW) as-is.
  const make = rawMake
    .split(/\s+/)
    .map((w) => (w.length <= 3 ? w : w.charAt(0) + w.slice(1).toLowerCase()))
    .join(' ');
  const model = clean(r.Model);
  const trim = clean(r.Trim);
  const desc = [year, make, model, trim].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return year || make || model ? desc : null;
}

// Decode a VIN into "Year Make Model Trim" via the free NHTSA vPIC API.
// Returns null on any failure (offline, API down, unknown VIN) — callers must treat it as best-effort.
export async function decodeVinInfo(vin) {
  try {
    const res = await fetch(
      `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(vin)}?format=json`
    );
    if (!res.ok) return null;
    const data = await res.json();
    return vehicleDescFromDecode(data && data.Results && data.Results[0]);
  } catch {
    return null;
  }
}

// Decide what the intake screen does with a VIN coming off the scanner.
// A scan must NEVER silently seed an intake with a bad VIN: only a clean
// 17-character VIN with a passing check digit seeds; anything else is blocked
// with an explicit message so the user verifies (and, if truly correct,
// consciously uses the manual check-digit override).
export function scannedVinDecision(raw, valid) {
  const vin = String(raw || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (vin.length !== 17) {
    return { seed: false, vin, message: 'Scanned code is not a 17-character VIN — verify and type it manually.' };
  }
  const ok = typeof valid === 'boolean' ? valid : vinValid(vin);
  if (!ok) {
    return {
      seed: false,
      vin,
      message: 'Scanned VIN failed its check digit. Verify against the door label, then use check digit override only if it truly matches.',
    };
  }
  return { seed: true, vin, message: '' };
}

export function extractVin17(text) {
  const cleaned = String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = cleaned.match(/[A-HJ-NPR-Z0-9]{17}/);
  return m ? m[0] : null;
}
