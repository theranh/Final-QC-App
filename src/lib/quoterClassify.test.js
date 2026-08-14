// Unit tests for the second-look retry selection logic in quoterClassify.js.
//
// classifyLine (QuoteScreen.jsx) runs a first-pass classification; if that
// result is uncertain (null, low-confidence, or unknown panel) it calls
// pickBetterCls to decide whether to promote the retry result.  The kept
// answer is then snapshotted into aiCls so shop-calibration learning compares
// against what the AI actually settled on.
import { describe, it, expect } from 'vitest';
import { parseCls, pickBetterCls, SECOND_LOOK_ADDENDUM } from './quoterClassify';

// ---------------------------------------------------------------------------
// Minimal fixture helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid classification object. */
function mkCls({ panel = 'hood', confidence = 'high', notes = 'test' } = {}) {
  return {
    panel,
    damage_type: 'dent',
    severity: 'minor',
    paint_damaged: false,
    pdr: false,
    blend_adjacent_recommended: false,
    ri_parts_needed: [],
    confidence,
    notes,
  };
}

// ---------------------------------------------------------------------------
// parseCls — basic sanity (used in pipeline tests below)
// ---------------------------------------------------------------------------

describe('parseCls', () => {
  it('returns null for unparseable text', () => {
    expect(parseCls('not json at all')).toBeNull();
    expect(parseCls('')).toBeNull();
    expect(parseCls('```json\n{broken')).toBeNull();
  });

  it('parses a valid JSON classification', () => {
    const json = JSON.stringify({
      panel: 'hood',
      damage_type: 'dent',
      severity: 'minor',
      paint_damaged: false,
      pdr_candidate: false,
      blend_adjacent_recommended: false,
      ri_parts_needed: [],
      confidence: 'high',
      notes: 'Small dent.',
    });
    const cls = parseCls(json);
    expect(cls).not.toBeNull();
    expect(cls.panel).toBe('hood');
    expect(cls.confidence).toBe('high');
  });

  it('falls back to unknown panel for an unrecognised panel value', () => {
    const json = JSON.stringify({
      panel: 'flux_capacitor',
      damage_type: 'dent',
      severity: 'minor',
      paint_damaged: false,
      pdr_candidate: false,
      blend_adjacent_recommended: false,
      ri_parts_needed: [],
      confidence: 'high',
      notes: 'Unknown.',
    });
    const cls = parseCls(json);
    expect(cls.panel).toBe('unknown');
  });

  it('normalises confidence to low for an unrecognised confidence value', () => {
    const json = JSON.stringify({
      panel: 'hood',
      damage_type: 'dent',
      severity: 'minor',
      paint_damaged: false,
      pdr_candidate: false,
      blend_adjacent_recommended: false,
      ri_parts_needed: [],
      confidence: 'very_certain',
      notes: 'ok',
    });
    expect(parseCls(json).confidence).toBe('low');
  });
});

// ---------------------------------------------------------------------------
// SECOND_LOOK_ADDENDUM — existence check
// ---------------------------------------------------------------------------

describe('SECOND_LOOK_ADDENDUM', () => {
  it('is a non-empty string', () => {
    expect(typeof SECOND_LOOK_ADDENDUM).toBe('string');
    expect(SECOND_LOOK_ADDENDUM.length).toBeGreaterThan(20);
  });

  it('instructs the model to return the same JSON schema', () => {
    expect(SECOND_LOOK_ADDENDUM).toMatch(/JSON/i);
    expect(SECOND_LOOK_ADDENDUM).toMatch(/SECOND LOOK/i);
  });
});

// ---------------------------------------------------------------------------
// pickBetterCls — the keep-better gate
// ---------------------------------------------------------------------------

