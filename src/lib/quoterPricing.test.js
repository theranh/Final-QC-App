import { describe, it, expect } from 'vitest';
import {
  defaultRates,
  sevRank,
  pdrEligible,
  lineHours,
  billingMap,
  bodyAlloc,
  billingCls,
  quoteTotals,
} from './quoterPricing';

/*
 * Fixture-based tests. Expected values are hand-computed by tracing the original
 * Body Quoter pricing code with the default rate table:
 *   dollars: body 75, paint 80, ri 65
 *   body:    minor 1.0, moderate 2.5, heavy 4.0; replace per-panel
 *   refinish (paint): fender/door 4.0, hood/roof/bedside 5.0, bumper 2.5, ...
 *   caps:    regular 6, large 8, bumper 4
 *   pdr:     small $55, medium $150
 *   PARTIAL_FACTOR 0.6
 */

const R = defaultRates();

// Helper to build a "done" line (billable).
function line(id, cls) {
  return { id, status: 'done', review: false, cls };
}

describe('sevRank', () => {
  it('ranks severities minor<moderate<heavy<replace', () => {
    expect(sevRank('minor')).toBe(1);
    expect(sevRank('moderate')).toBe(2);
    expect(sevRank('heavy')).toBe(3);
    expect(sevRank('replace')).toBe(4);
    expect(sevRank('bogus')).toBe(0);
  });
});

describe('pdrEligible', () => {
  it('accepts a smooth metal dent, small/medium, factory paint intact', () => {
    expect(pdrEligible({ damage_type: 'dent', paint_damaged: false, severity: 'minor', panel: 'left_front_door' })).toBe(true);
    expect(pdrEligible({ damage_type: 'dent', paint_damaged: false, severity: 'moderate', panel: 'hood' })).toBe(true);
  });
  it('rejects paint-damaged, heavy, plastic panels, and non-dents', () => {
    expect(pdrEligible({ damage_type: 'dent', paint_damaged: true, severity: 'minor', panel: 'hood' })).toBe(false);
    expect(pdrEligible({ damage_type: 'dent', paint_damaged: false, severity: 'heavy', panel: 'hood' })).toBe(false);
    expect(pdrEligible({ damage_type: 'dent', paint_damaged: false, severity: 'minor', panel: 'front_bumper' })).toBe(false);
    expect(pdrEligible({ damage_type: 'scratch', paint_damaged: false, severity: 'minor', panel: 'hood' })).toBe(false);
    expect(pdrEligible(null)).toBe(false);
  });
});

describe('quoteTotals — single dent (moderate, paint damaged)', () => {
  // left_front_door moderate dent, paint damaged.
  //   b = body.left_front_door.moderate = 2.5
  //   p = refinish.left_front_door = 4.0
  //   core = 2.5 + 4.0 = 6.5 > cap 6 -> over = 0.5, cut from body -> b = 2.0, p = 4.0
  //   B=2.0, P=4.0, RI=0
  //   usdB = 2.0*75 = 150; usdP = 4.0*80 = 320; usd = 470
  it('applies regular cap trimming body first', () => {
    const lines = [line('l1', { panel: 'left_front_door', severity: 'moderate', damage_type: 'dent', paint_damaged: true })];
    const t = quoteTotals(lines, R);
    expect(t.B).toBe(2.0);
    expect(t.P).toBe(4.0);
    expect(t.RI).toBe(0);
    expect(t.usdB).toBe(150);
    expect(t.usdP).toBe(320);
    expect(t.usdPDR).toBe(0);
    expect(t.usd).toBe(470);
    expect(t.hrs).toBe(6.0);
  });
});

describe('quoteTotals — minor dent no paint, no cap hit', () => {
  // left_fender minor dent, no paint.
  //   b = 1.0, p = 0. core = 1.0 <= cap 6. B=1.0, usdB = 75.
  it('bills body only', () => {
    const lines = [line('l1', { panel: 'left_fender', severity: 'minor', damage_type: 'dent', paint_damaged: false })];
    const t = quoteTotals(lines, R);
    expect(t.B).toBe(1.0);
    expect(t.P).toBe(0);
    expect(t.usd).toBe(75);
  });
});

