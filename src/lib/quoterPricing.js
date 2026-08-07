/*
 * Body Quoter pricing engine — ported VERBATIM from the single-file quoter app.
 *
 * These functions were originally class methods that read from `this.state.lines`
 * and `this.state.rates`. They have been refactored into pure functions that take
 * `lines` and `rates` as explicit parameters. Every branch, cap, blend,
 * partial-paint factor, override, PDR rule, proration and rounding step is kept
 * EXACTLY as written in the original so that identical inputs yield identical
 * totals. No math has been "improved" or simplified.
 */

/* ---------- constants (ported from the class constructor) ---------- */

export const PANELS = ['front_bumper', 'grille', 'hood', 'left_fender', 'right_fender', 'left_front_flare', 'right_front_flare', 'left_front_door', 'right_front_door', 'left_rear_door', 'right_rear_door', 'left_cab_corner', 'right_cab_corner', 'left_bedside', 'right_bedside', 'left_rear_flare', 'right_rear_flare', 'rocker_panel', 'roof', 'tailgate', 'rear_bumper', 'mirror', 'unknown'];

export const DAMAGE = ['dent', 'crease', 'scratch', 'crack', 'rust', 'missing_part', 'paint_only'];

export const SEVS = ['minor', 'moderate', 'heavy', 'replace'];

export const PARTS = ['door_handle', 'mirror', 'molding', 'bumper_cover', 'headlamp', 'tail_lamp', 'grille', 'emblem', 'fender_liner', 'tailgate_handle', 'mudflap', 'step_bar', 'antenna', 'door_panel', 'wheel_flare', 'other'];

export const PARTIAL_FACTOR = 0.6;

export const ADJ = { front_bumper: ['left_fender', 'right_fender'], grille: ['hood'], hood: ['left_fender', 'right_fender'], left_fender: ['hood', 'left_front_door'], right_fender: ['hood', 'right_front_door'], left_front_door: ['left_fender', 'left_rear_door'], right_front_door: ['right_fender', 'right_rear_door'], left_rear_door: ['left_front_door', 'left_cab_corner'], right_rear_door: ['right_front_door', 'right_cab_corner'], left_cab_corner: ['left_rear_door', 'left_bedside'], right_cab_corner: ['right_rear_door', 'right_bedside'], left_bedside: ['left_cab_corner', 'tailgate'], right_bedside: ['right_cab_corner', 'tailgate'], tailgate: ['left_bedside', 'right_bedside'], rear_bumper: ['left_bedside', 'right_bedside'], left_front_flare: ['left_fender'], right_front_flare: ['right_fender'], left_rear_flare: ['left_bedside'], right_rear_flare: ['right_bedside'], rocker_panel: [], roof: [], mirror: [], unknown: [] };

/* ---------- default flags (ported verbatim) ---------- */

export function defaultFlags() {
  return [
    { id: 'glass', label: 'Glass', color: 'teal' },
    { id: 'pdr', label: 'PDR', color: 'blue' },
    { id: 'interior', label: 'Interior Repairs', color: 'green' },
    { id: 'bumper', label: 'Bumper Repair', color: 'yellow' },
    { id: 'twin', label: 'Twin Unit', color: 'gray' },
    { id: 'notalloc', label: 'Not Allocated', color: 'gray' },
    { id: 'wj', label: 'W.J. Unit', color: 'gray' },
    { id: 'colorado', label: 'Colorado Unit', color: 'gray' },
    { id: 'bedliner', label: 'Bedliner', color: 'gray' },
    { id: 'fast', label: 'Fast', color: 'gray' },
    { id: 'af', label: 'A.F. Unit', color: 'gray' },
    { id: 'deleted', label: 'Deleted', color: 'slate' },
    { id: 'smoker', label: 'Smoker', color: 'dark' },
    { id: 'logan', label: 'Logan Unit', color: 'gray' },
    { id: 'build', label: 'Build', color: 'orange' },
    { id: 'standard', label: 'Standard', color: 'sky' },
    { id: 'qcfail', label: 'QC Fail', color: 'red' }
  ];
}

/* ---------- default rates (ported verbatim) ---------- */