describe('pickBetterCls', () => {
  // Scenario 1: first pass was unparseable (null)
  it('takes any retry result when the first pass was unparseable (null)', () => {
    const cls2 = mkCls({ panel: 'left_fender', confidence: 'medium' });
    expect(pickBetterCls(null, cls2)).toBe(cls2);
  });

  it('returns null when both first pass and retry are null', () => {
    expect(pickBetterCls(null, null)).toBeNull();
  });

  it('takes a low-confidence retry over a null first pass', () => {
    const cls2 = mkCls({ panel: 'unknown', confidence: 'low' });
    // Even a poor retry beats no answer at all.
    expect(pickBetterCls(null, cls2)).toBe(cls2);
  });

  // Scenario 2: first pass low-confidence, retry clearly better
  it('promotes retry when it has a named panel and confidence !== low', () => {
    const cls = mkCls({ panel: 'hood', confidence: 'low' });
    const cls2 = mkCls({ panel: 'hood', confidence: 'medium' });
    expect(pickBetterCls(cls, cls2)).toBe(cls2);
  });

  it('promotes retry when it moves from unknown panel to a named panel with medium confidence', () => {
    const cls = mkCls({ panel: 'unknown', confidence: 'low' });
    const cls2 = mkCls({ panel: 'right_fender', confidence: 'medium' });
    expect(pickBetterCls(cls, cls2)).toBe(cls2);
  });

  it('promotes retry with high confidence over low-confidence first pass', () => {
    const cls = mkCls({ panel: 'tailgate', confidence: 'low' });
    const cls2 = mkCls({ panel: 'rear_bumper', confidence: 'high' });
    expect(pickBetterCls(cls, cls2)).toBe(cls2);
  });

  // Scenario 3: retry worse than first pass — keep first pass
  it('keeps first pass when retry also returns low confidence on a named panel', () => {
    const cls = mkCls({ panel: 'left_front_door', confidence: 'low' });
    const cls2 = mkCls({ panel: 'right_front_door', confidence: 'low' });
    expect(pickBetterCls(cls, cls2)).toBe(cls);
  });

  it('keeps first pass (named panel, low confidence) when retry returns unknown panel', () => {
    const cls = mkCls({ panel: 'hood', confidence: 'low' });
    const cls2 = mkCls({ panel: 'unknown', confidence: 'medium' });
    // cls.panel is not 'unknown', and cls2 IS 'unknown', so keep cls.
    expect(pickBetterCls(cls, cls2)).toBe(cls);
  });

  it('keeps first pass when retry is unknown+low', () => {
    const cls = mkCls({ panel: 'roof', confidence: 'low' });
    const cls2 = mkCls({ panel: 'unknown', confidence: 'low' });
    expect(pickBetterCls(cls, cls2)).toBe(cls);
  });

  // Edge: first pass panel = 'unknown' — only a strictly better retry wins
  it('keeps first pass (unknown+medium) when retry is unknown+low — tie/regression is not promoted', () => {
    // Regression: the old gate unconditionally replaced unknown with the retry.
    const cls  = mkCls({ panel: 'unknown', confidence: 'medium' });
    const cls2 = mkCls({ panel: 'unknown', confidence: 'low', notes: 'still blurry' });
    expect(pickBetterCls(cls, cls2)).toBe(cls);
  });

  it('keeps first pass (unknown+low) when retry is also unknown+low — equal quality tie', () => {
    const cls  = mkCls({ panel: 'unknown', confidence: 'low' });
    const cls2 = mkCls({ panel: 'unknown', confidence: 'low', notes: 'still blurry' });
    expect(pickBetterCls(cls, cls2)).toBe(cls);
  });

  it('promotes retry (unknown+medium) over first pass (unknown+low) — strictly better', () => {
    const cls  = mkCls({ panel: 'unknown', confidence: 'low' });
    const cls2 = mkCls({ panel: 'unknown', confidence: 'medium', notes: 'slightly clearer' });
    expect(pickBetterCls(cls, cls2)).toBe(cls2);
  });

  it('keeps first pass (named+low) when retry is unknown+medium — named panel wins', () => {
    const cls  = mkCls({ panel: 'hood', confidence: 'low' });
    const cls2 = mkCls({ panel: 'unknown', confidence: 'medium' });
    // Named always beats unknown regardless of confidence.
    expect(pickBetterCls(cls, cls2)).toBe(cls);
  });

  // Scenario 4: retry throws — cls is unchanged (tested at pipeline level below)
  // pickBetterCls itself: if cls2 is null (retry threw and returned null), keep cls.
  it('returns first pass unchanged when retry result is null', () => {
    const cls = mkCls({ panel: 'left_bedside', confidence: 'low' });
    expect(pickBetterCls(cls, null)).toBe(cls);
  });

  it('returns first pass when cls2 is undefined', () => {
    const cls = mkCls({ panel: 'left_bedside', confidence: 'low' });
    expect(pickBetterCls(cls, undefined)).toBe(cls);
  });
});

