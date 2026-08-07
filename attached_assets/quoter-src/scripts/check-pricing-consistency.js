#!/usr/bin/env node
/*
 * Pricing-consistency check for the Intake & Body Quoter.
 *
 * Loads the real app class out of index.html (no browser needed), builds a
 * sample quote that exercises every billing path (winner line, duplicate
 * photo, separate damage area, blend, R&I parts, PDR flat rate, review flag,
 * panel cap), then verifies that every surface which shows dollars agrees
 * with quoteTotals():
 *   - copy summary text (buildSummary)
 *   - image export (exportImage — canvas draw calls are recorded and parsed)
 *   - quote card / bottom bar / PDF print view (renderVals output)
 *
 * Run:  node scripts/check-pricing-consistency.js
 * Exits non-zero with a diff message on any mismatch.
 */
'use strict';
const fs = require('fs');
const path = require('path');

/* ---------- load the app class from index.html ---------- */
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/);
if (!m) { console.error('FAIL: could not find the text/x-dc app script in index.html'); process.exit(1); }
const src = m[1];

/* ---------- minimal browser stubs ---------- */
const drawnText = []; // every string exportImage draws on the canvas
const ctxStub = new Proxy({
  fillText: (txt) => drawnText.push(String(txt)),
  measureText: (txt) => ({ width: String(txt).length * 9 }),
}, { get: (t, p) => (p in t ? t[p] : () => {}), set: (t, p, v) => { t[p] = v; return true; } });
const canvasStub = () => ({ getContext: () => ctxStub, toDataURL: () => 'data:image/png;base64,', width: 0, height: 0 });
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
global.document = {
  createElement: (tag) => tag === 'canvas' ? canvasStub() : { style: {}, value: '', select: () => {}, click: () => {} },
  body: { appendChild: () => {}, removeChild: () => {} },
  addEventListener: () => {}, removeEventListener: () => {},
};
global.window = { open: () => {}, matchMedia: () => ({ matches: false }), print: () => {} };
global.navigator = {};
global.URL = Object.assign(function () {}, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} });
global.Image = class { set src(_) { const f = this.onerror; if (f) setTimeout(f, 0); } };
global.fetch = () => Promise.reject(new Error('network disabled in test'));
class DCLogic {
  constructor(props) { this.props = props || {}; }
  setState(patch, cb) {
    const p = typeof patch === 'function' ? patch(this.state) : patch;
    if (p) Object.assign(this.state, p);
    if (cb) cb();
  }
}

const Component = new Function('DCLogic', src + '\nreturn Component;')(DCLogic);

/* ---------- sample quote ---------- */
function makeApp(rateMutator) {
  const app = new Component({});
  app.showToast = () => {};
  app.push = () => {};
  const rates = app.defaultRates();
  rates.showPricing = true;
  if (rateMutator) rateMutator(rates);
  const line = (id, cls, extra) => ({ id, status: 'done', review: false, thumb: '', manual: false, cls: cls ? { confidence: 'high', notes: '', ...cls } : cls, ...(extra || {}) });
  app.state.rates = rates;
  app.state.vin = '1FTFW1ET5DFC10312';
  app.state.stockNo = 'T-1234';
  app.state.miles = '45000';
  app.state.estimator = 'Ryan';
  app.state.lines = [
    // winner: hood dent w/ paint + blend + R&I part
    line('L1', { panel: 'hood', severity: 'moderate', damage_type: 'dent', paint_damaged: true, blend_adjacent_recommended: true, ri_parts_needed: ['emblem'] }),
    // duplicate photo of the hood, lower severity -> merged
    line('L2', { panel: 'hood', severity: 'minor', damage_type: 'scratch', paint_damaged: true, ri_parts_needed: [] }),
    // separate damage area on the hood -> extra body hours
    line('L3', { panel: 'hood', severity: 'minor', damage_type: 'dent', paint_damaged: false, ri_parts_needed: [], extra_area: true }),
    // PDR-eligible dent on a metal door
    line('L4', { panel: 'left_front_door', severity: 'minor', damage_type: 'dent', paint_damaged: false, ri_parts_needed: ['door_handle'], pdr: true }),
    // heavy bedside hit that runs into the panel cap
    line('L5', { panel: 'left_bedside', severity: 'heavy', damage_type: 'crease', paint_damaged: true, blend_adjacent_recommended: true, ri_parts_needed: ['wheel_flare', 'mudflap'] }),
    // replace-severity bumper
    line('L6', { panel: 'front_bumper', severity: 'replace', damage_type: 'crack', paint_damaged: true, ri_parts_needed: ['bumper_cover'] }),
    // flagged for review -> excluded from totals
    line('L7', { panel: 'tailgate', severity: 'heavy', damage_type: 'rust', paint_damaged: true, ri_parts_needed: [] }, { review: true }),
  ];
  app.state.photos = app.state.lines.map(l => ({ id: l.id, thumb: '', analyzed: true }));
  app.state.procDone = true;
  app.state.screen = 'quote';
  app.state.quoteId = 'q-test';
  return app;
}