export function defaultRates() {
  // Body hours are size-based and the same for every panel:
  // minor = small (<3"), moderate = medium (3-8"), heavy = large (8"+, max 4 hr).
  // "replace" stays per-panel (R&R labor differs by panel).
  const repl = { front_bumper: 1.5, grille: 0.5, hood: 1.0, left_fender: 1.5, right_fender: 1.5, left_front_door: 2.5, right_front_door: 2.5, left_rear_door: 2.5, right_rear_door: 2.5, left_cab_corner: 8.0, right_cab_corner: 8.0, left_bedside: 10.0, right_bedside: 10.0, rocker_panel: 7.0, roof: 12.0, tailgate: 1.0, rear_bumper: 1.0, mirror: 0.3, left_front_flare: 0.8, right_front_flare: 0.8, left_rear_flare: 0.8, right_rear_flare: 0.8, unknown: 0 };
  const body = {};
  for (const p of Object.keys(repl)) body[p] = p === 'unknown' ? { minor: 0, moderate: 0, heavy: 0, replace: 0 } : { minor: 1.0, moderate: 2.5, heavy: 4.0, replace: repl[p] };
  // Paint is a flat rate per panel: regular panels 4.0; hood/roof/bedside 5.0; small pieces less.
  const refinish = { front_bumper: 2.5, grille: 1.0, hood: 5.0, left_fender: 4.0, right_fender: 4.0, left_front_door: 4.0, right_front_door: 4.0, left_rear_door: 4.0, right_rear_door: 4.0, left_cab_corner: 2.5, right_cab_corner: 2.5, left_bedside: 5.0, right_bedside: 5.0, rocker_panel: 4.0, roof: 5.0, tailgate: 4.0, rear_bumper: 2.5, mirror: 1.5, left_front_flare: 1.5, right_front_flare: 1.5, left_rear_flare: 1.5, right_rear_flare: 1.5, unknown: 0 };
  const ri = { door_handle: 0.3, mirror: 0.4, molding: 0.3, bumper_cover: 1.0, headlamp: 0.4, tail_lamp: 0.3, grille: 0.5, emblem: 0.2, fender_liner: 0.3, tailgate_handle: 0.3, mudflap: 0.2, step_bar: 0.5, antenna: 0.2, door_panel: 0.4, wheel_flare: 0.4, other: 0.3 };
  return {
    body, refinish, ri, dollars: { body: 75, paint: 80, ri: 65 },
    caps: { regular: 6, large: 8, bumper: 4 },
    pdr: { small: 55, medium: 150 },
    flags: defaultFlags(),
    showPricing: false
  };
}

/* ---------- rounding helper (ported verbatim) ---------- */

export function rn(v) { const n = parseFloat(v); return isFinite(n) && n > 0 ? n : 0; }

/* ---------- caps & PDR helpers (ported verbatim) ---------- */

// Per-panel hard cap on (body + own-panel paint) hours. Blends on adjacent
// panels stay outside the cap. Estimator overrides are never capped.
export function panelCap(panel, rates) {
  const c = (rates && rates.caps) || {};
  if (panel === 'front_bumper' || panel === 'rear_bumper') return rn(c.bumper);
  if (panel === 'hood' || panel === 'roof' || panel === 'left_bedside' || panel === 'right_bedside') return rn(c.large);
  if (panel === 'unknown') return 0;
  return rn(c.regular);
}

// Flat PDR bid in dollars for a qualifying dent (small/medium size).
export function pdrUsd(sev, rates) { return rn(((rates && rates.pdr) || {})[sev === 'minor' ? 'small' : 'medium']); }

// Single source of truth for PDR eligibility: smooth dent, small/medium,
// factory paint intact, metal panel. Enforced at parse, in the editor, and at billing.
export function pdrEligible(c) {
  if (!c) return false;
  const plastic = ['front_bumper', 'rear_bumper', 'grille', 'mirror', 'left_front_flare', 'right_front_flare', 'left_rear_flare', 'right_rear_flare', 'unknown'];
  return (c.damage_type === 'dent') && !c.paint_damaged && (c.severity === 'minor' || c.severity === 'moderate') && !plastic.includes(c.panel);
}

/* ---------- hours math (ported verbatim) ---------- */