// ---------------------------------------------------------------------------
// Second-look pipeline simulation
// These tests exercise the full sequence that classifyLine performs:
//   1. call classify → parse → cls
//   2. if uncertain, call classify again → parse → cls2
//   3. cls = pickBetterCls(cls, cls2)
//   4. aiCls = deep-copy of the kept cls
// ---------------------------------------------------------------------------

/**
 * Minimal simulation of the classifyLine second-look flow.
 * callApi is an async function that receives the system prompt and returns
 * { text } (or throws).
 */
async function runSecondLookPipeline(callApi) {
  const system = 'SYS';
  let cls = parseCls((await callApi(system)).text);
  if (!cls || cls.confidence === 'low' || cls.panel === 'unknown') {
    try {
      const out2 = await callApi(system + SECOND_LOOK_ADDENDUM);
      const cls2 = parseCls(typeof out2.text === 'string' ? out2.text : '');
      cls = pickBetterCls(cls, cls2);
    } catch { /* best-effort */ }
  }
  // Simulate the setLine call: aiCls is a deep copy of the kept cls.
  const aiCls = cls ? JSON.parse(JSON.stringify(cls)) : null;
  return { cls, aiCls };
}

function jsonText(obj) {
  return JSON.stringify(obj);
}

// A parseable, clearly better JSON response.
const GOOD_JSON = jsonText({
  panel: 'left_front_door',
  damage_type: 'scratch',
  severity: 'moderate',
  paint_damaged: true,
  pdr_candidate: false,
  blend_adjacent_recommended: true,
  ri_parts_needed: [],
  confidence: 'medium',
  notes: 'Visible scratch across the door.',
});

// A low-confidence, unknown-panel response (uncertain).
const BAD_JSON = jsonText({
  panel: 'unknown',
  damage_type: 'dent',
  severity: 'minor',
  paint_damaged: false,
  pdr_candidate: false,
  blend_adjacent_recommended: false,
  ri_parts_needed: [],
  confidence: 'low',
  notes: 'Photo is blurry.',
});