describe('billingMap — multi-photo same panel merging (highest severity wins)', () => {
  // Two lines on left_front_door: minor (l1, first) then heavy (l2).
  // First bmAdd creates entry sev=minor winner=l1. Second: heavy>minor so
  // sev becomes heavy, winner becomes l2.
  it('picks the highest-severity winner and merges paint/parts', () => {
    const lines = [
      line('l1', { panel: 'left_front_door', severity: 'minor', damage_type: 'dent', paint_damaged: false, ri_parts_needed: ['door_handle'] }),
      line('l2', { panel: 'left_front_door', severity: 'heavy', damage_type: 'crease', paint_damaged: true, ri_parts_needed: ['molding'] }),
    ];
    const map = billingMap(lines);
    expect(map.left_front_door.winner).toBe('l2');
    expect(map.left_front_door.sev).toBe('heavy');
    expect(map.left_front_door.dmg).toBe('crease');
    expect(map.left_front_door.paint).toBe(true); // OR-merged
    expect(map.left_front_door.parts).toEqual(['door_handle', 'molding']); // merged, deduped
  });

  it('does not merge distinct panels', () => {
    const lines = [
      line('l1', { panel: 'left_fender', severity: 'minor', damage_type: 'dent' }),
      line('l2', { panel: 'right_fender', severity: 'heavy', damage_type: 'dent' }),
    ];
    const map = billingMap(lines);
    expect(Object.keys(map).sort()).toEqual(['left_fender', 'right_fender']);
  });
});

describe('quoteTotals — highest-severity winner drives billing', () => {
  // left_front_door minor(l1) + heavy(l2, crease, paint). Winner l2 heavy.
  //   b = body.left_front_door.heavy = 4.0
  //   p = refinish 4.0. core = 8.0 > cap 6 -> over 2.0, cut body -> b=2.0, p=4.0
  //   B=2.0 P=4.0. usdB 150 usdP 320 usd 470.
  it('bills the merged winner (heavy) with cap applied', () => {
    const lines = [
      line('l1', { panel: 'left_front_door', severity: 'minor', damage_type: 'dent', paint_damaged: false }),
      line('l2', { panel: 'left_front_door', severity: 'heavy', damage_type: 'crease', paint_damaged: true }),
    ];
    const t = quoteTotals(lines, R);
    expect(t.B).toBe(2.0);
    expect(t.P).toBe(4.0);
    expect(t.usd).toBe(470);
  });
});

describe('quoteTotals — extra_area (separate damage) adds body & prorates under cap', () => {
  // left_fender winner: heavy dent paint -> b=4.0, p=4.0, core 8>cap6 -> b trimmed to 2.0, p=4.0.
  // wait: for winner bodyAlloc uses lineHours(billingCls) which caps: b=2.0, p=4.0.
  // extra_area line l2: heavy -> extraBodyHrs = 4.0.
  //   byId: {l1: 2.0, l2: 4.0}, sum = 6.0.
  //   cap = min(replace=1.5, panelCap 6 - (p 4.0 - blend 0) = 2.0) = min(1.5, 2.0) = 1.5.
  //   sum 6.0 > 1.5 -> largest-remainder allocate to capT=15.
  //     exact: l1 = 2.0/6*15 = 5.0 ; l2 = 4.0/6*15 = 10.0. floors 5,10 sum15 left0.
  //     byId: l1=0.5, l2=1.0. sum=1.5. total 1.5.
  //   B = 1.5, P = 4.0 (winner paint). usdB 1.5*75=112.5->113? Math.round(1.5*75)=Math.round(112.5)=113.
  //   Actually usd computed on rounded B: r1(1.5)=1.5. usdB=Math.round(1.5*75)=113. usdP=Math.round(4*80)=320.
  it('caps combined body across areas at replace hours (largest-remainder)', () => {
    const lines = [
      line('l1', { panel: 'left_fender', severity: 'heavy', damage_type: 'dent', paint_damaged: true }),
      line('l2', { panel: 'left_fender', severity: 'heavy', damage_type: 'dent', paint_damaged: false, extra_area: true }),
    ];
    const map = billingMap(lines);
    expect(map.left_fender.extras.length).toBe(1);
    const alloc = bodyAlloc('left_fender', map.left_fender, R);
    expect(alloc.byId.l1).toBe(0.5);
    expect(alloc.byId.l2).toBe(1.0);
    expect(alloc.total).toBe(1.5);
    const t = quoteTotals(lines, R);
    expect(t.B).toBe(1.5);
    expect(t.P).toBe(4.0);
    expect(t.usdB).toBe(113);
    expect(t.usdP).toBe(320);
    expect(t.usd).toBe(433);
  });
});