export function lineHours(cls, rates) {
  if (!cls) return { b: 0, p: 0, ri: 0, blends: [], riList: [] };
  let b = rn((rates.body[cls.panel] || {})[cls.severity]);
  let bOverridden = false;
  if (cls.b_override != null && String(cls.b_override) !== '') {
    const ov = parseFloat(cls.b_override);
    if (isFinite(ov) && ov >= 0) { b = ov; bOverridden = true; }
  }
  let p = 0; let blends = []; let partial = false;
  if (cls.paint_damaged) {
    p = rn(rates.refinish[cls.panel]);
    if (cls.paint_partial && p > 0) { p = Math.round(p * PARTIAL_FACTOR * 10) / 10; partial = true; }
    if (cls.blend_adjacent_recommended) {
      for (const adj of (ADJ[cls.panel] || []).slice(0, 2)) {
        const h = Math.round(rn(rates.refinish[adj]) * 0.5 * 10) / 10;
        if (h > 0) { blends.push({ panel: adj, hrs: h }); p += h; }
      }
    }
  }
  let pOverridden = false;
  if (cls.p_override != null && String(cls.p_override) !== '') {
    const ov = parseFloat(cls.p_override);
    if (isFinite(ov) && ov >= 0) { p = ov; pOverridden = true; blends = []; partial = false; }
  }
  let ri = 0; const riList = [];
  for (const part of (cls.ri_parts_needed || [])) {
    const h = rates.ri[part] != null ? rn(rates.ri[part]) : rn(rates.ri.other);
    ri += h; riList.push({ part, hrs: h });
  }
  let riOverridden = false;
  if (cls.ri_override != null && String(cls.ri_override) !== '') {
    const ov = parseFloat(cls.ri_override);
    if (isFinite(ov) && ov >= 0) { ri = ov; riOverridden = true; }
  }
  // PDR: qualifying dent bills a flat $ amount instead of body+paint hours.
  // Estimator hour overrides always win over PDR.
  if (cls.pdr && !bOverridden && !pOverridden && pdrEligible(cls)) {
    return { b: 0, p: 0, ri, blends: [], riList, riOverridden, partial: false, bOverridden, pOverridden, pdr: true, pdrUsd: pdrUsd(cls.severity, rates), capped: false };
  }
  // Hard cap per panel on body + own-panel paint (blends excluded); trims body first.
  let capped = false;
  const cap = panelCap(cls.panel, rates);
  if (cap > 0 && !bOverridden && !pOverridden) {
    const blendSum = blends.reduce((s, x) => s + x.hrs, 0);
    const core = b + (p - blendSum);
    if (core > cap) {
      let over = Math.round((core - cap) * 10) / 10;
      const cutB = Math.min(b, over);
      b = Math.round((b - cutB) * 10) / 10;
      over = Math.round((over - cutB) * 10) / 10;
      if (over > 0) p = Math.max(0, Math.round((p - over) * 10) / 10);
      capped = true;
    }
  }
  return { b, p, ri, blends, riList, riOverridden, partial, bOverridden, pOverridden, pdr: false, pdrUsd: 0, capped, cap };
}

export function sevRank(s) { return { minor: 1, moderate: 2, heavy: 3, replace: 4 }[s] || 0; }

/* ---------- billing map (ported verbatim, `this.state.lines` -> `lines` param) ---------- */

export function billingMap(lines) {
  const map = {};
  const done = (lines || []).filter(l => l.status === 'done' && !l.review && l.cls);
  // Pass 1: primary lines compete for the panel's main billing entry.
  // Pass 2: "separate damage area" lines add their own body hours on top.
  const extras = [];
  for (const l of done) { if (l.cls.extra_area) extras.push(l); else bmAdd(map, l); }
  for (const l of extras) {
    const p = l.cls.panel;
    if (!map[p]) { bmAdd(map, l); continue; }
    const m = map[p];
    m.extras.push({ id: l.id, sev: l.cls.severity, b_override: (l.cls.b_override != null ? l.cls.b_override : null) });
    m.pdr = false; // a separate damage area means real bodywork on this panel
    m.paint = m.paint || !!l.cls.paint_damaged;
    m.blend = m.blend || !!l.cls.blend_adjacent_recommended;
    m.partial = m.partial && !!l.cls.paint_partial;
    if (l.cls.p_override != null && String(l.cls.p_override) !== '') m.p_override = l.cls.p_override;
    if (l.cls.ri_override != null && String(l.cls.ri_override) !== '') m.ri_override = l.cls.ri_override;
    for (const pt of (l.cls.ri_parts_needed || [])) if (!m.parts.includes(pt)) m.parts.push(pt);
  }
  return map;
}

export function bmAdd(map, l) {
  {
    const p = l.cls.panel;
    if (!map[p]) {
      map[p] = { winner: l.id, sev: l.cls.severity, dmg: l.cls.damage_type, paint: !!l.cls.paint_damaged, blend: !!l.cls.blend_adjacent_recommended, parts: [...(l.cls.ri_parts_needed || [])], ri_override: (l.cls.ri_override != null ? l.cls.ri_override : null), b_override: (l.cls.b_override != null ? l.cls.b_override : null), p_override: (l.cls.p_override != null ? l.cls.p_override : null), partial: !!l.cls.paint_partial, pdr: !!l.cls.pdr, extras: [] };
    } else {
      const m = map[p];
      if (sevRank(l.cls.severity) > sevRank(m.sev)) { m.sev = l.cls.severity; m.dmg = l.cls.damage_type; m.winner = l.id; }
      m.pdr = m.pdr && !!l.cls.pdr;
      m.paint = m.paint || !!l.cls.paint_damaged;
      m.blend = m.blend || !!l.cls.blend_adjacent_recommended;
      m.partial = m.partial && !!l.cls.paint_partial;
      if (l.cls.ri_override != null && String(l.cls.ri_override) !== '') m.ri_override = l.cls.ri_override;
      if (l.cls.b_override != null && String(l.cls.b_override) !== '') m.b_override = l.cls.b_override;
      if (l.cls.p_override != null && String(l.cls.p_override) !== '') m.p_override = l.cls.p_override;
      for (const pt of (l.cls.ri_parts_needed || [])) if (!m.parts.includes(pt)) m.parts.push(pt);
    }
  }
}

