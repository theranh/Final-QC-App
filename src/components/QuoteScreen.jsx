import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { vinValid, decodeVinInfo } from '../lib/vin';
import { compressImageFile } from '../lib/photo';
import { persistJob, removeJob, removeJobsForPhoto, newJobKey } from '../lib/photoQueue';
import VinScanner from './VinScanner';
import { prefetchZxing } from '../lib/zxingDecode';
import WalkAroundCamera from './WalkAroundCamera';
import { SignatureBadge } from './PinDialog';
import {
  PANELS, DAMAGE, SEVS, PARTS,
  defaultRates, defaultFlags, quoteTotals, lineHours, pdrEligible,
  billingMap, bodyAlloc, billingCls, rn,
} from '../lib/quoterPricing';
import {
  panelLabel, sysPrompt, parseCls, correctionDiffs,
  CLASSIFY_MODEL, CLASSIFY_MAX_TOKENS, CLASSIFY_PROMPT,
} from '../lib/quoterClassify';

/*
 * Body Quoter — ported from the single-file quoter app into the Final QC app.
 * Flow: VIN entry → vehicle confirm → stock#/estimator → damage photos →
 * analyze → line editor → totals. Pricing math is imported unchanged from
 * quoterPricing.js; the AI prompt/parse/correction shapes come from
 * quoterClassify.js (verbatim from the old app).
 */

const newId = (p) => p + Date.now() + Math.random().toString(36).slice(2, 6);
const fmt1 = (v) => {
  const n = Math.round(parseFloat(v) * 10) / 10;
  return (Number.isInteger(n) ? String(n) : n.toFixed(1));
};

const SEV_LABEL = { minor: 'Minor', moderate: 'Moderate', heavy: 'Heavy', replace: 'Replace' };
const DMG_LABEL = {
  dent: 'Dent', crease: 'Crease', scratch: 'Scratch', crack: 'Crack',
  rust: 'Rust', missing_part: 'Missing part', paint_only: 'Paint only',
};
const partLabel = (p) => String(p || '').replace(/_/g, ' ');

// Merge the live snapshot with an explicit per-tick override so autosave never
// serializes the previous render's flags/keep/notes. Exported for unit tests.
export function mergeQuoteSnapshot(base, overrides) {
  return { ...(base || {}), ...(overrides || {}) };
}

// Normalize the old-app-compatible extras (flags/keep/notes) for persistence.
// Exported so a round-trip test can assert the stored shape.
export function quoteExtras(snapshot) {
  const s = snapshot || {};
  return {
    notes: s.notes || '',
    flags: (s.flags || []).map((f) => ({ id: f.id, done: !!f.done })),
    keep: { tires: !!(s.keep && s.keep.tires), wheels: !!(s.keep && s.keep.wheels), set: !!(s.keep && s.keep.set) },
  };
}

// Autosave failure notifier: EVERY failed save produces a visible warning —
// the first failure included, so a single edit made during an outage is never
// lost silently. Repeat warnings are throttled (15s) so a burst of debounced
// saves doesn't stack toasts; a 409 (committed/locked quote) always warns
// immediately with its own message. Exported for unit tests.
// Durable damage-photo upload — same offline safety net as walk-around shots:
// the close-up is persisted to the on-device queue BEFORE the upload attempt,
// so weak signal, closing the camera, or force-closing the app can't lose it;
// leftovers are flushed by the app-level queue — which keeps retrying damage
// close-ups even while the walk-around camera is open — and on launch. Permanent
// rejections (413 too large / 409 committed / 403) can never succeed later,
// so those are dropped from the queue and surfaced instead. `isDeleted(id)`
// lets the caller cancel a capture the inspector deleted while it was still
// queued or in flight — a deleted photo must never be (re)sent later.
// Exported for tests.
export async function uploadDamagePhotoDurably({ id, quoteId, slot, dataUrl }, showToast, isDeleted) {
  const key = newJobKey(id);
  await persistJob({ key, id, quoteId, slotKey: slot, dataUrl });
  if (isDeleted && isDeleted(id)) { removeJob(key); return; }
  try {
    await api.putQuotePhoto({ id, quoteId, slot, dataUrl });
    removeJob(key);
    // Deleted while the upload was in flight: the server copy that just landed
    // must go away too — the inspector's delete wins.
    if (isDeleted && isDeleted(id)) api.deleteQuotePhoto({ id }).catch(() => {});
  } catch (e) {
    if (isDeleted && isDeleted(id)) { removeJob(key); return; }
    if (e.status === 413 || e.status === 409 || e.status === 403) {
      removeJob(key); // retrying can never succeed — don't leave it queued
      showToast && showToast(e.status === 413 ? 'Photo is too large.' : e.status === 409 ? 'This quote is committed.' : 'Photo could not be saved.');
    } else {
      // Transient (offline / server blip / signed out): the persisted copy is
      // retried automatically, even after an app close.
      showToast && showToast('Weak signal — damage photo saved, it will send in the background.');
    }
  }
}

// Deleting a damage photo must erase EVERY copy: the on-device queued upload
// (or the launch-time flusher would resurrect the deleted image later) and the
// server copy. Exported for tests.
export async function purgeDeletedDamagePhoto(id) {
  await removeJobsForPhoto(id, '__none__'); // no surviving capture — drop all queued records
  api.deleteQuotePhoto({ id }).catch(() => { /* offline — nothing on the server yet */ });
}

export function createSaveFailureNotifier(notify, nowFn = Date.now) {
  let fails = 0;
  let warnedAt = 0;
  return {
    failed(e) {
      fails += 1;
      const committed409 = !!(e && e.status === 409);
      const now = nowFn();
      if (!committed409 && fails > 1 && now - warnedAt < 15000) return; // throttle repeats
      warnedAt = now;
      notify(committed409
        ? 'NOT SAVED — this quote is signed off and locked. Ask an admin to unlock it.'
        : 'WARNING: quote changes are not saving (offline or server error). Keep this screen open and check your connection.');
    },
    succeeded() { fails = 0; warnedAt = 0; },
    get failCount() { return fails; },
  };
}

// ---------- flags (ported from the old quoter) ----------
const FLAG_PALETTE = {
  teal: { bg: '#e2f4f7', bd: '#8ecbd6', fg: '#1d6b78' },
  blue: { bg: '#e3edfb', bd: '#a9c4ea', fg: '#2f5da8' },
  green: { bg: '#e7f5e9', bd: '#9ec4a8', fg: '#2e7d46' },
  yellow: { bg: '#fdf3e0', bd: '#e3c07f', fg: '#8a6210' },
  gray: { bg: '#f0eee9', bd: '#d9d2c4', fg: '#5a5348' },
  slate: { bg: '#e6e3dc', bd: '#c8c1b2', fg: '#4a453c' },
  dark: { bg: '#555046', bd: '#3b372f', fg: '#f2efe8' },
  orange: { bg: '#fbe9d8', bd: '#e0ab77', fg: '#96551a' },
  sky: { bg: '#e6f1f8', bd: '#a9cbe0', fg: '#2b6389' },
  red: { bg: '#f9e7e6', bd: '#d99b96', fg: '#b0322a' },
};
// The pickable flag list = server rates.flags override (if present) else the
// bundled default list. Each entry is resolved to its palette colors.
function flagDefs(rates) {
  const list = (rates && Array.isArray(rates.flags)) ? rates.flags : defaultFlags();
  return list.map((f) => ({ id: f.id, label: f.label, color: f.color, ...(FLAG_PALETTE[f.color] || FLAG_PALETTE.gray) }));
}
function flagDef(rates, id) {
  const hit = flagDefs(rates).find((d) => d.id === id);
  if (hit) return hit;
  const label = String(id).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return { id, label, ...FLAG_PALETTE.gray };
}

const usd = (n) => '$' + Math.round(Number(n) || 0).toLocaleString();
const dateDisp = (iso) => { try { return new Date(iso || Date.now()).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); } catch { return ''; } };
const sevWord = (s) => ({ minor: 'small', moderate: 'medium', heavy: 'large' }[s] || s);

// ---------- plain-text quote summary (ported from buildSummary) ----------
function buildSummary({ lines, rates, veh, vehicleText, stock, miles, vin, estimator, notes, keep, flags }) {
  const t = quoteTotals(lines, rates);
  const d = rates.dollars;
  const bmap = billingMap(lines);
  const vehTitle = (veh && [veh.year, veh.make, veh.model, veh.trim].filter(Boolean).join(' ')) || vehicleText || 'Vehicle';
  const L = [];
  L.push('TRUCK RANCH — PAINT & BODY QUOTE');
  L.push(vehTitle + '  ·  Stock ' + (stock || '—') + '  ·  ' + (miles ? miles + ' mi' : '— mi'));
  L.push('VIN ' + (vin || '—'));
  L.push('Estimator ' + (estimator || '—') + '  ·  ' + dateDisp());
  L.push('');
  let i = 1;
  for (const l of lines) {
    if (l.status !== 'done' || !l.cls) continue;
    const name = panelLabel(l.cls.panel);
    if (l.review) { L.push(i + '. ' + name + ' — NEEDS HUMAN REVIEW (not quoted)'); }
    else {
      const bm = bmap[l.cls.panel];
      const isX = !!(bm && (bm.extras || []).some((x) => x.id === l.id));
      if (isX) {
        const xb = bodyAlloc(l.cls.panel, bm, rates).byId[l.id] || 0;
        L.push(i + '. ' + name + ' — 2nd damage area, ' + l.cls.damage_type.replace(/_/g, ' ') + ', ' + l.cls.severity);
        L.push('   Body +' + fmt1(xb) + ' (paint & parts billed once per panel)');
      } else if (bm && bm.winner !== l.id) {
        L.push(i + '. ' + name + ' — duplicate panel photo (merged, billed once)');
      } else if (bm) {
        const h = lineHours(billingCls(l.cls.panel, bm), rates);
        const sevW = sevWord(bm.sev);
        if (h.pdr) {
          L.push(i + '. ' + name + ' — ' + l.cls.damage_type.replace(/_/g, ' ') + ', ' + sevW + ' — PDR');
          L.push('   Paintless dent repair, flat rate' + (h.ri > 0 ? ' · R&I ' + fmt1(h.ri) : ''));
        } else {
          const wb = bodyAlloc(l.cls.panel, bm, rates).byId[l.id];
          L.push(i + '. ' + name + ' — ' + l.cls.damage_type.replace(/_/g, ' ') + ', ' + sevW + (bm.paint ? ', paint' : ''));
          L.push('   Body ' + fmt1(wb != null ? wb : h.b) + ' · Paint ' + fmt1(h.p) + ' · R&I ' + fmt1(h.ri) + (h.capped ? ' (capped at ' + fmt1(h.cap) + ' hr max)' : ''));
        }
      }
    }
    i++;
  }
  L.push('');
  if (rates.showPricing) {
    L.push('Body repair   ' + fmt1(t.B) + ' hr × $' + rn(d.body) + ' = ' + usd(t.usdB));
    L.push('Paint refinish ' + fmt1(t.P) + ' hr × $' + rn(d.paint) + ' = ' + usd(t.usdP) + (t.overlap > 0 ? ' (incl. −' + fmt1(t.overlap) + ' hr blend overlap)' : ''));
    L.push('R&I           ' + fmt1(t.RI) + ' hr × $' + rn(d.ri) + ' = ' + usd(t.usdRI));
    if (t.usdPDR > 0) L.push('PDR — paintless repair, flat ' + usd(t.usdPDR));
    L.push('TOTAL ' + fmt1(t.hrs) + ' HR — ' + usd(t.usd));
  } else {
    L.push('Body repair   ' + fmt1(t.B) + ' hr');
    L.push('Paint refinish ' + fmt1(t.P) + ' hr' + (t.overlap > 0 ? ' (incl. −' + fmt1(t.overlap) + ' hr blend overlap)' : ''));
    L.push('R&I           ' + fmt1(t.RI) + ' hr');
    if (t.usdPDR > 0) L.push('PDR — paintless repair, flat rate');
    L.push('TOTAL ' + fmt1(t.hrs) + ' HR');
  }
  if (t.flagged > 0) L.push('(' + t.flagged + ' photo' + (t.flagged > 1 ? 's' : '') + ' flagged for review, excluded)');
  if ((notes || '').trim()) { L.push(''); L.push('NOTES: ' + notes.trim()); }
  const K = keep || {};
  if (K.tires || K.wheels || K.set) {
    L.push('');
    L.push('KEEP: ' + [K.tires && 'Tires', K.wheels && 'Wheels', K.set && 'Set'].filter(Boolean).join(', '));
  }
  if ((flags || []).length) {
    L.push('');
    L.push('FLAGS: ' + flags.map((f) => flagDef(rates, f.id).label + (f.done ? ' ✓' : '')).join(', '));
  }
  L.push('');
  L.push('Hours from Truck Ranch fixed rate table — same classification = same hours.');
  return L.join('\n');
}