describe('quoteTotals — PDR-eligible dent bills flat $ instead of hours', () => {
  // hood minor dent, no paint, pdr flag, eligible -> b=0,p=0, pdrUsd = pdr.small = 55.
  //   B=0 P=0 RI=0. usdPDR = 55. usd = 55.
  it('bills PDR flat dollars', () => {
    const lines = [line('l1', { panel: 'hood', severity: 'minor', damage_type: 'dent', paint_damaged: false, pdr: true })];
    const h = lineHours(billingCls('hood', billingMap(lines).hood), R);
    expect(h.pdr).toBe(true);
    expect(h.pdrUsd).toBe(55);
    const t = quoteTotals(lines, R);
    expect(t.B).toBe(0);
    expect(t.P).toBe(0);
    expect(t.usdPDR).toBe(55);
    expect(t.usd).toBe(55);
  });

  it('medium PDR bills $150 and an override defeats PDR', () => {
    const pdrLine = [line('l1', { panel: 'hood', severity: 'moderate', damage_type: 'dent', paint_damaged: false, pdr: true })];
    expect(quoteTotals(pdrLine, R).usdPDR).toBe(150);
    // b_override present -> PDR skipped, body billed as override.
    const ovLine = [line('l1', { panel: 'hood', severity: 'moderate', damage_type: 'dent', paint_damaged: false, pdr: true, b_override: '3' })];
    const t = quoteTotals(ovLine, R);
    expect(t.usdPDR).toBe(0);
    expect(t.B).toBe(3.0);
    expect(t.usdB).toBe(225);
  });
});

describe('quoteTotals — estimator overrides b/p/ri (never capped)', () => {
  // hood: b_override 7 (above cap, not capped), p_override 6, ri_override 1.
  //   b = 7.0, p = 6.0, ri = 1.0. No cap trimming (overrides).
  //   B=7 P=6 RI=1. usdB=525 usdP=480 usdRI=65 usd=1070.
  it('honors overrides verbatim without capping', () => {
    const lines = [line('l1', {
      panel: 'hood', severity: 'moderate', damage_type: 'dent', paint_damaged: true,
      b_override: '7', p_override: '6', ri_override: '1',
    })];
    const t = quoteTotals(lines, R);
    expect(t.B).toBe(7.0);
    expect(t.P).toBe(6.0);
    expect(t.RI).toBe(1.0);
    expect(t.usd).toBe(525 + 480 + 65);
  });
});