/* ---------- assertions ---------- */
let failures = 0;
const check = (label, actual, expected) => {
  if (actual !== expected) { failures++; console.error('FAIL  ' + label + '\n      expected: ' + JSON.stringify(expected) + '\n      actual:   ' + JSON.stringify(actual)); }
  else console.log('ok    ' + label);
};
const checkIncludes = (label, haystackArr, needle) => {
  if (!haystackArr.some(s => s.includes(needle))) { failures++; console.error('FAIL  ' + label + '\n      not found: ' + JSON.stringify(needle)); }
  else console.log('ok    ' + label);
};

async function runScenario(name, rateMutator) {
  console.log('\n=== scenario: ' + name + ' ===');
  const app = makeApp(rateMutator);
  const t = app.quoteTotals();
  const d = app.state.rates.dollars;
  console.log('quoteTotals:', JSON.stringify(t));

  // 0. internal consistency of quoteTotals itself
  check('quoteTotals: usd = usdB + usdP + usdRI + usdPDR', t.usd, t.usdB + t.usdP + t.usdRI + t.usdPDR);
  check('quoteTotals: usdB = round(B × $body)', t.usdB, Math.round(t.B * d.body));
  check('quoteTotals: usdP = round(P × $paint)', t.usdP, Math.round(t.P * d.paint));
  check('quoteTotals: usdRI = round(RI × $ri)', t.usdRI, Math.round(t.RI * d.ri));
  if (!(t.usd > 0 && t.usdPDR > 0 && t.flagged === 1)) { failures++; console.error('FAIL  sample quote must exercise pricing, PDR and review paths'); }

  // 1. copy summary
  const summary = app.buildSummary().split('\n');
  checkIncludes('copy summary: body $', summary, '= ' + app.usd(t.usdB));
  checkIncludes('copy summary: paint $', summary, '= ' + app.usd(t.usdP));
  checkIncludes('copy summary: R&I $', summary, '= ' + app.usd(t.usdRI));
  checkIncludes('copy summary: PDR $', summary, 'flat ' + app.usd(t.usdPDR));
  checkIncludes('copy summary: total line', summary, 'TOTAL ' + app.fmt1(t.hrs) + ' HR — ' + app.usd(t.usd));

  // 2. image export — run the real exportImage and read what it drew
  drawnText.length = 0;
  app.exportImage();
  await new Promise(r => setTimeout(r, 20)); // let loadThumb promises + draw callback settle
  if (!drawnText.length) { failures++; console.error('FAIL  exportImage drew nothing — canvas stub broke?'); }
  checkIncludes('image export: body $', drawnText, app.usd(t.usdB));
  checkIncludes('image export: paint $', drawnText, app.usd(t.usdP));
  checkIncludes('image export: R&I $', drawnText, app.usd(t.usdRI));
  checkIncludes('image export: PDR $', drawnText, app.usd(t.usdPDR));
  checkIncludes('image export: total hours', drawnText, 'TOTAL ' + app.fmt1(t.hrs) + ' HR');
  checkIncludes('image export: total $', drawnText, app.usd(t.usd));
  // per-row dollars drawn on the canvas should sum to the grand total
  // (each row rounds independently, so allow ±$1 per priced row)
  const rowUsd = drawnText
    .slice(0, drawnText.findIndex(s => s.startsWith('Body repair —'))) // rows are drawn before the totals block
    .filter(s => /^\$[\d,]+$/.test(s))
    .map(s => Number(s.replace(/[$,]/g, '')));
  const rowSum = rowUsd.reduce((a, b) => a + b, 0);
  if (Math.abs(rowSum - t.usd) > rowUsd.length) { failures++; console.error('FAIL  image export: per-row $ (' + rowSum + ') drifts from total $' + t.usd + ' by more than rounding'); }
  else console.log('ok    image export: per-row $ sum (' + rowSum + ') ≈ total $' + t.usd);
  // RO rate breakdown must sum back to the total exactly
  const bdVals = ['Labor (65%)', 'Paint materials (30%)', 'Shop supplies (5%)'].map(lbl => {
    const i = drawnText.indexOf(lbl);
    return i >= 0 && /^\$[\d,]+$/.test(drawnText[i + 1] || '') ? Number(drawnText[i + 1].replace(/[$,]/g, '')) : NaN;
  });
  check('image export: RO breakdown sums to total', bdVals.reduce((a, b) => a + b, 0), t.usd);

  // 3. quote card / bottom bar / print view (renderVals)
  const vals = app.renderVals();
  check('quote card: body $', vals.usdB, app.usd(t.usdB));
  check('quote card: paint $', vals.usdP, app.usd(t.usdP));
  check('quote card: R&I $', vals.usdRI, app.usd(t.usdRI));
  check('quote card: PDR $', vals.usdPDR, app.usd(t.usdPDR));
  check('quote card / print view: total $', vals.totalUsd, app.usd(t.usd));
  check('bottom bar: hours + total $', vals.barTotal, app.fmt1(t.hrs) + ' HR · ' + app.usd(t.usd));
  // print view line hours must sum to the total hours (dollars in the print
  // view come from the same usdB/usdP/usdRI/totalUsd checked above)
  const plSum = (vals.printLines || [])
    .map(pl => parseFloat(pl.ht))
    .filter(n => isFinite(n))
    .reduce((a, b) => Math.round((a + b) * 10) / 10, 0);
  // PDR rows show "PDR" (no hours) but their R&I hours are in t.hrs
  const pdrRi = (vals.printLines || []).filter(pl => pl.ht === 'PDR').map(pl => parseFloat(pl.hri)).filter(isFinite).reduce((a, b) => a + b, 0);
  check('print view: line hours sum to TOTAL hrs', Math.round((plSum + pdrRi) * 10) / 10, t.hrs);
}

(async () => {
  // default rate table
  await runScenario('default rate table');
  // simulated future rate-table change: different $ rates, tweaked hours & PDR
  await runScenario('changed rate table', (r) => {
    r.dollars = { body: 92, paint: 101, ri: 73 };
    r.pdr = { small: 80, medium: 210 };
    r.body.hood.moderate = 3.1;
    r.refinish.left_bedside = 6.5;
    r.caps.large = 7;
  });
  console.log('');
  if (failures) { console.error(failures + ' check(s) FAILED — a pricing surface disagrees with quoteTotals().'); process.exit(1); }
  console.log('All pricing surfaces agree with quoteTotals(). ✓');
})().catch(e => { console.error('FAIL: check crashed:', e); process.exit(1); });