function copyFallback(txt) {
  try {
    const ta = document.createElement('textarea');
    ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}
function copySummary(txt, showToast) {
  const done = () => showToast && showToast('Quote summary copied');
  const fail = () => showToast && showToast('Copy failed on this device');
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(done, () => (copyFallback(txt) ? done() : fail()));
    } else { copyFallback(txt) ? done() : fail(); }
  } catch { fail(); }
}

// Per-line "work to be performed" bullets (ported from workDesc).
function workDesc(cls, h) {
  const ops = [];
  const dmg = (cls.damage_type || '').replace(/_/g, ' ');
  if (h && h.pdr) {
    ops.push('Paintless dent repair (PDR) — flat rate, no body/paint labor');
    if (h.riList && h.riList.length) ops.push('R&I: ' + h.riList.map((r) => r.part.replace(/_/g, ' ') + ' (' + fmt1(r.hrs) + ' hr)').join(', '));
    if (cls.notes) ops.push('“' + cls.notes + '”');
    return ops;
  }
  if (cls.severity === 'replace') ops.push('Replace panel' + (dmg && dmg !== 'missing part' ? ' (' + dmg + ')' : ''));
  else ops.push('Repair ' + (dmg || 'damage') + ' — ' + sevWord(cls.severity) + ' damage');
  if (h && h.capped) ops.push('Hours capped at panel max (' + fmt1(h.cap || 0) + ' hr body + paint)');
  if (cls.paint_damaged) {
    ops.push(h.partial ? 'Partial refinish (spot paint)' : 'Refinish panel (full paint)');
    if (h.blends && h.blends.length) ops.push('Blend adjacent: ' + h.blends.map((b) => panelLabel(b.panel) + ' (+' + fmt1(b.hrs) + ' hr)').join(', '));
  } else ops.push('No refinish needed');
  if (h.riOverridden) ops.push('R&I — adjusted to ' + fmt1(h.ri) + ' hr' + (h.riList && h.riList.length ? ' (' + h.riList.map((r) => r.part.replace(/_/g, ' ')).join(', ') + ')' : ''));
  else if (h.riList && h.riList.length) ops.push('R&I: ' + h.riList.map((r) => r.part.replace(/_/g, ' ') + ' (' + fmt1(r.hrs) + ' hr)').join(', '));
  if (cls.notes) ops.push('“' + cls.notes + '”');
  return ops;
}

// Compute the per-line worksheet rows shared by the image and print views
// (ported from exportImage's row loop).
function quoteRows(lines, rates) {
  const bmap = billingMap(lines);
  const d = rates.dollars;
  const rows = [];
  let pidx = 0;
  for (const l of lines) {
    if (l.status !== 'done' || !l.cls) continue;
    pidx++;
    const name = panelLabel(l.cls.panel);
    if (l.review) { rows.push({ idx: pidx, panel: name, thumb: l.thumb, ops: ['NEEDS HUMAN REVIEW — not quoted; classify manually before writing the RO'], flag: true }); continue; }
    const bm = bmap[l.cls.panel];
    const isW = !!(bm && bm.winner === l.id);
    const isX = !!(bm && (bm.extras || []).some((x) => x.id === l.id));
    if (bm && !isW && !isX) { rows.push({ idx: pidx, panel: name, thumb: l.thumb, ops: ['Duplicate photo of this panel — billed on the panel line above'], dim: true }); continue; }
    const alloc = bm ? bodyAlloc(l.cls.panel, bm, rates) : null;
    if (isX) {
      const xb = alloc && alloc.byId[l.id] != null ? alloc.byId[l.id] : 0;
      rows.push({ idx: pidx, panel: name, thumb: l.thumb, ops: ['Separate damage area on this panel — body hours added (paint & R&I billed on the panel line above)'], b: xb, isX: true, tot: xb, usd: Math.round(xb * rn(d.body)) });
      continue;
    }
    const cls = bm ? { ...billingCls(l.cls.panel, bm), damage_type: l.cls.damage_type, notes: l.cls.notes } : l.cls;
    const h = lineHours(cls, rates);
    const wb = alloc && alloc.byId[l.id] != null ? alloc.byId[l.id] : h.b;
    rows.push(h.pdr ? {
      idx: pidx, panel: name, thumb: l.thumb, ops: workDesc(cls, h), b: 0, p: 0, ri: h.ri, tot: h.ri, isPdr: true, usd: Math.round(rn(h.pdrUsd) + h.ri * rn(d.ri)),
    } : {
      idx: pidx, panel: name, thumb: l.thumb, ops: workDesc(cls, h), b: wb, p: h.p, ri: h.ri, tot: Math.round((wb + h.p + h.ri) * 10) / 10, usd: Math.round(wb * rn(d.body) + h.p * rn(d.paint) + h.ri * rn(d.ri)),
    });
  }
  return rows;
}