describe('lineHours — blend + partial paint', () => {
  // left_front_door heavy dent, paint, partial, blend.
  //   b = 4.0
  //   p = refinish 4.0 ; partial -> Math.round(4.0*0.6*10)/10 = Math.round(24)/10 = 2.4
  //   blend adj (ADJ.left_front_door -> ['left_fender','left_rear_door']).slice(0,2):
  //     left_fender: Math.round(4.0*0.5*10)/10 = 2.0 ; left_rear_door: Math.round(4.0*0.5*10)/10 = 2.0
  //     p += 2.0 + 2.0 -> p = 2.4 + 2.0 + 2.0 = 6.4
  //   cap 6: blendSum = 4.0; core = b + (p - blendSum) = 4.0 + (6.4 - 4.0) = 4.0 + 2.4 = 6.4 > 6
  //     over = round((6.4-6)*10)/10 = 0.4 ; cutB = min(4.0, 0.4)=0.4 -> b = 3.6 ; over->0 ; p stays 6.4
  //   b=3.6, p=6.4 (paint incl blends), blends [{left_fender,2.0},{left_rear_door,2.0}], partial true
  it('applies partial factor then adds blends, caps body first', () => {
    const cls = { panel: 'left_front_door', severity: 'heavy', damage_type: 'dent', paint_damaged: true, paint_partial: true, blend_adjacent_recommended: true };
    const h = lineHours(cls, R);
    expect(h.b).toBe(3.6);
    expect(h.p).toBeCloseTo(6.4, 10);
    expect(h.partial).toBe(true);
    expect(h.blends).toEqual([{ panel: 'left_fender', hrs: 2.0 }, { panel: 'left_rear_door', hrs: 2.0 }]);
    expect(h.capped).toBe(true);
  });
});

describe('quoteTotals — blend + partial paint end to end', () => {
  // Same as above single line. B=3.6, P=6.4 (r1 -> 6.4), RI=0.
  //   usdB = round(3.6*75)=270 ; usdP = round(6.4*80)=512 ; usd = 782.
  it('totals body+paint with blends included in paint bucket', () => {
    const lines = [line('l1', { panel: 'left_front_door', severity: 'heavy', damage_type: 'dent', paint_damaged: true, paint_partial: true, blend_adjacent_recommended: true })];
    const t = quoteTotals(lines, R);
    expect(t.B).toBe(3.6);
    expect(t.P).toBe(6.4);
    expect(t.usdB).toBe(270);
    expect(t.usdP).toBe(512);
    expect(t.usd).toBe(782);
  });
});

describe('quoteTotals — bumper cap ($=4hr cap)', () => {
  // front_bumper heavy dent, paint. b=4.0, p=refinish.front_bumper=2.5.
  //   core = 6.5 > bumper cap 4. over = round((6.5-4)*10)/10 = 2.5.
  //   cutB = min(4.0, 2.5) = 2.5 -> b = 1.5 ; over -> 0 ; p stays 2.5.
  //   B=1.5 P=2.5. usdB=round(1.5*75)=113 usdP=round(2.5*80)=200 usd=313.
  it('caps front_bumper body+paint at 4 hours (trims body first)', () => {
    const lines = [line('l1', { panel: 'front_bumper', severity: 'heavy', damage_type: 'dent', paint_damaged: true })];
    const t = quoteTotals(lines, R);
    expect(t.B).toBe(1.5);
    expect(t.P).toBe(2.5);
    expect(t.usd).toBe(313);
  });
});

describe('quoteTotals — large panel cap (hood/roof/bedside = 8hr)', () => {
  // roof heavy dent, paint. b=4.0, p=refinish.roof=5.0. core=9.0 > large cap 8.
  //   over = round((9-8)*10)/10 = 1.0 ; cutB = min(4.0,1.0)=1.0 -> b=3.0 ; over->0 ; p=5.0.
  //   B=3.0 P=5.0. usdB=225 usdP=400 usd=625.
  it('caps roof body+paint at 8 hours', () => {
    const lines = [line('l1', { panel: 'roof', severity: 'heavy', damage_type: 'dent', paint_damaged: true })];
    const t = quoteTotals(lines, R);
    expect(t.B).toBe(3.0);
    expect(t.P).toBe(5.0);
    expect(t.usd).toBe(625);
  });
});