describe('second-look pipeline (classifyLine simulation)', () => {
  it('Scenario 1 — first pass unparseable: second look provides the answer', async () => {
    let call = 0;
    const callApi = async () => {
      call++;
      if (call === 1) return { text: 'NOT JSON' };       // first pass fails
      return { text: GOOD_JSON };                         // retry succeeds
    };
    const { cls, aiCls } = await runSecondLookPipeline(callApi);
    expect(call).toBe(2);
    expect(cls).not.toBeNull();
    expect(cls.panel).toBe('left_front_door');
    expect(cls.confidence).toBe('medium');
    // aiCls must be a deep copy equal to the kept answer.
    expect(aiCls).toEqual(cls);
    expect(aiCls).not.toBe(cls); // deep copy, not the same reference
  });

  it('Scenario 2 — first pass low-confidence, retry clearly better: retry is kept', async () => {
    let call = 0;
    const callApi = async () => {
      call++;
      if (call === 1) return { text: BAD_JSON };          // low-confidence first pass
      return { text: GOOD_JSON };                         // retry is better
    };
    const { cls, aiCls } = await runSecondLookPipeline(callApi);
    expect(call).toBe(2);
    expect(cls.panel).toBe('left_front_door');
    expect(cls.confidence).toBe('medium');
    expect(aiCls).toEqual(cls);
    expect(aiCls).not.toBe(cls);
  });

  it('Scenario 2b — first pass unknown panel, retry names the panel: retry is kept', async () => {
    const firstJson = jsonText({
      panel: 'unknown', damage_type: 'dent', severity: 'minor',
      paint_damaged: false, pdr_candidate: false, blend_adjacent_recommended: false,
      ri_parts_needed: [], confidence: 'low', notes: 'Cannot identify panel.',
    });
    let call = 0;
    const callApi = async () => {
      call++;
      if (call === 1) return { text: firstJson };
      return { text: GOOD_JSON };
    };
    const { cls, aiCls } = await runSecondLookPipeline(callApi);
    expect(cls.panel).toBe('left_front_door');
    expect(aiCls).toEqual(cls);
  });

  it('Scenario 3 — retry worse (unknown panel): first pass low-conf answer is kept', async () => {
    const lowConfFirstJson = jsonText({
      panel: 'hood', damage_type: 'dent', severity: 'minor',
      paint_damaged: false, pdr_candidate: false, blend_adjacent_recommended: false,
      ri_parts_needed: [], confidence: 'low', notes: 'Small dent.',
    });
    // Retry comes back unknown — a regression.
    let call = 0;
    const callApi = async () => {
      call++;
      if (call === 1) return { text: lowConfFirstJson };
      return { text: BAD_JSON };   // retry = unknown+low
    };
    const { cls, aiCls } = await runSecondLookPipeline(callApi);
    expect(call).toBe(2);
    // First pass (hood, low) must be kept over retry (unknown, low).
    expect(cls.panel).toBe('hood');
    expect(cls.confidence).toBe('low');
    expect(aiCls).toEqual(cls);
    expect(aiCls).not.toBe(cls);
  });

  it('Scenario 3b — retry also low-confidence on named panel: first pass kept', async () => {
    const lowConfFirstJson = jsonText({
      panel: 'tailgate', damage_type: 'scratch', severity: 'moderate',
      paint_damaged: true, pdr_candidate: false, blend_adjacent_recommended: false,
      ri_parts_needed: [], confidence: 'low', notes: 'Scratch on tailgate.',
    });
    const lowConfRetryJson = jsonText({
      panel: 'rear_bumper', damage_type: 'scratch', severity: 'minor',
      paint_damaged: true, pdr_candidate: false, blend_adjacent_recommended: false,
      ri_parts_needed: [], confidence: 'low', notes: 'Also uncertain.',
    });
    let call = 0;
    const callApi = async () => {
      call++;
      if (call === 1) return { text: lowConfFirstJson };
      return { text: lowConfRetryJson };
    };
    const { cls, aiCls } = await runSecondLookPipeline(callApi);
    expect(cls.panel).toBe('tailgate');   // first pass kept
    expect(aiCls).toEqual(cls);
  });

  it('Scenario 4 — retry throws: first pass answer is kept unchanged', async () => {
    const lowConfFirstJson = jsonText({
      panel: 'left_bedside', damage_type: 'dent', severity: 'minor',
      paint_damaged: false, pdr_candidate: false, blend_adjacent_recommended: false,
      ri_parts_needed: [], confidence: 'low', notes: 'Faint dent.',
    });
    let call = 0;
    const callApi = async () => {
      call++;
      if (call === 1) return { text: lowConfFirstJson };
      throw new Error('network failure');
    };
    const { cls, aiCls } = await runSecondLookPipeline(callApi);
    expect(call).toBe(2);
    // The error must be swallowed; first pass is kept.
    expect(cls.panel).toBe('left_bedside');
    expect(cls.confidence).toBe('low');
    expect(aiCls).toEqual(cls);
    expect(aiCls).not.toBe(cls);
  });

  it('aiCls snapshot is always a deep copy — mutating cls afterwards does not affect aiCls', async () => {
    let call = 0;
    const callApi = async () => {
      call++;
      if (call === 1) return { text: BAD_JSON };
      return { text: GOOD_JSON };
    };
    const { cls, aiCls } = await runSecondLookPipeline(callApi);
    // Simulate what classifyLine does: after autosave the estimator edits cls.
    cls.panel = 'right_rear_door';
    cls.notes = 'estimator override';
    // aiCls must still hold the original AI answer.
    expect(aiCls.panel).toBe('left_front_door');
    expect(aiCls.notes).toBe('Visible scratch across the door.');
  });

  it('no second call made when first pass is high confidence', async () => {
    const highConfJson = jsonText({
      panel: 'hood', damage_type: 'dent', severity: 'moderate',
      paint_damaged: false, pdr_candidate: false, blend_adjacent_recommended: false,
      ri_parts_needed: [], confidence: 'high', notes: 'Clear dent.',
    });
    let call = 0;
    const callApi = async () => { call++; return { text: highConfJson }; };
    const { cls } = await runSecondLookPipeline(callApi);
    expect(call).toBe(1);
    expect(cls.panel).toBe('hood');
    expect(cls.confidence).toBe('high');
  });
});