// ---------- canvas image export (ported from exportImage) ----------
function exportImage(ctx0, showToast) {
  const { lines, rates, veh, vehicleText, stock, miles, vin, estimator } = ctx0;
  try {
    const t = quoteTotals(lines, rates);
    const SP = !!rates.showPricing;
    const d = rates.dollars;
    const vehTitle = (veh && [veh.year, veh.make, veh.model, veh.trim].filter(Boolean).join(' ')) || vehicleText || 'Vehicle';
    const dISO = new Date().toISOString();
    const rows = quoteRows(lines, rates);
    const W = 1240, M = 46, scale = 2, TH_W = 92, TH_H = 69;
    const cThumb = M, cPanel = M + TH_W + 16, cWork = M + 300,
      wWork = SP ? 440 : 460,
      cB = SP ? 858 : 920, cP = SP ? 938 : 1010, cRI = SP ? 1010 : 1088, cHr = SP ? 1088 : W - M, cUsd = W - M;
    const meas = document.createElement('canvas').getContext('2d');
    const wrap = (ctx, text, maxW, font) => {
      ctx.font = font;
      const words = String(text).split(' '); const out = []; let cur = '';
      for (const w of words) {
        const test = cur ? cur + ' ' + w : w;
        if (ctx.measureText(test).width > maxW && cur) { out.push(cur); cur = w; } else cur = test;
      }
      if (cur) out.push(cur);
      return out;
    };
    const opFont = '20px Barlow, Arial, sans-serif';
    let bodyH = 0;
    const rowLayouts = rows.map((r) => {
      const ls = [];
      for (const op of r.ops) for (const ln of wrap(meas, '• ' + op, wWork, opFont)) ls.push(ln);
      const rh = Math.max(r.thumb ? TH_H + 26 : 34, 30 + ls.length * 26 + 12);
      bodyH += rh;
      return { lines: ls, rh };
    });
    const H = 280 + 46 + bodyH + 220 + (SP ? 120 : 0) + (t.overlap > 0 ? 50 : 0) + (t.flagged > 0 ? 40 : 0);
    const loadThumb = (src) => new Promise((resolve) => {
      if (!src) return resolve(null);
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => resolve(null);
      im.src = src;
    });
    Promise.all(rows.map((r) => loadThumb(r.thumb))).then((thumbs) => {
      try {
        const cv = document.createElement('canvas');
        cv.width = W * scale; cv.height = H * scale;
        const ctx = cv.getContext('2d');
        ctx.scale(scale, scale);
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = '#1a1a1a';
        ctx.font = '700 40px "Barlow Condensed", Arial, sans-serif';
        ctx.fillText('TRUCK RANCH — PAINT & BODY', M, 66);
        ctx.font = '600 22px "Barlow Condensed", Arial, sans-serif';
        ctx.fillStyle = '#6b6357';
        ctx.fillText('REPAIR ORDER WORKSHEET', M, 96);
        ctx.textAlign = 'right';
        ctx.font = '20px "IBM Plex Mono", monospace';
        ctx.fillText(dateDisp(dISO), W - M, 66);
        ctx.textAlign = 'left';
        ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(M, 112); ctx.lineTo(W - M, 112); ctx.stroke();
        ctx.font = '600 21px Barlow, Arial, sans-serif'; ctx.fillStyle = '#1a1a1a';
        ctx.fillText('Vehicle: ' + vehTitle + '    Stock #: ' + (stock || '—') + '    Miles: ' + (miles || '—'), M, 148);
        ctx.fillText('VIN: ' + (vin || '—') + '    Estimator: ' + (estimator || '—'), M, 178);
        ctx.font = '600 19px Barlow, Arial, sans-serif'; ctx.fillStyle = '#6b6357';
        ctx.fillText('All figures are labor hours for RO entry.', M, 208);
        let y = 252;
        ctx.font = '700 19px "Barlow Condensed", Arial, sans-serif'; ctx.fillStyle = '#6b6357';
        ctx.fillText('PHOTO', cThumb, y);
        ctx.fillText('PANEL', cPanel, y);
        ctx.fillText('WORK TO BE PERFORMED', cWork, y);
        ctx.textAlign = 'right';
        ctx.fillText('BODY', cB, y); ctx.fillText('PAINT', cP, y); ctx.fillText('R&I', cRI, y); ctx.fillText('TOTAL HRS', cHr, y);
        if (SP) ctx.fillText('USD', cUsd, y);
        ctx.textAlign = 'left';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(M, y + 12); ctx.lineTo(W - M, y + 12); ctx.stroke();
        y += 16;
        rows.forEach((r, i) => {
          const LY = rowLayouts[i];
          const rowTop = y + 14;
          let ry = y + 34;
          const im = thumbs[i];
          if (im) {
            try { ctx.drawImage(im, cThumb, rowTop, TH_W, TH_H); } catch { /* skip */ }
            ctx.strokeStyle = '#d9d2c4'; ctx.lineWidth = 1;
            ctx.strokeRect(cThumb + 0.5, rowTop + 0.5, TH_W - 1, TH_H - 1);
            ctx.strokeStyle = '#1a1a1a';
          }
          ctx.fillStyle = r.flag ? '#7a5c10' : '#1a1a1a';
          ctx.font = '700 23px Barlow, Arial, sans-serif';
          for (const pl of wrap(ctx, r.idx + '. ' + r.panel, cWork - cPanel - 16, '700 23px Barlow, Arial, sans-serif')) { ctx.fillText(pl, cPanel, ry); ry += 27; }
          ry = y + 34;
          ctx.font = opFont;
          ctx.fillStyle = r.flag ? '#7a5c10' : r.dim ? '#857d70' : '#3a352c';
          let oy = ry;
          for (const ln of LY.lines) { ctx.fillText(ln, cWork, oy); oy += 26; }
          if (r.tot != null) {
            ctx.textAlign = 'right';
            ctx.font = '21px "IBM Plex Mono", monospace'; ctx.fillStyle = '#1a1a1a';
            ctx.fillText(fmt1(r.b), cB, ry);
            ctx.fillText(r.isX ? '—' : fmt1(r.p), cP, ry);
            ctx.fillText(r.isX ? '—' : fmt1(r.ri), cRI, ry);
            ctx.font = '700 21px "IBM Plex Mono", monospace';
            ctx.fillText(fmt1(r.tot), cHr, ry);
            if (SP && r.usd != null) ctx.fillText(usd(r.usd), cUsd, ry);
            ctx.textAlign = 'left';
          }
          y += LY.rh;
          ctx.strokeStyle = '#ddd'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(M, y + 6); ctx.lineTo(W - M, y + 6); ctx.stroke();
          ctx.strokeStyle = '#1a1a1a';
        });
        if (t.overlap > 0) {
          ctx.font = '600 20px Barlow, Arial, sans-serif'; ctx.fillStyle = '#6b6357';
          ctx.fillText('Blend overlap credit — adjacent panels painted together', cThumb, y + 30);
          ctx.textAlign = 'right'; ctx.fillStyle = '#1a1a1a';
          ctx.font = '700 21px "IBM Plex Mono", monospace';
          ctx.fillText('−' + fmt1(t.overlap) + ' hr', cHr, y + 30);
          ctx.textAlign = 'left';
          y += 44;
          ctx.strokeStyle = '#ddd'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(M, y + 6); ctx.lineTo(W - M, y + 6); ctx.stroke();
          ctx.strokeStyle = '#1a1a1a';
        }
        y += 50;
        ctx.font = '600 22px Barlow, Arial, sans-serif'; ctx.fillStyle = '#1a1a1a';
        const cVal = SP ? cUsd : cHr;
        const sub = (label, val) => {
          ctx.fillStyle = '#6b6357'; ctx.fillText(label, cWork, y);
          ctx.textAlign = 'right'; ctx.fillStyle = '#1a1a1a'; ctx.fillText(val, cVal, y); ctx.textAlign = 'left';
          y += 32;
        };
        if (SP) {
          sub('Body repair — ' + fmt1(t.B) + ' hr × $' + rn(d.body), usd(t.usdB));
          sub('Paint refinish — ' + fmt1(t.P) + ' hr × $' + rn(d.paint) + (t.overlap > 0 ? ' (−' + fmt1(t.overlap) + ' hr blend overlap)' : ''), usd(t.usdP));
          sub('R&I — ' + fmt1(t.RI) + ' hr × $' + rn(d.ri), usd(t.usdRI));
          if (t.usdPDR > 0) sub('PDR — paintless repair, flat', usd(t.usdPDR));
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(cWork, y - 18); ctx.lineTo(cUsd, y - 18); ctx.stroke();
          ctx.font = '700 30px "Barlow Condensed", Arial, sans-serif';
          ctx.fillText('TOTAL ' + fmt1(t.hrs) + ' HR', cWork, y + 16);
          ctx.textAlign = 'right'; ctx.fillText(usd(t.usd), cUsd, y + 16); ctx.textAlign = 'left';
          y += 56;
          const paintAmt = Math.round(t.usd * 0.30), suppliesAmt = Math.round(t.usd * 0.05), laborAmt = t.usd - paintAmt - suppliesAmt;
          ctx.font = '700 19px "Barlow Condensed", Arial, sans-serif'; ctx.fillStyle = '#6b6357';
          ctx.fillText('RATE BREAKDOWN — FOR RO ENTRY', cWork, y);
          y += 30;
          ctx.font = '600 21px Barlow, Arial, sans-serif';
          const bd = (label, val) => {
            ctx.fillStyle = '#6b6357'; ctx.fillText(label, cWork, y);
            ctx.textAlign = 'right'; ctx.fillStyle = '#1a1a1a'; ctx.fillText(val, cUsd, y); ctx.textAlign = 'left';
            y += 30;
          };
          bd('Labor (65%)', usd(laborAmt));
          bd('Paint materials (30%)', usd(paintAmt));
          bd('Shop supplies (5%)', usd(suppliesAmt));
        } else {
          sub('Body repair', fmt1(t.B) + ' hr');
          sub('Paint refinish' + (t.overlap > 0 ? ' (−' + fmt1(t.overlap) + ' hr blend overlap)' : ''), fmt1(t.P) + ' hr');
          sub('R&I', fmt1(t.RI) + ' hr');
          if (t.usdPDR > 0) sub('PDR — paintless repair', 'flat rate');
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(cWork, y - 18); ctx.lineTo(cHr, y - 18); ctx.stroke();
          ctx.font = '700 30px "Barlow Condensed", Arial, sans-serif';
          ctx.fillText('TOTAL', cWork, y + 16);
          ctx.textAlign = 'right'; ctx.fillText(fmt1(t.hrs) + ' HR', cHr, y + 16); ctx.textAlign = 'left';
          y += 56;
        }
        if (t.flagged > 0) {
          y += 22;
          ctx.font = '600 19px Barlow, Arial, sans-serif'; ctx.fillStyle = '#7a5c10';
          ctx.fillText(t.flagged + ' photo' + (t.flagged === 1 ? '' : 's') + ' flagged for human review — excluded from totals.', M, y);
        }
        const stockName = (stock || vin || 'quote').replace(/[^A-Za-z0-9-]+/g, '');
        const fname = 'paint-body-quote-' + (stockName || 'quote') + '-' + dISO.slice(0, 10) + '.png';
        const deliver = (url, revoke) => {
          const a = document.createElement('a');
          const canDownload = 'download' in a;
          if (canDownload) {
            a.href = url; a.download = fname;
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            showToast && showToast('Quote image saved — upload it to MDD');
          } else {
            window.open(url, '_blank');
            showToast && showToast('Image opened — press and hold to save, then upload to MDD');
          }
          if (revoke) setTimeout(() => URL.revokeObjectURL(url), 10000);
        };
        const shareIt = (blob) => {
          try {
            if (!blob || !navigator.share || !navigator.canShare) return false;
            const file = new File([blob], fname, { type: 'image/png' });
            if (!navigator.canShare({ files: [file] })) return false;
            navigator.share({ files: [file], title: 'Paint & Body Quote' })
              .then(() => showToast && showToast('Shared — attach it to the MDD card'))
              .catch((err) => { if (!err || err.name !== 'AbortError') deliver(URL.createObjectURL(blob), true); });
            return true;
          } catch { return false; }
        };
        const isTouch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
        if (cv.toBlob) {
          cv.toBlob((blob) => {
            if (blob) { if (!(isTouch && shareIt(blob))) deliver(URL.createObjectURL(blob), true); }
            else deliver(cv.toDataURL('image/png'), false);
          }, 'image/png');
        } else {
          deliver(cv.toDataURL('image/png'), false);
        }
      } catch { showToast && showToast('Image export failed'); }
    });
  } catch { showToast && showToast('Image export failed'); }
}

// Downscale a file to a base64 JPEG for classify (no data: prefix) and a
// data-URL for photo upload / thumbnail — mirrors the old scaleImage().
function scaleImage(file, max, q) {
  return new Promise((resolve, reject) => {
    const rd = new FileReader();
    rd.onload = () => {
      const img = new Image();
      img.onload = () => {
        try {
          const r = Math.min(1, max / Math.max(img.width, img.height));
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(img.width * r));
          c.height = Math.max(1, Math.round(img.height * r));
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL('image/jpeg', q));
        } catch (e) {
          reject(e);
        }
      };
      img.onerror = () => reject(new Error('Could not read that image'));
      img.src = rd.result;
    };
    rd.onerror = () => reject(new Error('Could not read that file'));
    rd.readAsDataURL(file);
  });
}

function thumbFromDataUrl(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const r = Math.min(1, 340 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * r)); c.height = Math.max(1, Math.round(img.height * r));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', 0.7));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