// Body hours for one "separate damage area" entry (its own override or table hours).
export function extraBodyHrs(panel, x, rates) {
  if (x.b_override != null && String(x.b_override) !== '') {
    const ov = parseFloat(x.b_override);
    if (isFinite(ov) && ov >= 0) return ov;
  }
  return rn((rates.body[panel] || {})[x.sev]);
}

// Per-line billed body hours for a panel (winner + separate damage areas),
// capped at replace-level hours and prorated so line items always sum to the total.
export function bodyAlloc(p, m, rates) {
  const h = lineHours(billingCls(p, m), rates);
  const xs = m.extras || [];
  const byId = {}; byId[m.winner] = h.b;
  let sum = h.b;
  for (const x of xs) { const eb = extraBodyHrs(p, x, rates); byId[x.id] = eb; sum += eb; }
  if (xs.length) {
    const anyOv = h.bOverridden || xs.some(x => x.b_override != null && String(x.b_override) !== '');
    // Combined body across all damage areas is capped at the lower of the
    // replace-level hours and the panel hard cap minus own-panel paint
    // (blends stay outside the cap).
    let cap = rn((rates.body[p] || {}).replace);
    const pc = panelCap(p, rates);
    if (pc > 0 && !h.pOverridden) {
      const blendSum = (h.blends || []).reduce((s2, x2) => s2 + x2.hrs, 0);
      const capB = Math.max(0, Math.round((pc - (h.p - blendSum)) * 10) / 10);
      cap = cap > 0 ? Math.min(cap, capB) : capB;
    }
    if (!anyOv && cap >= 0 && (pc > 0 || cap > 0) && sum > cap) {
      // Allocate in integer tenths of an hour (largest-remainder method)
      // so per-line hours are non-negative and sum exactly to the cap.
      const ids = Object.keys(byId);
      const capT = Math.round(cap * 10);
      const exact = ids.map(id => byId[id] / sum * capT);
      const floors = exact.map(v => Math.floor(v));
      let left = capT - floors.reduce((a, b) => a + b, 0);
      const order = ids.map((id, i) => i).sort((a, b) => (exact[b] - floors[b]) - (exact[a] - floors[a]));
      for (const i of order) { if (left <= 0) break; floors[i] += 1; left -= 1; }
      ids.forEach((id, i) => { byId[id] = floors[i] / 10; });
      sum = ids.reduce((a, id) => a + byId[id], 0);
    }
  }
  return { byId, total: Math.round(sum * 10) / 10 };
}

export function billingCls(panel, m) { return { panel, severity: m.sev, damage_type: m.dmg, paint_damaged: m.paint, blend_adjacent_recommended: m.blend, ri_parts_needed: m.parts, ri_override: m.ri_override, b_override: m.b_override, p_override: m.p_override, paint_partial: !!m.partial, pdr: !!m.pdr }; }

/* ---------- quote totals (ported verbatim; `this.state` -> params) ---------- */

export function quoteTotals(lines, rates) {
  const map = billingMap(lines);
  let B = 0, P = 0, RI = 0, PDR = 0;
  const painted = new Set();
  for (const p of Object.keys(map)) {
    const h = lineHours(billingCls(p, map[p]), rates);
    if (h.pdr) { PDR += h.pdrUsd; RI += h.ri; continue; }
    B += bodyAlloc(p, map[p], rates).total; P += h.p; RI += h.ri;
    if (map[p].paint && p !== 'unknown' && !(map[p].p_override != null && String(map[p].p_override) !== '')) painted.add(p);
  }
  // Blend overlap credit removed by shop decision (Jul 2026): line items
  // now always sum exactly to the total. `overlap` stays 0 so the old
  // credit rows in the exports simply never render.
  const overlap = 0;
  const r1 = (x) => Math.round(x * 10) / 10;
  B = r1(B); P = r1(P); RI = r1(RI);
  const d = rates.dollars;
  const usdB = Math.round(B * rn(d.body)), usdP = Math.round(P * rn(d.paint)), usdRI = Math.round(RI * rn(d.ri));
  const usdPDR = Math.round(PDR);
  return {
    B, P, RI, overlap: r1(overlap), hrs: r1(B + P + RI), usdB, usdP, usdRI, usdPDR, usd: usdB + usdP + usdRI + usdPDR,
    flagged: (lines || []).filter(l => l.status === 'done' && l.review).length,
    errors: (lines || []).filter(l => l.status === 'error').length
  };
}
