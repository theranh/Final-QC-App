/*
 * Body Quoter classification helpers — ported VERBATIM from the single-file
 * quoter app (attached_assets/quoter-src/index.html). The system prompt,
 * parse/sanitize, and correction-diff shapes are copied exactly so the AI
 * behaviour and shop-calibration corpus match the old app 1:1.
 */
import { PANELS, DAMAGE, SEVS, pdrEligible } from './quoterPricing';

export const PLABEL = {
  front_bumper: 'Front bumper', grille: 'Grille', hood: 'Hood',
  left_fender: 'L fender', right_fender: 'R fender',
  left_front_door: 'L front door', right_front_door: 'R front door',
  left_rear_door: 'L rear door', right_rear_door: 'R rear door',
  left_cab_corner: 'L cab corner', right_cab_corner: 'R cab corner',
  left_bedside: 'L bedside', right_bedside: 'R bedside',
  left_front_flare: 'L front flare', right_front_flare: 'R front flare',
  left_rear_flare: 'L rear flare', right_rear_flare: 'R rear flare',
  rocker_panel: 'Rocker panel', roof: 'Roof', tailgate: 'Tailgate',
  rear_bumper: 'Rear bumper', mirror: 'Mirror', unknown: 'Unknown panel',
};

export const panelLabel = (p) => PLABEL[p] || p;

// The classify model the old app requested (server accepts it in ALLOWED_MODELS).
export const CLASSIFY_MODEL = 'claude-sonnet-4-6';
export const CLASSIFY_MAX_TOKENS = 700;
export const CLASSIFY_PROMPT = 'Classify the damage in this photo. JSON only.';

export const CLASSIFY_PROMPT_PAIR = 'The first image is a close-up of the damage area; the second is a wide shot of the same area showing its panel location on the vehicle. Use both to classify the damage. JSON only.';
const BASE_SYS_PROMPT = `You are the damage classifier for Truck Ranch, a used truck dealership. You will be shown ONE photo of a possibly damaged area on a pickup truck or SUV.

Return ONLY a single JSON object. No markdown, no code fences, no preamble, no explanation.

Schema (every key required):
{"panel": one of "front_bumper","grille","hood","left_fender","right_fender","left_front_door","right_front_door","left_rear_door","right_rear_door","left_cab_corner","right_cab_corner","left_bedside","right_bedside","left_front_flare","right_front_flare","left_rear_flare","right_rear_flare","rocker_panel","roof","tailgate","rear_bumper","mirror","unknown",
"damage_type": one of "dent","crease","scratch","crack","rust","missing_part","paint_only",
"severity": one of "minor","moderate","heavy","replace",
"paint_damaged": true or false,
"pdr_candidate": true or false,
"blend_adjacent_recommended": true or false,
"ri_parts_needed": array from "door_handle","mirror","molding","bumper_cover","headlamp","tail_lamp","grille","emblem","fender_liner","tailgate_handle","mudflap","step_bar","antenna","door_panel","wheel_flare","other" (empty array if none),
"confidence": one of "high","medium","low",
"notes": one sentence describing what is visible}

Severity is the SIZE of the damage. Judge size against reference objects in frame (door handles are ~6 inches, emblems ~3 inches). Apply exactly:
- "minor" = damage under ~3 inches across (nickel to fist size)
- "moderate" = damage 3 to 8 inches across
- "heavy" = damage over 8 inches across, or buckled/torn metal, or misaligned panel gaps
- "replace" = holes, tears, severe rust-through, or damage crossing structural lines
BUMP RULE: if the metal is creased (a sharp line, not a smooth dent) OR the paint is broken/cracked through, move severity UP one level (minor->moderate, moderate->heavy). Never bump past "heavy" on the size rule alone.
Set "pdr_candidate" true ONLY when ALL of these hold: damage_type is "dent", severity is "minor" or "moderate", paint is NOT broken (paint_damaged false), no crease, and the panel is metal (never front_bumper, rear_bumper, grille, mirror, or flares). PDR means paintless dent repair — a smooth shallow dent with intact factory paint.

Each photo shows ONE damage area. Classify the panel the damage is centered on — the panel filling most of the frame. If damage continues onto an adjacent panel (example: a bedside corner next to a damaged rear bumper), classify ONLY the primary panel in this photo; the adjacent panel is photographed separately. The same panel may appear in several photos showing different damage areas — classify each photo independently on its own damage only.
Left and right mean the VEHICLE's left and right (driver side is left on US trucks). If you cannot tell which side or which panel, use panel "unknown" with confidence "low" rather than guessing.
Set "paint_damaged" true only if the finish is visibly broken, scratched through, cracked, or missing.
Set "blend_adjacent_recommended" true when a refinish would end mid-panel or color-match risk is high (metallic or pearl paint, repair near a panel edge).
List "ri_parts_needed" only for parts that must come off to repair or refinish properly.
If the photo is not a vehicle exterior, is too blurry or dark, or has heavy glare: panel "unknown", confidence "low", and say why in notes.
Never estimate labor hours, cost, or repair time. Classification only.`;