export default function QuoteScreen({ prefill, onClose, showToast, onQuoteId }) {
  // Hours-only display: dollar amounts are computed internally (tracker sync
  // needs them) but never shown — the quote total is the total hours of work.
  const [rates, setRates] = useState(() => ({ ...defaultRates(), showPricing: false }));
  const corrCacheRef = useRef([]);

  const [step, setStep] = useState('vin'); // vin | confirm | photos | analyze | quote
  const [scanning, setScanning] = useState(false);

  const [vin, setVin] = useState(() => String(prefill?.vin || '').toUpperCase());
  const [vinOverridden, setVinOverridden] = useState(false);
  const [veh, setVeh] = useState({ year: '', make: '', model: '', trim: '', body: '' });
  const [vehicleText, setVehicleText] = useState(() => prefill?.vehicle || '');
  const [decoding, setDecoding] = useState(false);
  const [decodeFailed, setDecodeFailed] = useState(false);

  const [stock, setStock] = useState(() => prefill?.stock || '');
  const [estimator, setEstimator] = useState(() => prefill?.estimator || '');
  const [miles, setMiles] = useState(() => prefill?.miles || '');

  const [quoteId, setQuoteId] = useState(() => prefill?.quoteId || null);
  const [committed, setCommitted] = useState(null); // { committedBy, overriddenBy } once signed
  const [lines, setLines] = useState([]);
  // photos not yet analyzed: { id, thumb, base64, dataUrl }
  const [photos, setPhotos] = useState([]);
  const [walkOpen, setWalkOpen] = useState(false);
  // Every photo already saved on the server for this quote — walk-arounds and
  // damage close-ups alike — so a reopened quote shows the full photo set.
  const [serverPhotos, setServerPhotos] = useState([]);
  const [lightbox, setLightbox] = useState(null);
  useEffect(() => {
    if (!quoteId || walkOpen) return;
    let live = true;
    api.quotePhotos(quoteId).then((j) => { if (live) setServerPhotos(j?.photos || []); }).catch(() => {});
    return () => { live = false; };
  }, [quoteId, walkOpen, photos.length]);
  const [walkInitialMode, setWalkInitialMode] = useState('guided');
  // Flags / keep / notes (ported from the old app — persisted with the quote)
  const [flags, setFlags] = useState(() => (Array.isArray(prefill?.flags) ? prefill.flags.map((f) => ({ id: f.id, done: !!f.done })) : []));
  const [keep, setKeep] = useState(() => ({ tires: !!prefill?.keep?.tires, wheels: !!prefill?.keep?.wheels, set: !!prefill?.keep?.set }));
  const [notes, setNotes] = useState(() => prefill?.notes || '');
  const [notesOpen, setNotesOpen] = useState(false);
  const [flagPick, setFlagPick] = useState(false);
  const [flagSearch, setFlagSearch] = useState('');
  const [armedDelete, setArmedDelete] = useState(null);
  const [hydrating, setHydrating] = useState(!!prefill?.quoteId);
  const [hydrateError, setHydrateError] = useState('');
  const hydratedRef = useRef(!prefill?.quoteId);
  // Snapshot prefill in a ref: hydration must run only when the quote id
  // changes, not every time the parent re-renders with fresh prefill fields
  // (that would clobber in-progress edits here).
  const prefillRef = useRef(prefill);
  prefillRef.current = prefill;
  useEffect(() => { prefetchZxing(); }, []); // warm the barcode decoder before the scanner opens
  useEffect(() => { if (committed) setWalkOpen(false); }, [committed]);
  useEffect(() => {
    if (!prefill?.quoteId) return;
    let live = true;
    api.quoterSync().then((s) => {
      const p = prefillRef.current || {};
      const q = (s?.quotes || []).find((x) => x && x.id === p.quoteId);
      if (!live) return;
      if (!q) {
        // The intake linked a quote id but no quote was ever saved under it
        // (photos-only so far). That's a fresh quote, not an error — keep the
        // prefill and drop the tech straight where they need to be.
        hydratedRef.current = true; setHydrating(false);
        setStep(p.startAtPhotos && (p.stock || '').trim() && (p.estimator || '').trim() ? 'photos' : 'confirm');
        return;
      }
      setVin(String(q.vin || p.vin || '').toUpperCase());
      setStock(q.stock || p.stock || ''); setMiles(q.miles || p.miles || '');
      setEstimator(q.estimator || p.estimator || ''); setVehicleText(q.vehicle || p.vehicle || '');
      setVeh(q.veh || { year: '', make: '', model: '', trim: '', body: '' });
      setFlags(Array.isArray(q.flags) ? q.flags.map((f) => ({ id: f.id, done: !!f.done })) : []);
      setKeep({ tires: !!(q.keep && q.keep.tires), wheels: !!(q.keep && q.keep.wheels), set: !!(q.keep && q.keep.set) });
      setNotes(q.notes || '');
      const restored = Array.isArray(q.lines) ? q.lines.map((l) => ({ ...l, status: l.status || 'done', base64: '', thumb: l.thumb || '' })) : [];
      if (q.committedBy) setCommitted({ committedBy: q.committedBy, overriddenBy: q.overriddenBy || null });
      setLines(restored);
      setStep(restored.length ? 'quote' : (!q.committedBy && p.startAtPhotos && (q.stock || p.stock || '').trim() && (q.estimator || p.estimator || '').trim() ? 'photos' : 'confirm'));
      hydratedRef.current = true; setHydrating(false);
    }).catch(() => { if (live) { setHydrateError('Could not load the saved quote. It was not opened for editing.'); setHydrating(false); } });
    return () => { live = false; };
  }, [prefill?.quoteId]);

  const linesRef = useRef(lines);
  linesRef.current = lines;
  const fileRef = useRef(null);

  // ---------- load server rates + corrections (read-only) ----------
  useEffect(() => {
    let live = true;
    api.quoterSync().then((s) => {
      if (!live || !s) return;
      if (s.rates) setRates((r) => ({ ...r, ...s.rates, showPricing: false }));
      if (Array.isArray(s.corrections)) corrCacheRef.current = s.corrections;
    }).catch(() => { /* offline — defaults stand */ });
    return () => { live = false; };
  }, []);

  // ---------- VIN decode (NHTSA vPIC) ----------
  const runDecode = useCallback(async (v) => {
    setDecoding(true);
    setDecodeFailed(false);
    try {
      const res = await fetch('https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/' + encodeURIComponent(v) + '?format=json');
      const j = await res.json();
      const r = (j.Results && j.Results[0]) || {};
      const tc = (s) => String(s || '').toLowerCase().replace(/(^|[\s-])[a-z]/g, (c) => c.toUpperCase());
      const nv = { year: r.ModelYear || '', make: tc(r.Make), model: r.Model || '', trim: r.Trim || '', body: r.BodyClass || '' };
      if (!nv.year && !nv.make && !nv.model) throw new Error('empty');
      setVeh(nv);
      const desc = [nv.year, nv.make, nv.model, nv.trim].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      setVehicleText((cur) => (cur && cur.trim() ? cur : desc));
      setDecoding(false);
    } catch {
      // fall back to the shared decoder (best-effort) then flag failure
      const desc = await decodeVinInfo(v).catch(() => null);
      if (desc) {
        setVehicleText((cur) => (cur && cur.trim() ? cur : desc));
        setDecoding(false);
      } else {
        setDecoding(false);
        setDecodeFailed(true);
      }
    }
  }, []);

  const acceptVin = useCallback((v, overridden) => {
    const clean = String(v || '').toUpperCase();
    setVin(clean);
    setVinOverridden(!!overridden);
    setStep('confirm');
    setScanning(false);
    if (clean.length === 17) runDecode(clean);
  }, [runDecode]);

  const onScannerHit = (raw, ok) => {
    setScanning(false);
    acceptVin(raw, !ok);
  };

  const submitManualVin = () => {
    const v = vin.trim().toUpperCase();
    if (v.length !== 17) { showToast && showToast('A VIN is 17 characters'); return; }
    acceptVin(v, !vinValid(v));
  };

  // ---------- autosave (debounced), mirrors old autosave() ----------
  const saveTimer = useRef(null);
  const stateRef = useRef({});
  // Live refs for the fields mutated imperatively (flags/keep/notes): kept in
  // sync inside the setState updaters so a commit or export right after a
  // change always reads the just-computed value, not the previous render's.
  const flagsRef = useRef(flags);
  const keepRef = useRef(keep);
  const notesRef = useRef(notes);
  flagsRef.current = flags; keepRef.current = keep; notesRef.current = notes;
  stateRef.current = { quoteId, vin, stock, miles, veh, estimator, vehicleText, flags: flagsRef.current, keep: keepRef.current, notes: notesRef.current };
  // `overrides` carries the just-computed next snapshot for state the caller
  // has updated in the same tick (flags/keep/notes), because stateRef.current
  // still holds the PREVIOUS render's values until React re-renders.
  const buildEntry = useCallback((ls, overrides) => {
    const t = quoteTotals(ls, rates);
    const cover = (ls[0] && ls[0].thumb) || '';
    const s = mergeQuoteSnapshot(stateRef.current, overrides);
    const extras = quoteExtras(s);
    return {
      cover,
      id: s.quoteId,
      ts: Date.now(),
      vin: s.vin,
      stock: s.stock,
      miles: s.miles,
      veh: s.veh,
      vehicle: s.vehicleText,
      estimator: s.estimator,
      dateISO: new Date().toISOString(),
      lines: ls.map((l) => ({
        id: l.id, thumb: l.thumb,
        status: l.status === 'running' || l.status === 'queued' ? 'done' : l.status,
        cls: l.cls, review: l.review, manual: l.manual, errMsg: l.errMsg || '',
      })),
      totals: { hrs: t.hrs, usd: t.usd, B: t.B, P: t.P, RI: t.RI, usdPDR: t.usdPDR },
      // Old-app compatible extras — kept so imported quotes round-trip.
      notes: extras.notes,
      flags: extras.flags,
      keep: extras.keep,
    };
  }, [rates]);

  // Create the quote id at confirm (like the old app did on entering walk).
  const ensureQuoteId = useCallback(() => {
    let id = stateRef.current.quoteId;
    if (!id) { id = newId('q'); setQuoteId(id); onQuoteId?.(id); }
    return id;
  }, [onQuoteId]);

  // Every failed autosave produces a visible warning (never a silent loss);
  // repeat warnings are throttled to one per 15s so a burst of debounced
  // saves doesn't stack toasts. A success resets the notifier.
  const saveNotifierRef = useRef(null);
  if (!saveNotifierRef.current) saveNotifierRef.current = createSaveFailureNotifier((msg) => showToast && showToast(msg));
  const warnSaveFailed = useCallback((e) => saveNotifierRef.current.failed(e), []);

  const autosave = useCallback((ls, overrides) => {
    if (!hydratedRef.current) return;
    const s = { ...stateRef.current, ...(overrides || {}) };
    if (!s.quoteId) {
      // Flags/keep/notes can now be edited on the confirm & photos pages
      // before any photo exists — create the quote id so the edit persists.
      const id = ensureQuoteId();
      overrides = { ...(overrides || {}), quoteId: id };
    }
    const entry = buildEntry(ls != null ? ls : linesRef.current, overrides);
    if (!entry.id) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      api.putQuote({ id: entry.id, data: entry })
        .then(() => { saveNotifierRef.current.succeeded(); })
        .catch(warnSaveFailed);
    }, 600);
  }, [buildEntry, ensureQuoteId, warnSaveFailed]);

  useEffect(() => () => clearTimeout(saveTimer.current), []);

  const goToPhotos = () => {
    ensureQuoteId();
    setStep('photos');
  };

  // ---------- damage photo capture ----------
  const deletedPhotoIdsRef = useRef(new Set()); // captures the inspector deleted — never upload these
  const uploadDamagePhoto = (job) => uploadDamagePhotoDurably(job, showToast, (id) => deletedPhotoIdsRef.current.has(id));

  const addDamageFiles = async (ev) => {
    if (committed) return;
    const list = ev.target.files ? [...ev.target.files] : [];
    ev.target.value = '';
    if (!list.length) return;
    const qid = ensureQuoteId();
    for (const f of list) {
      try {
        const big = await scaleImage(f, 1100, 0.82);
        const thumb = await compressImageFile(f);
        const id = newId('p');
        setPhotos((prev) => [...prev, { id, thumb, base64: big.split(',')[1], dataUrl: big }]);
        // Each damage photo becomes a quote line — upload it tied to the quote.
        uploadDamagePhoto({ id, quoteId: qid, slot: 'dmg' + Date.now(), dataUrl: big });
      } catch {
        showToast && showToast('Could not read that image');
      }
    }
  };

  const removePhoto = (id) => {
    if (committed) return;
    if (armedDelete !== id) {
      setArmedDelete(id);
      setTimeout(() => setArmedDelete((v) => (v === id ? null : v)), 3000);
      showToast && showToast('Tap again to delete this damage photo');
      return;
    }
    setArmedDelete(null);
    setPhotos((prev) => prev.filter((p) => p.id !== id));
    deletedPhotoIdsRef.current.add(id); // cancels any in-flight/queued upload of this capture
    purgeDeletedDamagePhoto(id);
  };

  const addDamageDataUrl = async (dataUrl) => {
    if (committed) return;
    const qid = ensureQuoteId();
    const id = newId('w');
    const thumb = await thumbFromDataUrl(dataUrl);
    setPhotos((prev) => [...prev, { id, thumb, base64: dataUrl.split(',')[1], dataUrl }]);
    await uploadDamagePhoto({ id, quoteId: qid, slot: 'dmg', dataUrl });
  };

  // ---------- analyze pipeline ----------
  const setLine = useCallback((id, patch) => {
    setLines((prev) => {
      const next = prev.map((l) => (l.id === id ? { ...l, ...patch } : l));
      return next;
    });
  }, []);

  const classifyLine = useCallback(async (id, base64) => {
    setLine(id, { status: 'running', errMsg: '' });
    if (!base64) {
      setLine(id, { status: 'error', errMsg: 'Photo is no longer in memory — delete this line and retake it.' });
      return;
    }
    try {
      const out = await api.classify({
        image: base64,
        system: sysPrompt(corrCacheRef.current),
        prompt: CLASSIFY_PROMPT,
        model: CLASSIFY_MODEL,
        max_tokens: CLASSIFY_MAX_TOKENS,
      });
      const text = out && typeof out.text === 'string' ? out.text : '';
      const cls = parseCls(text);
      if (!cls) {
        setLine(id, { status: 'done', cls: null, review: true, open: true, editing: false });
        autosave();
        return;
      }
      const review = cls.confidence === 'low' || cls.panel === 'unknown';
      // A second photo of an already-classified panel = separate damage area.
      if (cls.panel !== 'unknown' && linesRef.current.some((x) => x.id !== id && x.status === 'done' && x.cls && x.cls.panel === cls.panel)) {
        cls.extra_area = true;
      }
      setLine(id, { status: 'done', cls, review, open: review, editing: false, aiCls: JSON.parse(JSON.stringify(cls)), corrLogged: false });
      autosave();
    } catch (e) {
      // 503 = AI not configured: send the line to manual classification
      // instead of failing the whole flow.
      if (e && e.status === 503) {
        setLine(id, { status: 'done', cls: null, review: true, manual: true, open: true, editing: true });
        autosave();
        return;
      }
      setLine(id, { status: 'error', errMsg: 'AI call failed: ' + String(e && e.message ? e.message : e).slice(0, 120) + ' — tap RE-RUN.' });
    }
  }, [setLine, autosave]);

  const busyRef = useRef(false);
  const runQueue = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    // Snapshot the queued ids together with their image bytes.
    const queued = linesRef.current.filter((l) => l.status === 'queued');
    for (const l of queued) {
      await classifyLine(l.id, l.base64);
      await new Promise((r) => setTimeout(r, 350));
    }
    busyRef.current = false;
    setStep('quote');
    autosave();
  }, [classifyLine, autosave]);

  const startAnalyze = () => {
    if (busyRef.current) return;
    if (!photos.length) return;
    ensureQuoteId();
    const newLines = photos.map((p) => ({
      id: p.id, thumb: p.thumb, base64: p.base64,
      status: 'queued', cls: null, review: false, manual: false, open: false, editing: false, errMsg: '',
    }));
    setLines((prev) => [...prev, ...newLines]);
    setPhotos([]);
    setStep('analyze');
  };

  // Kick the queue once the analyze step has lines queued.
  useEffect(() => {
    if (step === 'analyze' && !busyRef.current && lines.some((l) => l.status === 'queued')) {
      runQueue();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, lines]);

  const rerunLine = (id) => {
    const l = linesRef.current.find((x) => x.id === id);
    if (l) classifyLine(id, l.base64);
  };

  const deleteLine = (id) => {
    setLines((prev) => {
      const next = prev.filter((l) => l.id !== id);
      autosave(next);
      return next;
    });
    api.deleteQuotePhoto({ id }).catch(() => {});
  };

  // ---------- line editor ----------
  const editBase = (l) => {
    const c = l.cls || {};
    return l.edit || {
      panel: c.panel || 'unknown', damage: c.damage_type || 'dent', sev: c.severity || 'moderate',
      paint: c.paint_damaged !== false, pdr: !!c.pdr, blend: !!c.blend_adjacent_recommended,
      partial: !!c.paint_partial, extra: !!c.extra_area,
      ri: (c.ri_override != null ? String(c.ri_override) : ''),
      bh: (c.b_override != null ? String(c.b_override) : ''),
      ph: (c.p_override != null ? String(c.p_override) : ''),
      notes: (c.notes || ''),
    };
  };
  const setEdit = (id, key, val) => {
    setLines((prev) => prev.map((l) => {
      if (l.id !== id) return l;
      const base = editBase(l);
      return { ...l, edit: { ...base, [key]: val } };
    }));
  };
  const startEdit = (id) => {
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, open: true, editing: true, edit: editBase(l) } : l)));
  };
  const cancelEdit = (id) => {
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, editing: false, edit: undefined, open: !!l.review } : l)));
  };

  const applyEdit = (id) => {
    const cur = linesRef.current.find((x) => x.id === id);
    let diffs = [];
    if (cur && cur.aiCls && !cur.corrLogged) {
      const e0 = editBase(cur);
      diffs = correctionDiffs(cur.aiCls, { panel: e0.panel, damage_type: e0.damage, severity: e0.sev, paint_damaged: !!e0.paint, blend_adjacent_recommended: !!e0.blend });
    }
    if (diffs.length) {
      api.postCorrection({ ts: Date.now(), diffs }).catch(() => {});
      corrCacheRef.current = [{ ts: Date.now(), diffs }, ...corrCacheRef.current].slice(0, 200);
    }
    setLines((prev) => {
      const next = prev.map((l) => {
        if (l.id !== id) return l;
        const e = editBase(l);
        const c = l.cls || { ri_parts_needed: [], confidence: 'low', notes: '' };
        const cls = {
          ...c, panel: e.panel, damage_type: e.damage, severity: e.sev,
          paint_damaged: !!e.paint,
          pdr: !!e.pdr && pdrEligible({ damage_type: e.damage, paint_damaged: !!e.paint, severity: e.sev, panel: e.panel }),
          blend_adjacent_recommended: !!e.blend, paint_partial: !!e.partial, extra_area: !!e.extra,
          ri_parts_needed: c.ri_parts_needed || [], confidence: c.confidence || 'low',
          notes: String(e.notes != null ? e.notes : (c.notes || '')).slice(0, 220),
        };
        if (e.ri != null && String(e.ri).trim() !== '') { const ov = parseFloat(e.ri); if (isFinite(ov) && ov >= 0) cls.ri_override = ov; else delete cls.ri_override; } else { delete cls.ri_override; }
        if (e.bh != null && String(e.bh).trim() !== '') { const ov = parseFloat(e.bh); if (isFinite(ov) && ov >= 0) cls.b_override = ov; else delete cls.b_override; } else { delete cls.b_override; }
        if (e.ph != null && String(e.ph).trim() !== '') { const ov = parseFloat(e.ph); if (isFinite(ov) && ov >= 0) cls.p_override = ov; else delete cls.p_override; } else { delete cls.p_override; }
        return { ...l, cls, status: 'done', review: e.panel === 'unknown', manual: true, editing: false, edit: undefined, open: e.panel === 'unknown', errMsg: '', corrLogged: l.corrLogged || diffs.length > 0 };
      });
      autosave(next);
      return next;
    });
  };

  const togglePart = (id, part) => {
    setLines((prev) => {
      const next = prev.map((l) => {
        if (l.id !== id) return l;
        const c = l.cls || { ri_parts_needed: [] };
        const have = (c.ri_parts_needed || []).includes(part);
        const parts = have ? c.ri_parts_needed.filter((p) => p !== part) : [...(c.ri_parts_needed || []), part];
        return { ...l, cls: { ...c, ri_parts_needed: parts } };
      });
      autosave(next);
      return next;
    });
  };

  // ---------- flags / keep / notes ----------
  // Each mutator computes the explicit next value inside the setState updater
  // and hands that exact snapshot to autosave (overrides), so we never persist
  // the stale pre-render value from stateRef.
  const addFlag = useCallback((id) => {
    setFlags((prev) => {
      if (prev.some((f) => f.id === id)) return prev;
      const next = [...prev, { id, done: false }];
      flagsRef.current = next;
      autosave(null, { flags: next });
      return next;
    });
    setFlagPick(false); setFlagSearch('');
  }, [autosave]);
  const setFlagDone = useCallback((id, done) => {
    setFlags((prev) => {
      const next = prev.map((f) => (f.id === id ? { ...f, done } : f));
      flagsRef.current = next;
      autosave(null, { flags: next });
      return next;
    });
  }, [autosave]);
  const removeFlag = useCallback((id) => {
    setFlags((prev) => {
      const next = prev.filter((f) => f.id !== id);
      flagsRef.current = next;
      autosave(null, { flags: next });
      return next;
    });
  }, [autosave]);
  const toggleKeep = useCallback((k) => {
    setKeep((prev) => {
      const next = { ...prev, [k]: !prev[k] };
      keepRef.current = next;
      autosave(null, { keep: next });
      return next;
    });
  }, [autosave]);
  const onNotesChange = useCallback((v) => {
    const next = String(v || '').slice(0, 2000);
    notesRef.current = next;
    setNotes(next);
  }, []);
  const closeNotes = useCallback(() => {
    setNotesOpen(false);
    autosave(null, { notes: notesRef.current });
  }, [autosave]);

  const exportCtx = () => ({
    lines: linesRef.current, rates,
    veh: stateRef.current.veh, vehicleText: stateRef.current.vehicleText,
    stock: stateRef.current.stock, miles: stateRef.current.miles,
    vin: stateRef.current.vin, estimator: stateRef.current.estimator,
    notes: stateRef.current.notes, keep: stateRef.current.keep, flags: stateRef.current.flags,
  });
  const doCopy = () => copySummary(buildSummary(exportCtx()), showToast);
  const doImage = () => exportImage(exportCtx(), showToast);
  const doPrint = () => { try { window.print(); } catch { /* no-op */ } };

  // Quote-level commit was removed from the UI — the intake SAVE (PIN
  // sign-off) is the one commit button. Imported/legacy committed quotes
  // still render locked via `committed`.

  // ---------- render ----------
  const totals = quoteTotals(lines, rates);

  return (
    <div className="screen">
      <div className="screen-topbar" style={{ padding: '8px 14px 10px' }}>
        <div className="screen-title-row" style={{ padding: '4px 2px 6px' }}>
          <span
            onClick={onClose}
            style={{ fontSize: 20, color: 'var(--brown)', cursor: 'pointer', lineHeight: 1, flex: '0 0 auto' }}
          >
            ‹
          </span>
          <span className="screen-title" style={{ fontSize: 20 }}>Body Quoter</span>
          <span style={{ flex: 1 }} />
          <span className="mono" style={{ fontSize: 9.5, color: 'var(--muted)' }}>
            {step === 'quote' ? `${totals.hrs} hr` : (vin ? vin.slice(-8) : '')}
          </span>
        </div>
      </div>

      <div className="screen-body">
        {hydrateError && <div className="card" style={{color:'var(--red)',fontWeight:700}}>{hydrateError}<button className="btn btn-outline" style={{marginTop:9}} onClick={onClose}>Close</button></div>}
        {hydrating && <div className="card"><div className="card-title">LOADING SAVED QUOTE</div><div style={{marginTop:8,color:'var(--muted)'}}>Restoring quote details…</div></div>}
        {!hydrating && !hydrateError && <>
        {step === 'vin' && (
          <VinStep
            vin={vin}
            onVin={setVin}
            onScan={() => setScanning(true)}
            onManual={submitManualVin}
          />
        )}

        {step === 'confirm' && (
          <ConfirmStep
            vin={vin}
            vinOverridden={vinOverridden}
            decoding={decoding}
            decodeFailed={decodeFailed}
            vehicleText={vehicleText}
            onVehicle={setVehicleText}
            stock={stock}
            onStock={setStock}
            estimator={estimator}
            onEstimator={setEstimator}
            miles={miles}
            onMiles={setMiles}
            onBack={() => setStep('vin')}
            onNext={goToPhotos}
          />
        )}

        {step === 'photos' && (
          <PhotosStep
            photos={photos}
            damageFocus={!!prefill?.startAtPhotos}
            serverPhotos={serverPhotos}
            onEnlarge={setLightbox}
            lineCount={lines.length}
            committed={!!committed}
            armedDelete={armedDelete}
            onAdd={() => fileRef.current && fileRef.current.click()}
            onWalk={() => { ensureQuoteId(); setWalkInitialMode('guided'); setWalkOpen(true); }}
            onDamage={() => { ensureQuoteId(); setWalkInitialMode('damage'); setWalkOpen(true); }}
            onRemove={removePhoto}
            onAnalyze={startAnalyze}
            onBack={() => setStep('confirm')}
            onSeeQuote={lines.length ? () => setStep('quote') : null}
          />
        )}

        {/* Flags / Keep / Notes ride along on the vehicle-confirm and photos
            pages too, so they're always in reach — not only on the quote. */}
        {(step === 'confirm' || step === 'photos') && (
          <QuoteExtras
            rates={rates}
            locked={!!committed}
            flags={flags}
            keep={keep}
            notes={notes}
            notesOpen={notesOpen}
            flagPick={flagPick}
            flagSearch={flagSearch}
            onOpenNotes={() => setNotesOpen(true)}
            onCloseNotes={closeNotes}
            onNotesChange={onNotesChange}
            onFlagPickOpen={() => { setFlagPick(true); setFlagSearch(''); }}
            onFlagPickClose={() => setFlagPick(false)}
            onFlagSearch={setFlagSearch}
            onAddFlag={addFlag}
            onFlagDone={setFlagDone}
            onRemoveFlag={removeFlag}
            onToggleKeep={toggleKeep}
          />
        )}

        {step === 'analyze' && (
          <div className="card">
            <div className="card-title">ANALYZING DAMAGE</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
              Classifying each photo… {lines.filter((l) => l.status !== 'queued' && l.status !== 'running').length}/{lines.length}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
              {lines.map((l) => (
                <div key={l.id} style={{ position: 'relative', width: 64, height: 64, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border)' }}>
                  {l.thumb && <img src={l.thumb} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
                  <div style={{ position: 'absolute', inset: 0, background: l.status === 'running' ? 'rgba(206,27,27,0.25)' : l.status === 'queued' ? 'rgba(38,34,32,0.35)' : 'transparent' }} />
                </div>
              ))}
            </div>
          </div>
        )}

        {step === 'quote' && (
          <QuoteEditor
            lines={lines}
            rates={rates}
            totals={totals}
            committed={committed}
            onStartEdit={startEdit}
            onCancelEdit={cancelEdit}
            onApplyEdit={applyEdit}
            onSetEdit={setEdit}
            onEditBase={editBase}
            onRerun={rerunLine}
            onDelete={deleteLine}
            onTogglePart={togglePart}
            onAddMore={() => setStep('photos')}
            flags={flags}
            keep={keep}
            notes={notes}
            notesOpen={notesOpen}
            flagPick={flagPick}
            flagSearch={flagSearch}
            onOpenNotes={() => setNotesOpen(true)}
            onCloseNotes={closeNotes}
            onNotesChange={onNotesChange}
            onFlagPickOpen={() => { setFlagPick(true); setFlagSearch(''); }}
            onFlagPickClose={() => setFlagPick(false)}
            onFlagSearch={setFlagSearch}
            onAddFlag={addFlag}
            onFlagDone={setFlagDone}
            onRemoveFlag={removeFlag}
            onToggleKeep={toggleKeep}
            onCopy={doCopy}
            onImage={doImage}
            onPrint={doPrint}
          />
        )}
        {step === 'quote' && (
          <QuotePrint
            lines={lines}
            rates={rates}
            veh={veh}
            vehicleText={vehicleText}
            stock={stock}
            miles={miles}
            vin={vin}
            estimator={estimator}
            notes={notes}
            keep={keep}
            flags={flags}
          />
        )}
        </>}
      </div>

      {walkOpen && (
        <WalkAroundCamera
          quoteId={ensureQuoteId()}
          committed={!!committed}
          initialMode={walkInitialMode}
          onClose={() => setWalkOpen(false)}
          onDamageCapture={addDamageDataUrl}
          showToast={showToast}
        />
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        onChange={addDamageFiles}
        style={{ display: 'none' }}
      />
      {scanning && <VinScanner onDetected={onScannerHit} onCancel={() => setScanning(false)} />}
      {lightbox && (
        <div className="lightbox-overlay" onClick={() => setLightbox(null)}>
          <div className="lightbox-img" style={{ backgroundImage: `url("${lightbox}")` }} />
        </div>
      )}
    </div>
  );
}

/* ---------- print view (PDF button) ---------- */
function QuotePrint({ lines, rates, veh, vehicleText, stock, miles, vin, estimator, notes, keep, flags }) {
  const t = quoteTotals(lines, rates);
  const SP = !!rates.showPricing;
  const rows = quoteRows(lines, rates);
  const vehTitle = (veh && [veh.year, veh.make, veh.model, veh.trim].filter(Boolean).join(' ')) || vehicleText || 'Vehicle';
  const K = keep || {};
  const keepList = [K.tires && 'Tires', K.wheels && 'Wheels', K.set && 'Set'].filter(Boolean);
  return (
    <div className="quote-print" aria-hidden="true">
      <h1>TRUCK RANCH — PAINT & BODY</h1>
      <div className="qp-sub">REPAIR ORDER WORKSHEET · {dateDisp()}</div>
      <div className="qp-rule" />
      <div className="qp-meta">
        <div><b>Vehicle:</b> {vehTitle} &nbsp;&nbsp; <b>Stock #:</b> {stock || '—'} &nbsp;&nbsp; <b>Miles:</b> {miles || '—'}</div>
        <div><b>VIN:</b> {vin || '—'} &nbsp;&nbsp; <b>Estimator:</b> {estimator || '—'}</div>
      </div>
      <table>
        <thead>
          <tr>
            <th>PANEL</th>
            <th>WORK TO BE PERFORMED</th>
            <th style={{ textAlign: 'right' }}>BODY</th>
            <th style={{ textAlign: 'right' }}>PAINT</th>
            <th style={{ textAlign: 'right' }}>R&I</th>
            <th style={{ textAlign: 'right' }}>TOTAL HRS</th>
            {SP && <th style={{ textAlign: 'right' }}>USD</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={r.flag ? 'qp-flag' : r.dim ? 'qp-dim' : ''}>
              <td>{r.idx}. {r.panel}</td>
              <td>{r.ops.map((op, j) => <div key={j}>• {op}</div>)}</td>
              <td className="num">{r.tot != null ? fmt1(r.b) : ''}</td>
              <td className="num">{r.tot != null ? (r.isX ? '—' : fmt1(r.p)) : ''}</td>
              <td className="num">{r.tot != null ? (r.isX ? '—' : fmt1(r.ri)) : ''}</td>
              <td className="num">{r.tot != null ? fmt1(r.tot) : ''}</td>
              {SP && <td className="num">{r.tot != null && r.usd != null ? usd(r.usd) : ''}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="qp-totals">
        {SP ? (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Body repair — {fmt1(t.B)} hr × ${rn(rates.dollars.body)}</span><span>{usd(t.usdB)}</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Paint refinish — {fmt1(t.P)} hr × ${rn(rates.dollars.paint)}</span><span>{usd(t.usdP)}</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>R&I — {fmt1(t.RI)} hr × ${rn(rates.dollars.ri)}</span><span>{usd(t.usdRI)}</span></div>
            {t.usdPDR > 0 && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>PDR — paintless repair, flat</span><span>{usd(t.usdPDR)}</span></div>}
            <div className="qp-total-row"><span>TOTAL {fmt1(t.hrs)} HR</span><span>{usd(t.usd)}</span></div>
          </>
        ) : (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Body repair</span><span>{fmt1(t.B)} hr</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Paint refinish</span><span>{fmt1(t.P)} hr</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>R&I</span><span>{fmt1(t.RI)} hr</span></div>
            {t.usdPDR > 0 && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>PDR — paintless repair</span><span>flat rate</span></div>}
            <div className="qp-total-row"><span>TOTAL</span><span>{fmt1(t.hrs)} HR</span></div>
          </>
        )}
      </div>
      {t.flagged > 0 && <div className="qp-extra qp-flag">{t.flagged} photo{t.flagged === 1 ? '' : 's'} flagged for human review — excluded from totals.</div>}
      {(notes || '').trim() && <div className="qp-extra"><b>NOTES:</b> {notes.trim()}</div>}
      {keepList.length > 0 && <div className="qp-extra"><b>KEEP:</b> {keepList.join(', ')}</div>}
      {(flags || []).length > 0 && <div className="qp-extra"><b>FLAGS:</b> {flags.map((f) => flagDef(rates, f.id).label + (f.done ? ' ✓' : '')).join(', ')}</div>}
      <div className="qp-foot">Hours from Truck Ranch fixed rate table — same classification = same hours.</div>
    </div>
  );
}

/* ---------- VIN step ---------- */
function VinStep({ vin, onVin, onScan, onManual }) {
  return (
    <>
      <div className="card">
        <div className="card-title">START A QUOTE</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, marginTop: 6 }}>
          Scan or type the VIN to begin. The vehicle is decoded automatically.
        </div>
        <button className="btn btn-red" style={{ marginTop: 10 }} onClick={onScan}>
          📷 Scan VIN barcode
        </button>
      </div>
      <div className="card">
        <div className="field-label">VIN (17 CHARACTERS)</div>
        <input
          className="input mono"
          placeholder="VIN…"
          value={vin}
          maxLength={17}
          onChange={(e) => onVin(e.target.value.toUpperCase())}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
        />
        <button
          className="btn btn-dark"
          style={{ marginTop: 10 }}
          disabled={vin.trim().length !== 17}
          onClick={onManual}
        >
          Use this VIN
        </button>
      </div>
    </>
  );
}

/* ---------- confirm step ---------- */
function ConfirmStep({ vin, vinOverridden, decoding, decodeFailed, vehicleText, onVehicle, stock, onStock, estimator, onEstimator, miles, onMiles, onBack, onNext }) {
  const ready = String(stock).trim() && String(estimator).trim();
  return (
    <>
      <div className="card">
        <div className="card-title">VEHICLE</div>
        <div className="mono" style={{ fontSize: 13, marginTop: 6 }}>{vin}</div>
        {vinOverridden && (
          <div style={{ fontSize: 10, color: 'var(--amber)', fontWeight: 700, marginTop: 4 }}>
            ⚠ Check digit failed — verify against the door label.
          </div>
        )}
        {decoding && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>Decoding VIN…</div>}
        {decodeFailed && (
          <div style={{ fontSize: 11, color: 'var(--amber)', marginTop: 8 }}>
            Could not decode this VIN — type the vehicle below.
          </div>
        )}
        <div style={{ marginTop: 8 }}>
          <div className="field-label">VEHICLE</div>
          <input className="input" value={vehicleText} onChange={(e) => onVehicle(e.target.value)} placeholder="Year Make Model" />
        </div>
      </div>

      <div className="card">
        <div className="card-title">DETAILS</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 6 }}>
          <div>
            <div className="field-label">STOCK #</div>
            <input className="input" value={stock} onChange={(e) => onStock(e.target.value.toUpperCase())} />
          </div>
          <div>
            <div className="field-label">MILES</div>
            <input className="input" value={miles} onChange={(e) => onMiles(e.target.value)} />
          </div>
          <div style={{ gridColumn: '1 / span 2' }}>
            <div className="field-label">ESTIMATOR</div>
            <input className="input" value={estimator} onChange={(e) => onEstimator(e.target.value)} />
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-outline" style={{ flex: '0 0 40%' }} onClick={onBack}>Back</button>
        <button className="btn btn-red" style={{ flex: 1 }} disabled={!ready} onClick={onNext}>
          {ready ? 'Photograph damage →' : 'Add stock # & estimator'}
        </button>
      </div>
    </>
  );
}

/* ---------- photos step ---------- */
function PhotosStep({ photos, damageFocus = false, serverPhotos = [], onEnlarge, lineCount, committed, armedDelete, onAdd, onWalk, onDamage, onRemove, onAnalyze, onBack, onSeeQuote }) {
  // All non-damage shots — guided slots and after-the-fact extras — are one
  // walk-around set; only damage close-ups ('dmg…') are shown apart.
  const walkShots = serverPhotos.filter((p) => !String(p.slot || '').startsWith('dmg'));
  return (
    <>
      {!damageFocus && <div className="card">
        <div className="card-title">WALK-AROUND PHOTOS · {walkShots.length}</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, marginTop: 6 }}>
          Circle the truck and shoot everything — sides, corners, interior, wheels. Photos save automatically as you go.
        </div>
        {walkShots.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginTop: 10 }}>
            {walkShots.map((p) => (
              <img
                key={p.id}
                src={`/api/quoter/photo?id=${encodeURIComponent(p.id)}`}
                alt={p.slot || 'walk-around photo'}
                loading="lazy"
                onClick={() => onEnlarge && onEnlarge(`/api/quoter/photo?id=${encodeURIComponent(p.id)}`)}
                style={{ width: '100%', aspectRatio: '4 / 3', objectFit: 'cover', borderRadius: 7, border: '1px solid var(--border)', cursor: 'pointer' }}
              />
            ))}
          </div>
        )}
        {!committed && <button className="btn btn-dark" style={{ marginTop: 10 }} onClick={onWalk}>📷 TAKE PHOTOS</button>}
      </div>}
      <div className="card">
        <div className="card-title">DAMAGE PHOTOS · {Math.max(serverPhotos.filter((p) => String(p.slot || '').startsWith('dmg')).length, photos.length)}</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, marginTop: 6 }}>
          Take a close-up of each damage spot — these go to the AI for the body quote.
        </div>
        {serverPhotos.some((p) => String(p.slot || '').startsWith('dmg')) && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginTop: 10 }}>
            {serverPhotos.filter((p) => String(p.slot || '').startsWith('dmg') && !photos.some((lp) => lp.id === p.id)).map((p) => (
              <img
                key={p.id}
                src={`/api/quoter/photo?id=${encodeURIComponent(p.id)}`}
                alt="damage close-up"
                loading="lazy"
                onClick={() => onEnlarge && onEnlarge(`/api/quoter/photo?id=${encodeURIComponent(p.id)}`)}
                style={{ width: '100%', aspectRatio: '4 / 3', objectFit: 'cover', borderRadius: 7, border: '1px solid var(--border)', cursor: 'pointer' }}
              />
            ))}
          </div>
        )}
        {!committed && <><button className="btn btn-dark" style={{ marginTop: 10 }} onClick={onDamage}>⚠ ADD DAMAGE CLOSE-UP</button>
          <button className="btn btn-outline-brown" style={{ marginTop: 8 }} onClick={onAdd}>Choose from device</button></>}
        {photos.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
            {photos.map((p) => (
              <div key={p.id} style={{ position: 'relative', width: 84, height: 84, borderRadius: 9, overflow: 'hidden', border: '1px solid var(--border)' }}>
                <img src={p.thumb} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                <div
                  onClick={() => onRemove(p.id)}
                  style={{ position: 'absolute', top: 3, right: 3, width: 22, height: 22, borderRadius: 6, background: 'rgba(38,34,32,0.7)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, cursor: 'pointer' }}
                >
                   {armedDelete === p.id ? 'TAP AGAIN' : '✕'}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {photos.length > 0 ? (
        <button className="btn btn-red" onClick={onAnalyze}>
          Analyze {photos.length} photo{photos.length === 1 ? '' : 's'} →
        </button>
      ) : (
        <div className="empty-note">Add at least one damage photo to analyze.</div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-outline" style={{ flex: 1 }} onClick={onBack}>Back</button>
        {onSeeQuote && (
          <button className="btn btn-outline-brown" style={{ flex: 1 }} onClick={onSeeQuote}>
            See quote ({lineCount})
          </button>
        )}
      </div>
    </>
  );
}

/* ---------- quote editor ---------- */
function QuoteEditor({ lines, rates, totals, committed, onStartEdit, onCancelEdit, onApplyEdit, onSetEdit, onEditBase, onRerun, onDelete, onTogglePart, onAddMore,
  flags, keep, notes, notesOpen, flagPick, flagSearch,
  onOpenNotes, onCloseNotes, onNotesChange, onFlagPickOpen, onFlagPickClose, onFlagSearch, onAddFlag, onFlagDone, onRemoveFlag, onToggleKeep, onCopy, onImage, onPrint }) {
  const locked = !!committed;
  return (
    <>
      <div className="card">
        <div className="card-title">QUOTE TOTAL</div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 6 }}>
          <span className="oswald" style={{ fontWeight: 700, fontSize: 26 }}>{fmt1(totals.hrs)}</span>
          <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>total hours of work</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginTop: 10 }}>
          <Bucket label="BODY" hrs={totals.B} />
          <Bucket label="PAINT" hrs={totals.P} />
          <Bucket label="R&I" hrs={totals.RI} />
        </div>
        {totals.usdPDR > 0 && <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 7 }}>Includes paintless dent repair (flat rate, no hours).</div>}
        {(totals.flagged > 0 || totals.errors > 0) && (
          <div style={{ fontSize: 10.5, color: 'var(--amber)', fontWeight: 700, marginTop: 8 }}>
            {totals.flagged > 0 && `${totals.flagged} flagged for review`}
            {totals.flagged > 0 && totals.errors > 0 && ' · '}
            {totals.errors > 0 && `${totals.errors} failed`}
          </div>
        )}
      </div>

      {lines.map((l) => (
        <LineCard
          key={l.id}
          line={l}
          rates={rates}
          locked={locked}
          onStartEdit={onStartEdit}
          onCancelEdit={onCancelEdit}
          onApplyEdit={onApplyEdit}
          onSetEdit={onSetEdit}
          onEditBase={onEditBase}
          onRerun={onRerun}
          onDelete={onDelete}
          onTogglePart={onTogglePart}
        />
      ))}

      {!lines.length && <div className="empty-note">No damage lines yet.</div>}

      <QuoteExtras
        rates={rates}
        locked={locked}
        flags={flags}
        keep={keep}
        notes={notes}
        notesOpen={notesOpen}
        flagPick={flagPick}
        flagSearch={flagSearch}
        onOpenNotes={onOpenNotes}
        onCloseNotes={onCloseNotes}
        onNotesChange={onNotesChange}
        onFlagPickOpen={onFlagPickOpen}
        onFlagPickClose={onFlagPickClose}
        onFlagSearch={onFlagSearch}
        onAddFlag={onAddFlag}
        onFlagDone={onFlagDone}
        onRemoveFlag={onRemoveFlag}
        onToggleKeep={onToggleKeep}
      />

      {locked ? (
        <div className="card" style={{ borderColor: 'var(--green)', background: '#e8f3ea' }}>
          <SignatureBadge committedBy={committed.committedBy} overriddenBy={committed.overriddenBy} />
          <div style={{ fontSize: 9.5, color: 'var(--muted)', marginTop: 4 }}>
            Committed and locked. A correction is a new record, not an edit.
          </div>
        </div>
      ) : (
        <button className="btn btn-outline-brown" onClick={onAddMore}>+ Add more damage photos</button>
      )}

      {/* Export bar — COPY / IMAGE / PDF (dark, sticky) */}
      <div style={{ position: 'sticky', bottom: 0, margin: '4px -14px -12px', background: '#23201a', padding: '12px 16px calc(12px + env(safe-area-inset-bottom))', display: 'flex', alignItems: 'center', gap: 10, zIndex: 40 }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
          <span className="oswald" style={{ fontWeight: 700, fontSize: 18, letterSpacing: 1, color: '#f2efe8', whiteSpace: 'nowrap' }}>
            TOTAL {fmt1(totals.hrs)} HR
          </span>
          <span className="oswald" style={{ fontWeight: 600, fontSize: 10, letterSpacing: 1.8, color: '#b5ac97' }}>FIXED RATE TABLE HOURS</span>
        </div>
        <button onClick={onCopy} style={{ background: 'none', border: '1.5px solid #4a453c', borderRadius: 10, color: '#f2efe8', fontFamily: "'Oswald', sans-serif", fontWeight: 600, fontSize: 14, letterSpacing: 1.2, padding: '0 14px', height: 48, cursor: 'pointer' }}>COPY</button>
        <button onClick={onImage} style={{ background: '#b0322a', border: 'none', borderRadius: 10, color: '#fff', fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 14, letterSpacing: 1.2, padding: '0 16px', height: 48, cursor: 'pointer' }}>IMAGE</button>
        <button onClick={onPrint} style={{ background: 'none', border: '1.5px solid #4a453c', borderRadius: 10, color: '#f2efe8', fontFamily: "'Oswald', sans-serif", fontWeight: 600, fontSize: 14, letterSpacing: 1.2, padding: '0 14px', height: 48, cursor: 'pointer' }}>PDF</button>
      </div>
    </>
  );
}

/* ---------- flags / keep / notes — shared across confirm, photos & quote steps ---------- */
function QuoteExtras({ rates, locked, flags, keep, notes, notesOpen, flagPick, flagSearch,
  onOpenNotes, onCloseNotes, onNotesChange, onFlagPickOpen, onFlagPickClose, onFlagSearch, onAddFlag, onFlagDone, onRemoveFlag, onToggleKeep }) {
  return (
    <>
      {/* FLAGS */}
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span className="oswald" style={{ fontWeight: 700, fontSize: 13, letterSpacing: 1.4, color: 'var(--muted)' }}>FLAGS</span>
          {!locked && (
            <button
              onClick={onFlagPickOpen}
              style={{ background: '#fff', border: '1.5px solid var(--border)', borderRadius: 9, padding: '7px 12px', fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 12, letterSpacing: 1, color: 'var(--ink)', cursor: 'pointer' }}
            >
              ＋ ADD FLAG
            </button>
          )}
        </div>
        {!(flags || []).length && (
          <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 8 }}>No flags yet. Tap ＋ ADD FLAG to tag what this truck needs.</div>
        )}
        {(flags || []).length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
            {(flags || []).map((f) => {
              const d = flagDef(rates, f.id);
              const bg = f.done ? '#f5f3ee' : d.bg, fg = f.done ? '#857d70' : d.fg;
              return (
                <span key={f.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, borderRadius: 9, padding: '7px 10px', border: `1.3px solid ${d.bd}`, background: bg }}>
                  <button
                    onClick={() => onFlagDone(f.id, !f.done)}
                    aria-label="Mark flag complete"
                    style={{ width: 24, height: 24, flex: 'none', background: '#fff', border: `1.5px solid ${d.bd}`, borderRadius: 6, color: 'var(--green)', fontSize: 15, fontWeight: 700, lineHeight: 1, cursor: 'pointer', padding: 0 }}
                  >
                    {f.done ? '✓' : ''}
                  </button>
                  <span className="oswald" style={{ fontWeight: 700, fontSize: 13.5, letterSpacing: 0.6, color: fg, textDecoration: f.done ? 'line-through' : 'none' }}>{d.label}</span>
                  {!locked && (
                    <button onClick={() => onRemoveFlag(f.id)} aria-label="Remove flag" style={{ background: 'none', border: 'none', color: fg, opacity: 0.55, fontSize: 13, cursor: 'pointer', padding: '0 2px' }}>✕</button>
                  )}
                </span>
              );
            })}
          </div>
        )}
      </div>

      {/* KEEP */}
      <div className="card">
        <span className="oswald" style={{ fontWeight: 700, fontSize: 13, letterSpacing: 1.4, color: 'var(--muted)' }}>KEEP</span>
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          {[['tires', 'KEEP TIRES'], ['wheels', 'KEEP WHEELS'], ['set', 'KEEP SET']].map(([k, label]) => {
            const on = !!(keep && keep[k]);
            return (
              <button
                key={k}
                onClick={locked ? undefined : () => onToggleKeep(k)}
                style={{ flex: 1, minWidth: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: 8, padding: '7px 4px', border: `1.3px solid ${on ? 'var(--green)' : 'var(--border)'}`, background: on ? '#e8f3ea' : '#fff', cursor: locked ? 'default' : 'pointer' }}
              >
                <span style={{ width: 17, height: 17, flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: '#fff', border: `1.5px solid ${on ? 'var(--green)' : 'var(--border)'}`, borderRadius: 5, color: 'var(--green)', fontSize: 12, fontWeight: 700, lineHeight: 1 }}>{on ? '✓' : ''}</span>
                <span className="oswald" style={{ fontWeight: 700, fontSize: 12, letterSpacing: 0.4, color: 'var(--ink)', whiteSpace: 'nowrap' }}>{label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* NOTES */}
      <button
        onClick={onOpenNotes}
        style={{ background: '#fff', border: '1.5px solid var(--border)', borderRadius: 12, padding: 13, cursor: 'pointer', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 4 }}
      >
        <span className="oswald" style={{ fontWeight: 700, fontSize: 12, letterSpacing: 1.2, color: 'var(--muted)' }}>{(notes || '').trim() ? 'NOTES' : '＋ ADD NOTES'}</span>
        <span style={{ fontSize: 13.5, color: 'var(--brown)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
          {(notes || '').trim() || 'Tap to jot down anything about this truck.'}
        </span>
      </button>

      {/* Flag picker */}
      {flagPick && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 230, background: 'rgba(20,17,12,.55)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }} onClick={onFlagPickClose}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 520, background: '#f5f3ee', borderRadius: '18px 18px 0 0', padding: '16px 16px calc(16px + env(safe-area-inset-bottom))', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span className="oswald" style={{ fontWeight: 700, fontSize: 15, letterSpacing: 1.6, color: 'var(--ink)' }}>ADD FLAG</span>
              <button onClick={onFlagPickClose} style={{ background: 'none', border: '1.5px solid var(--border)', borderRadius: 9, color: 'var(--brown)', fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 13, letterSpacing: 1.2, padding: '8px 14px', cursor: 'pointer' }}>CANCEL</button>
            </div>
            <input
              className="input"
              value={flagSearch}
              onChange={(e) => onFlagSearch(e.target.value)}
              placeholder="Search flags…"
              autoFocus
            />
            {(() => {
              const opts = flagDefs(rates).filter((dd) => !(flags || []).some((f) => f.id === dd.id) && dd.label.toUpperCase().includes((flagSearch || '').trim().toUpperCase()));
              if (!opts.length) return <div style={{ fontSize: 13, color: 'var(--muted)' }}>No flags match.</div>;
              return (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, maxHeight: '45vh', overflow: 'auto' }}>
                  {opts.map((o) => (
                    <button key={o.id} onClick={() => onAddFlag(o.id)} style={{ display: 'inline-flex', borderRadius: 9, padding: '10px 14px', border: `1.3px solid ${o.bd}`, background: o.bg, color: o.fg, fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 14, letterSpacing: 0.8, cursor: 'pointer' }}>{o.label}</button>
                  ))}
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* Notes editor */}
      {notesOpen && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 230, background: 'rgba(20,17,12,.55)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }} onClick={onCloseNotes}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 520, background: '#f5f3ee', borderRadius: '18px 18px 0 0', padding: '16px 16px calc(16px + env(safe-area-inset-bottom))', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span className="oswald" style={{ fontWeight: 700, fontSize: 15, letterSpacing: 1.6, color: 'var(--ink)' }}>QUOTE NOTES</span>
              <button onClick={onCloseNotes} style={{ background: 'var(--green)', border: 'none', borderRadius: 9, color: '#fff', fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 14, letterSpacing: 1.2, padding: '9px 18px', cursor: 'pointer' }}>DONE</button>
            </div>
            {locked ? (
              <div style={{ width: '100%', boxSizing: 'border-box', background: '#f0eee9', border: '1.5px solid var(--border)', borderRadius: 12, padding: 12, fontSize: 15, lineHeight: 1.45, color: 'var(--brown)', minHeight: 150, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{notes}</div>
            ) : (
              <textarea
                rows={7}
                maxLength={2000}
                placeholder="Anything worth remembering about this truck — prior damage, customer requests, parts to order…"
                value={notes}
                onChange={(e) => onNotesChange(e.target.value)}
                style={{ width: '100%', boxSizing: 'border-box', background: '#fff', border: '1.5px solid var(--border)', borderRadius: 12, padding: 12, fontFamily: 'inherit', fontSize: 16, lineHeight: 1.45, color: 'var(--ink)', resize: 'none', minHeight: 150 }}
              />
            )}
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{locked ? 'Committed — these notes are read-only.' : 'Saved with this quote — you’ll see them any time you reopen it.'}</span>
          </div>
        </div>
      )}
    </>
  );
}

function Bucket({ label, hrs }) {
  return (
    <div style={{ background: 'var(--panel)', borderRadius: 8, padding: '7px 6px', textAlign: 'center' }}>
      <div style={{ fontSize: 8.5, fontWeight: 700, color: 'var(--muted)', letterSpacing: 0.6 }}>{label}</div>
      <div className="oswald" style={{ fontWeight: 700, fontSize: 15 }}>{fmt1(hrs || 0)}<span style={{ fontSize: 9.5, color: 'var(--muted)', fontWeight: 600 }}> hr</span></div>
    </div>
  );
}

function LineCard({ line: l, rates, locked, onStartEdit, onCancelEdit, onApplyEdit, onSetEdit, onEditBase, onRerun, onDelete, onTogglePart }) {
  const isErr = l.status === 'error';
  const cls = l.cls;
  const h = cls ? lineHours(cls, rates) : null;
  const title = cls ? panelLabel(cls.panel) : (isErr ? 'Photo — failed' : 'Unreadable photo');
  const sub = cls ? [DMG_LABEL[cls.damage_type] || cls.damage_type, SEV_LABEL[cls.severity] || cls.severity, cls.paint_damaged && 'paint'].filter(Boolean).join(' · ') : '';

  return (
    <div className="card" style={{ borderColor: l.review ? 'var(--amber)' : isErr ? 'var(--red)' : 'var(--border)' }}>
      <div style={{ display: 'flex', gap: 10 }}>
        {l.thumb && (
          <img src={l.thumb} alt="" style={{ width: 58, height: 58, borderRadius: 8, objectFit: 'cover', flex: '0 0 auto' }} />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="oswald" style={{ fontWeight: 600, fontSize: 15, flex: 1, minWidth: 0 }}>{title}</span>
            {l.review && <span style={{ fontSize: 8.5, fontWeight: 700, color: '#fff', background: 'var(--amber)', padding: '2px 6px', borderRadius: 4 }}>REVIEW</span>}
            {cls && cls.extra_area && <span style={{ fontSize: 8.5, fontWeight: 700, color: '#fff', background: 'var(--brown)', padding: '2px 6px', borderRadius: 4 }}>2ND AREA</span>}
          </div>
          {sub && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{sub}</div>}
          {h && !h.pdr && (
            <div className="mono" style={{ fontSize: 10.5, color: 'var(--brown)', marginTop: 3 }}>
              {h.b > 0 && `${fmt1(h.b)} body`}{h.b > 0 && (h.p > 0 || h.ri > 0) && ' · '}
              {h.p > 0 && `${fmt1(h.p)} paint`}{h.p > 0 && h.ri > 0 && ' · '}
              {h.ri > 0 && `${fmt1(h.ri)} R&I`}
              {h.b === 0 && h.p === 0 && h.ri === 0 && 'no billable hours'}
            </div>
          )}
          {h && h.pdr && (
            <div className="mono" style={{ fontSize: 10.5, color: 'var(--brown)', marginTop: 3 }}>PDR ${fmt1(h.pdrUsd)}{h.ri > 0 ? ` · ${fmt1(h.ri)} R&I` : ''}</div>
          )}
        </div>
      </div>

      {!locked && isErr && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 11, color: 'var(--red)' }}>{l.errMsg}</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="btn btn-outline-brown" style={{ height: 40, flex: 1 }} onClick={() => onRerun(l.id)}>Re-run</button>
            <button className="btn btn-outline-red" style={{ height: 40, flex: 1 }} onClick={() => onDelete(l.id)}>Delete</button>
          </div>
        </div>
      )}

      {!locked && !isErr && !l.editing && (
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button className="btn btn-outline-brown" style={{ height: 40, flex: 1 }} onClick={() => onStartEdit(l.id)}>Adjust</button>
          <button className="btn btn-outline-red" style={{ height: 40, flex: '0 0 34%' }} onClick={() => onDelete(l.id)}>Delete</button>
        </div>
      )}

      {!locked && !isErr && l.editing && (
        <LineEditor
          line={l}
          edit={onEditBase(l)}
          onSetEdit={onSetEdit}
          onApply={() => onApplyEdit(l.id)}
          onCancel={() => onCancelEdit(l.id)}
          onTogglePart={onTogglePart}
        />
      )}
    </div>
  );
}

function LineEditor({ line: l, edit, onSetEdit, onApply, onCancel, onTogglePart }) {
  const id = l.id;
  const parts = (l.cls && l.cls.ri_parts_needed) || [];
  return (
    <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <PickerRow label="PANEL" value={edit.panel} options={PANELS.map((p) => ({ v: p, label: panelLabel(p) }))} onPick={(v) => onSetEdit(id, 'panel', v)} />
      <PickerRow label="DAMAGE" value={edit.damage} options={DAMAGE.map((d) => ({ v: d, label: DMG_LABEL[d] || d }))} onPick={(v) => onSetEdit(id, 'damage', v)} />
      <PickerRow label="SEVERITY" value={edit.sev} options={SEVS.map((s) => ({ v: s, label: SEV_LABEL[s] || s }))} onPick={(v) => onSetEdit(id, 'sev', v)} />

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <Toggle on={edit.paint} label="Paint damaged" onClick={() => onSetEdit(id, 'paint', !edit.paint)} />
        <Toggle on={edit.partial} label="Partial paint" onClick={() => onSetEdit(id, 'partial', !edit.partial)} />
        <Toggle on={edit.blend} label="Blend adjacent" onClick={() => onSetEdit(id, 'blend', !edit.blend)} />
        <Toggle on={edit.pdr} label="PDR" onClick={() => onSetEdit(id, 'pdr', !edit.pdr)} />
        <Toggle on={edit.extra} label="Separate area" onClick={() => onSetEdit(id, 'extra', !edit.extra)} />
      </div>

      <div>
        <div className="field-label">R&I PARTS</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {PARTS.map((p) => (
            <div
              key={p}
              className={'pill-btn' + (parts.includes(p) ? ' on green' : '')}
              style={{ height: 32, fontSize: 10 }}
              onClick={() => onTogglePart(id, p)}
            >
              {partLabel(p)}
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
        <OverrideField label="BODY hr" value={edit.bh} onChange={(v) => onSetEdit(id, 'bh', v)} />
        <OverrideField label="PAINT hr" value={edit.ph} onChange={(v) => onSetEdit(id, 'ph', v)} />
        <OverrideField label="R&I hr" value={edit.ri} onChange={(v) => onSetEdit(id, 'ri', v)} />
      </div>

      <div>
        <div className="field-label">NOTES</div>
        <input className="input" value={edit.notes || ''} onChange={(e) => onSetEdit(id, 'notes', e.target.value)} />
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-outline" style={{ height: 42, flex: '0 0 40%' }} onClick={onCancel}>Cancel</button>
        <button className="btn btn-green" style={{ height: 42, flex: 1 }} onClick={onApply}>Save line</button>
      </div>
    </div>
  );
}

function PickerRow({ label, value, options, onPick }) {
  return (
    <div>
      <div className="field-label">{label}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {options.map((o) => (
          <div
            key={o.v}
            className={'pill-btn' + (value === o.v ? ' on' : '')}
            style={{ height: 32, fontSize: 10 }}
            onClick={() => onPick(o.v)}
          >
            {o.label}
          </div>
        ))}
      </div>
    </div>
  );
}

function Toggle({ on, label, onClick }) {
  return (
    <div className={'pill-btn' + (on ? ' on green' : '')} style={{ height: 34, fontSize: 10.5 }} onClick={onClick}>
      {on ? '✓ ' : ''}{label}
    </div>
  );
}

function OverrideField({ label, value, onChange }) {
  return (
    <div>
      <div className="field-label">{label}</div>
      <input
        className="input mono"
        style={{ height: 40, textAlign: 'center' }}
        inputMode="decimal"
        placeholder="—"
        value={value || ''}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ''))}
      />
    </div>
  );
}