describe('quoteTotals — replace severity uses per-panel R&R hours', () => {
  // left_bedside replace, paint. b = body.left_bedside.replace = 10.0 ; p = refinish 5.0.
  //   large cap 8: core = 10 + 5 = 15 > 8. over = round((15-8)*10)/10 = 7.0.
  //     cutB = min(10, 7) = 7 -> b = 3.0 ; over -> 0 ; p = 5.0.
  //   B=3.0 P=5.0. usdB=225 usdP=400 usd=625.
  it('bills replace hours then applies the large-panel cap', () => {
    const lines = [line('l1', { panel: 'left_bedside', severity: 'replace', damage_type: 'dent', paint_damaged: true })];
    const t = quoteTotals(lines, R);
    expect(t.B).toBe(3.0);
    expect(t.P).toBe(5.0);
    expect(t.usd).toBe(625);
  });

  it('replace with no paint bills body up to nothing beyond replace hours (no cap since core=b only? cap applies)', () => {
    // rocker_panel replace no paint. b = replace 7.0, p=0. cap regular 6. core=7>6.
    //   over=1.0, cutB=min(7,1)=1 -> b=6.0. B=6.0 usdB=450.
    const lines = [line('l1', { panel: 'rocker_panel', severity: 'replace', damage_type: 'dent', paint_damaged: false })];
    const t = quoteTotals(lines, R);
    expect(t.B).toBe(6.0);
    expect(t.usd).toBe(450);
  });
});

describe('quoteTotals — R&I parts bucket', () => {
  // mirror moderate, no paint, parts [mirror, door_handle].
  //   b = body.mirror.moderate = 2.5 ; ri = ri.mirror(0.4)+ri.door_handle(0.3)=0.7.
  //   mirror panelCap regular 6 -> core 2.5 <= 6, no cap. B=2.5 RI=0.7.
  //   usdB=round(2.5*75)=188 ; usdRI=round(0.7*65)=Math.round(45.5)=46 ; usd=234.
  it('sums R&I hours from the parts list', () => {
    const lines = [line('l1', { panel: 'mirror', severity: 'moderate', damage_type: 'dent', paint_damaged: false, ri_parts_needed: ['mirror', 'door_handle'] })];
    const t = quoteTotals(lines, R);
    expect(t.B).toBe(2.5);
    expect(t.RI).toBeCloseTo(0.7, 10);
    expect(t.usdB).toBe(188);
    expect(t.usdRI).toBe(46);
    expect(t.usd).toBe(234);
  });
});

describe('quoteTotals — flagged/review and errors are excluded from billing', () => {
  it('ignores review lines and error lines but counts them', () => {
    const lines = [
      line('l1', { panel: 'left_fender', severity: 'minor', damage_type: 'dent', paint_damaged: false }),
      { id: 'l2', status: 'done', review: true, cls: { panel: 'hood', severity: 'heavy', damage_type: 'dent', paint_damaged: true } },
      { id: 'l3', status: 'error', cls: null },
    ];
    const t = quoteTotals(lines, R);
    expect(t.B).toBe(1.0); // only l1 billed
    expect(t.flagged).toBe(1);
    expect(t.errors).toBe(1);
  });
});

describe('quoteTotals — multiple panels aggregate', () => {
  // left_fender minor no paint -> b 1.0.
  // right_fender moderate paint -> b 2.5, p 4.0 ; core 6.5>6 -> b 2.0, p 4.0.
  //   B = 1.0 + 2.0 = 3.0 ; P = 4.0. usdB=225 usdP=320 usd=545.
  it('sums body/paint across panels', () => {
    const lines = [
      line('l1', { panel: 'left_fender', severity: 'minor', damage_type: 'dent', paint_damaged: false }),
      line('l2', { panel: 'right_fender', severity: 'moderate', damage_type: 'dent', paint_damaged: true }),
    ];
    const t = quoteTotals(lines, R);
    expect(t.B).toBe(3.0);
    expect(t.P).toBe(4.0);
    expect(t.usd).toBe(545);
  });
});

describe('billingMap — extra_area on a panel with no primary line becomes primary', () => {
  it('promotes a lone extra_area line to the panel entry', () => {
    const lines = [line('l1', { panel: 'tailgate', severity: 'moderate', damage_type: 'dent', paint_damaged: false, extra_area: true })];
    const map = billingMap(lines);
    expect(map.tailgate.winner).toBe('l1');
    expect(map.tailgate.extras).toEqual([]);
  });
});