// corrHints(): append the shop's repeated corrections so the model self-corrects.
export function corrHints(corrCache) {
  try {
    const log = corrCache || [];
    if (!log.length) return '';
    const counts = {};
    for (const c of log) for (const d of (c.diffs || [])) counts[d] = (counts[d] || 0) + 1;
    const top = Object.entries(counts).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (!top.length) return '';
    return '\n\nSHOP CALIBRATION — human estimators at this shop repeatedly corrected your past classifications as follows. Weigh these patterns when the photo is consistent with them:\n' + top.map(([d, n]) => '- ' + d + ' (corrected ' + n + '×)').join('\n');
  } catch {
    return '';
  }
}

// vehicleHint(): tell the model what truck it is looking at. Knowing the body
// style (crew cab vs regular, truck vs SUV) sharply improves panel naming —
// bedside vs quarter, rear door existence, flare shapes.
export function vehicleHint(veh) {
  if (!veh) return '';
  const parts = [veh.year, veh.make, veh.model, veh.trim].map((v) => String(v || '').trim()).filter(Boolean);
  const body = String(veh.body || '').trim();
  if (!parts.length && !body) return '';
  return '\n\nVEHICLE CONTEXT — this photo is from a ' + (parts.join(' ') || 'vehicle') + (body ? ' (' + body + ')' : '') + '. Use this to identify panels correctly (e.g. whether it has rear doors, a bed, or a liftgate).';
}

export function sysPrompt(corrCache, veh) {
  return BASE_SYS_PROMPT + vehicleHint(veh) + corrHints(corrCache);
}

// Second-look addendum used when the first pass came back low-confidence or
// unknown: same schema, but pushes a slower, more deliberate examination.
export const SECOND_LOOK_ADDENDUM = `

SECOND LOOK — a previous quick classification of this exact photo was uncertain. Examine it again carefully before answering:
1. Orient yourself first: find wheels, door handles, glass, and body lines to determine which panel fills the frame and which side of the vehicle it is.
2. Then judge the damage: trace its outline, compare its size to reference objects (door handle ~6in, emblem ~3in), and check whether paint is broken.
3. Only use panel "unknown" or confidence "low" if the photo is genuinely unusable (not a vehicle, extreme blur/glare) — a plainly visible panel deserves a real answer at "medium" or better.
Return ONLY the JSON object, same schema as before.`;

// ---------- parse + sanitize (copied verbatim from parseCls) ----------
export function parseCls(text) {
  try {
    let t = String(text).replace(/```[a-zA-Z]*/g, '').trim();
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a < 0 || b < a) return null;
    const o = JSON.parse(t.slice(a, b + 1));
    const norm = (v) => String(v == null ? '' : v).toLowerCase().trim().replace(/[\s-]+/g, '_');
    const panel = PANELS.includes(norm(o.panel)) ? norm(o.panel) : 'unknown';
    const damage = DAMAGE.includes(norm(o.damage_type)) ? norm(o.damage_type) : 'dent';
    const sev = SEVS.includes(norm(o.severity)) ? norm(o.severity) : 'moderate';
    const conf = ['high', 'medium', 'low'].includes(norm(o.confidence)) ? norm(o.confidence) : 'low';
    const parts = Array.isArray(o.ri_parts_needed) ? o.ri_parts_needed.map(norm).filter(Boolean).slice(0, 6) : [];
    const pdr = !!o.pdr_candidate && pdrEligible({ damage_type: damage, paint_damaged: !!o.paint_damaged, severity: sev, panel });
    return { panel, damage_type: damage, severity: sev, paint_damaged: !!o.paint_damaged, pdr, blend_adjacent_recommended: !!o.blend_adjacent_recommended, ri_parts_needed: parts, confidence: conf, notes: String(o.notes || '').slice(0, 220) };
  } catch {
    return null;
  }
}

const CONF_RANK = { high: 2, medium: 1, low: 0 };
export function pickBetterCls(cls, cls2) {
  if (!cls2) return cls;
  if (!cls) return cls2;
  const cls2Named = cls2.panel !== 'unknown';
  const clsNamed  = cls.panel  !== 'unknown';
  if (cls2Named && !clsNamed) return cls2;   // retry names the panel; first didn't
  if (clsNamed  && !cls2Named) return cls;   // first named the panel; retry didn't
  // Same panel-named status: promote retry only when confidence is strictly higher.
  if ((CONF_RANK[cls2.confidence] ?? 0) > (CONF_RANK[cls.confidence] ?? 0)) return cls2;
  return cls;
}
export function correctionDiffs(ai, est) {
  if (!ai) return [];
  const diffs = [];
  const pn = (p) => PLABEL[p] || p;
  if (ai.panel !== est.panel) diffs.push('panel ' + pn(ai.panel) + ' -> ' + pn(est.panel));
  if (ai.severity !== est.severity) diffs.push(pn(est.panel) + ': severity ' + ai.severity + ' -> ' + est.severity);
  if (ai.damage_type !== est.damage_type) diffs.push(pn(est.panel) + ': damage ' + String(ai.damage_type).replace(/_/g, ' ') + ' -> ' + String(est.damage_type).replace(/_/g, ' '));
  if (!!ai.paint_damaged !== !!est.paint_damaged) diffs.push(pn(est.panel) + ': paint_damaged ' + !!ai.paint_damaged + ' -> ' + !!est.paint_damaged);
  if (!!ai.blend_adjacent_recommended !== !!est.blend_adjacent_recommended) diffs.push(pn(est.panel) + ': blend ' + !!ai.blend_adjacent_recommended + ' -> ' + !!est.blend_adjacent_recommended);
  return diffs;
}
