import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { vinValid, decodeVinInfo } from '../lib/vin';
import { compressImageFile } from '../lib/photo';
import VinScanner from './VinScanner';
import WalkAroundCamera from './WalkAroundCamera';
import PinDialog, { SignatureBadge } from './PinDialog';
import {
  PANELS, DAMAGE, SEVS, PARTS,
  defaultRates, quoteTotals, lineHours, pdrEligible,
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
  const [rates, setRates] = useState(() => defaultRates());
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
  const [pinOpen, setPinOpen] = useState(false);
  const [lines, setLines] = useState([]);
  // photos not yet analyzed: { id, thumb, base64, dataUrl }
  const [photos, setPhotos] = useState([]);
  const [walkOpen, setWalkOpen] = useState(false);
  const [walkInitialMode, setWalkInitialMode] = useState('guided');
  const [armedDelete, setArmedDelete] = useState(null);
  const [hydrating, setHydrating] = useState(!!prefill?.quoteId);
  const [hydrateError, setHydrateError] = useState('');
  const hydratedRef = useRef(!prefill?.quoteId);
  // Snapshot prefill in a ref: hydration must run only when the quote id
  // changes, not every time the parent re-renders with fresh prefill fields
  // (that would clobber in-progress edits here).
  const prefillRef = useRef(prefill);
  prefillRef.current = prefill;
  useEffect(() => { if (committed) setWalkOpen(false); }, [committed]);
  useEffect(() => {
    if (!prefill?.quoteId) return;
    let live = true;
    api.quoterSync().then((s) => {
      const p = prefillRef.current || {};
      const q = (s?.quotes || []).find((x) => x && x.id === p.quoteId);
      if (!q) throw new Error('Quote not found');
      if (!live) return;
      setVin(String(q.vin || p.vin || '').toUpperCase());
      setStock(q.stock || p.stock || ''); setMiles(q.miles || p.miles || '');
      setEstimator(q.estimator || p.estimator || ''); setVehicleText(q.vehicle || p.vehicle || '');
      setVeh(q.veh || { year: '', make: '', model: '', trim: '', body: '' });
      const restored = Array.isArray(q.lines) ? q.lines.map((l) => ({ ...l, status: l.status || 'done', base64: '', thumb: l.thumb || '' })) : [];
      setLines(restored); setStep(restored.length ? 'quote' : 'confirm'); hydratedRef.current = true; setHydrating(false);
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
      if (s.rates) setRates((r) => ({ ...r, ...s.rates }));
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
  stateRef.current = { quoteId, vin, stock, miles, veh, estimator, vehicleText };
  const buildEntry = useCallback((ls) => {
    const t = quoteTotals(ls, rates);
    const cover = (ls[0] && ls[0].thumb) || '';
    const s = stateRef.current;
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
    };
  }, [rates]);

  const autosave = useCallback((ls) => {
    if (!hydratedRef.current) return;
    const s = stateRef.current;
    if (!s.quoteId) return;
    const entry = buildEntry(ls != null ? ls : linesRef.current);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      api.putQuote({ id: entry.id, data: entry }).catch(() => { /* offline — retries on next save */ });
    }, 600);
  }, [buildEntry]);

  useEffect(() => () => clearTimeout(saveTimer.current), []);

  // Create the quote id at confirm (like the old app did on entering walk).
  const ensureQuoteId = useCallback(() => {
    let id = stateRef.current.quoteId;
    if (!id) { id = newId('q'); setQuoteId(id); onQuoteId?.(id); }
    return id;
  }, [onQuoteId]);

  const goToPhotos = () => {
    ensureQuoteId();
    setStep('photos');
  };

  // ---------- damage photo capture ----------
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
        api.putQuotePhoto({ id, quoteId: qid, slot: 'dmg' + Date.now(), dataUrl: big })
          .catch(() => { /* retried implicitly by re-save; non-fatal */ });
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
    api.deleteQuotePhoto({ id }).catch(() => {});
  };

  const addDamageDataUrl = async (dataUrl) => {
    if (committed) return;
    const qid = ensureQuoteId();
    const id = newId('w');
    const thumb = await thumbFromDataUrl(dataUrl);
    setPhotos((prev) => [...prev, { id, thumb, base64: dataUrl.split(',')[1], dataUrl }]);
    api.putQuotePhoto({ id, quoteId: qid, slot: 'dmg', dataUrl }).catch((e) => {
      showToast && showToast(e.status === 413 ? 'Photo is too large.' : e.status === 409 ? 'This quote is committed.' : 'Photo could not be saved.');
    });
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

  // ---------- commit sign-off ----------
  const doCommit = ({ signerId, pin, forEmployeeId }) => {
    const id = ensureQuoteId();
    // Flush any pending autosave so the committed row has the latest data.
    clearTimeout(saveTimer.current);
    const entry = buildEntry(linesRef.current);
    return api
      .putQuote({ id: entry.id, data: entry })
      .catch(() => { /* commit still guards server-side; proceed */ })
      .then(() => api.commitQuote({ id, signerId, pin, forEmployeeId }))
      .then((r) => {
        setCommitted({ committedBy: r.committedBy, overriddenBy: r.overriddenBy || null });
        setPinOpen(false);
        showToast && showToast('Quote committed ✓');
      });
  };

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
            onCommit={() => setPinOpen(true)}
          />
        )}
        </>}
      </div>

      {pinOpen && (
        <PinDialog
          title="Commit quote"
          subtitle={vin ? `${vin} · ${vehicleText || 'vehicle'}` : (vehicleText || '')}
          onCommit={doCommit}
          onClose={() => setPinOpen(false)}
        />
      )}
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
function PhotosStep({ photos, lineCount, committed, armedDelete, onAdd, onWalk, onDamage, onRemove, onAnalyze, onBack, onSeeQuote }) {
  return (
    <>
      <div className="card">
        <div className="card-title">WALK-AROUND PHOTOS · {photos.length}</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, marginTop: 6 }}>
          Circle the truck and shoot everything — sides, corners, interior, wheels. Photos save automatically as you go.
        </div>
        {!committed && <button className="btn btn-dark" style={{ marginTop: 10 }} onClick={onWalk}>📷 TAKE PHOTOS</button>}
      </div>
      <div className="card">
        <div className="card-title">DAMAGE FOR THE QUOTE · {photos.length}</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, marginTop: 6 }}>
          Found damage? Take a close-up of each spot — these go to the AI for the body quote.
        </div>
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
function QuoteEditor({ lines, rates, totals, committed, onStartEdit, onCancelEdit, onApplyEdit, onSetEdit, onEditBase, onRerun, onDelete, onTogglePart, onAddMore, onCommit }) {
  const locked = !!committed;
  return (
    <>
      <div className="card">
        <div className="card-title">QUOTE TOTAL</div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 6 }}>
          <span className="oswald" style={{ fontWeight: 700, fontSize: 26 }}>{fmt1(totals.hrs)}</span>
          <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>total hours</span>
          <span style={{ flex: 1 }} />
          <span className="mono" style={{ fontSize: 15, fontWeight: 700 }}>${totals.usd.toLocaleString()}</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, marginTop: 10 }}>
          <Bucket label="BODY" hrs={totals.B} usd={totals.usdB} />
          <Bucket label="PAINT" hrs={totals.P} usd={totals.usdP} />
          <Bucket label="R&I" hrs={totals.RI} usd={totals.usdRI} />
          <Bucket label="PDR" hrs={null} usd={totals.usdPDR} />
        </div>
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

      {locked ? (
        <div className="card" style={{ borderColor: 'var(--green)', background: '#e8f3ea' }}>
          <SignatureBadge committedBy={committed.committedBy} overriddenBy={committed.overriddenBy} />
          <div style={{ fontSize: 9.5, color: 'var(--muted)', marginTop: 4 }}>
            Committed and locked. A correction is a new record, not an edit.
          </div>
        </div>
      ) : (
        <>
          <button className="btn btn-outline-brown" onClick={onAddMore}>+ Add more damage photos</button>
          <button
            className={'btn btn-green' + (lines.length ? '' : ' disabled')}
            style={{ height: 48, opacity: lines.length ? 1 : 0.6 }}
            onClick={() => lines.length && onCommit()}
          >
            ✍ Commit quote
          </button>
        </>
      )}
    </>
  );
}

function Bucket({ label, hrs, usd }) {
  return (
    <div style={{ background: 'var(--panel)', borderRadius: 8, padding: '7px 6px', textAlign: 'center' }}>
      <div style={{ fontSize: 8.5, fontWeight: 700, color: 'var(--muted)', letterSpacing: 0.6 }}>{label}</div>
      {hrs != null && <div className="oswald" style={{ fontWeight: 700, fontSize: 15 }}>{fmt1(hrs)}</div>}
      <div className="mono" style={{ fontSize: 10.5, color: 'var(--brown)', marginTop: hrs != null ? 0 : 4 }}>${(usd || 0).toLocaleString()}</div>
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
