import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import QuoteScreen from './QuoteScreen';
import PinDialog, { SignatureBadge } from './PinDialog';
import VinScanner from './VinScanner';
import { prefetchZxing } from '../lib/zxingDecode';
import WalkAroundCamera from './WalkAroundCamera';
import { vinValid, decodeVinInfo, scannedVinDecision } from '../lib/vin';

// Intake tab — VIN-keyed intake with the 9-item RO-ready sign-off and PIN
// commit. Completing the RO-ready checklist (9/9) is what gates completed_at,
// which feeds the In-Take Quotes bucket. The persistence shape matches the old
// client (a `steps` key may still exist in saved data for compat; it is no
// longer rendered or required).

// ---------- local cache (offline resume, per VIN, cap 40) ----------
const LS_INTAKE = 'trqc.intake.cache.v2';

function loadCache() {
  try {
    return JSON.parse(localStorage.getItem(LS_INTAKE) || '{}') || {};
  } catch {
    return {};
  }
}
function saveToCache(it) {
  if (!it || !it.vin) return;
  const cache = loadCache();
  cache[it.vin] = it;
  const keys = Object.keys(cache);
  if (keys.length > 40) {
    keys.sort((a, b) => (cache[a].ts || 0) - (cache[b].ts || 0));
    delete cache[keys[0]];
  }
  try {
    localStorage.setItem(LS_INTAKE, JSON.stringify(cache));
  } catch {
    /* storage full — the server copy is the source of truth anyway */
  }
}

const newId = () => 'in' + Date.now() + Math.random().toString(36).slice(2, 6);

function blankIntake(vin) {
  return {
    id: newId(),
    vin: String(vin || '').toUpperCase(),
    stock: '',
    vehicle: '',
    miles: '',
    estimator: '',
    steps: {
      1: [false, false, false],
      2: [false, false, false, false, false, false],
      3: [false, false, false, false, false, false],
      4: [false, false, false, false, false],
    },
    roReady: [false, false, false, false, false, false, false, false, false],
    notes: '',
    ts: 0, // ts 0 = untouched draft, so a server copy always wins on resume
    completedAt: null,
    committedBy: null,
    overriddenBy: null,
    quoteId: null,
    mddTags: false,
  };
}

export default function IntakeScreen({ showToast, openVin, onOpenVinConsumed }) {
  const [vin, setVin] = useState('');
  const [intake, setIntake] = useState(null);
  const [quoting, setQuoting] = useState(false); // Body Quoter sub-view
  const [standaloneQuote, setStandaloneQuote] = useState(null); // recent-quote reopen from landing
  const [homeRows, setHomeRows] = useState([]);
  const [homeSearch, setHomeSearch] = useState('');
  const [scanning, setScanning] = useState(false);
  const [, setVinOverride] = useState(false);
  const [vinMessage, setVinMessage] = useState('');
  const [walkOpen, setWalkOpen] = useState(false);
  const [, setDecoding] = useState(false);
  const [estimators, setEstimators] = useState([]);
  const [quoteSummary, setQuoteSummary] = useState(null);
  const [quoteNotes, setQuoteNotes] = useState('');
  const quoteRowRef = useRef(null); // full quote entry backing the notes editor
  const notesTimerRef = useRef(null);
  // Landing "QUOTE DETAILS" prefill + recent quotes (mirrors the old home)
  const [homeStock, setHomeStock] = useState('');
  const [homeMiles, setHomeMiles] = useState('');
  const [homeEstimator, setHomeEstimator] = useState('');
  const [homeEstCustom, setHomeEstCustom] = useState(false);
  const [estCustom, setEstCustom] = useState(false);
  const [homeMddTags, setHomeMddTags] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [recentQuotes, setRecentQuotes] = useState([]);
  const [dupWarn, setDupWarn] = useState(null); // { vin, intakeRow, quoteRow, proceed }
  const intakeRef = useRef(null);
  intakeRef.current = intake;
  useEffect(() => { prefetchZxing(); }, []); // warm the barcode decoder before the scanner opens
  useEffect(() => { if (!intake) api.listIntakes().then((j) => setHomeRows(j?.intakes || [])).catch(() => {}); }, [intake]);
  useEffect(() => {
    if (intake) return;
    api.quoterSync().then((j) => {
      const qs = (j?.quotes || []).slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
      setRecentQuotes(qs);
    }).catch(() => {});
  }, [intake]);
  useEffect(() => {
    api.signers().then((j) => setEstimators((j?.signers || []).filter((s) => s.active !== false).map((s) => s.name || s.displayName).filter(Boolean))).catch(() => {});
  }, []);
  const intakeQuoteId = intake?.quoteId ?? null;
  const intakeVin = intake?.vin ?? null;
  useEffect(() => {
    if (intakeVin == null) { setQuoteSummary(null); return; }
    let live = true;
    api.quoterSync().then((j) => {
      if (!live) return;
      const qs = (j?.quotes || []).filter((q) => q && (intakeQuoteId ? q.id === intakeQuoteId : String(q.vin || '').toUpperCase() === intakeVin));
      const q = qs.sort((a, b) => (b.ts || 0) - (a.ts || 0))[0];
      if (!q) { quoteRowRef.current = null; setQuoteNotes(''); return setQuoteSummary(null); }
      quoteRowRef.current = q;
      setQuoteNotes(q.notes || '');
      // Backfill mileage from the linked quote when the intake has none, so
      // the miles field is always populated when the quote knows it.
      const cur = intakeRef.current;
      if (cur && !String(cur.miles || '').trim() && String(q.miles || '').trim() && !cur.committedBy) {
        saveIntake({ miles: String(q.miles) });
      }
      const lines = Array.isArray(q.lines) ? q.lines.filter((l) => l && l.cls) : [];
      api.quotePhotos(q.id).then((p) => live && setQuoteSummary({ id: q.id, lineCount: lines.length, hrs: q.totals?.hrs || 0, notes: q.notes || '', photoCount: (p?.photos || []).length })).catch(() => live && setQuoteSummary({ id: q.id, lineCount: lines.length, hrs: q.totals?.hrs || 0, notes: q.notes || '', photoCount: 0 }));
    }).catch(() => {});
    return () => { live = false; };
  }, [intakeQuoteId, intakeVin]);

  // Notes live on the linked quote so they show up everywhere the quote does.
  // Saved via a notes-only PATCH (atomic on the server) so it can never
  // clobber lines/totals the quote screen wrote in the meantime.
  const saveQuoteNotes = useCallback((v) => {
    const next = String(v || '').slice(0, 2000);
    setQuoteNotes(next);
    const cur = intakeRef.current;
    const id = quoteRowRef.current?.id || cur?.quoteId;
    if (!id) return;
    if (quoteRowRef.current) quoteRowRef.current = { ...quoteRowRef.current, notes: next };
    setQuoteSummary((s) => (s ? { ...s, notes: next } : s));
    clearTimeout(notesTimerRef.current);
    notesTimerRef.current = setTimeout(() => {
      api.patchQuoteNotes({
        id, notes: next,
        meta: { vin: cur?.vin || '', stock: cur?.stock || '', miles: cur?.miles || '', vehicle: cur?.vehicle || '', estimator: cur?.estimator || '' },
      }).catch((e) => {
        if (e?.status === 409) showToast?.('This quote is committed — notes are locked.');
      });
    }, 600);
  }, [showToast]);
  useEffect(() => () => clearTimeout(notesTimerRef.current), []);

  // Adopt a server row for a VIN, honoring the old conflict rule.
  const refreshFromServer = useCallback(async (v) => {
    try {
      const j = await api.getIntake(v);
      if (!j || !j.found) return;
      const cur = intakeRef.current;
      if (!cur || cur.vin !== v) return;
      if ((j.updatedAt || 0) <= (cur.ts || 0)) {
        // Local copy is newer — adopt the server row id so our next save
        // updates that row instead of creating a duplicate for the same VIN.
        if ((j.id && j.id !== cur.id) || j.committedBy !== cur.committedBy) {
          setIntake((s) => {
            const next = { ...s, id: j.id || s.id, committedBy: j.committedBy || null, overriddenBy: j.overriddenBy || null };
            saveToCache(next);
            return next;
          });
        }
        return;
      }
      const d = j.data || {};
      const it = {
        id: j.id,
        vin: j.vin,
        stock: j.stock || '',
        vehicle: j.vehicle || '',
        miles: j.miles || '',
        estimator: j.estimator || '',
        steps: {
          1: (d.steps && d.steps['1']) || [],
          2: (d.steps && d.steps['2']) || [],
          3: (d.steps && d.steps['3']) || [],
          4: (d.steps && d.steps['4']) || [],
        },
        roReady: Array.isArray(d.roReady) ? d.roReady : [],
        notes: d.notes || '',
        ts: j.updatedAt || Date.now(),
        completedAt: j.completedAt || null,
        committedBy: j.committedBy || null,
        overriddenBy: j.overriddenBy || null,
        quoteId: j.quoteId || null,
        mddTags: !!d.mddTags,
      };
      saveToCache(it);
      setIntake(it);
    } catch {
      /* offline — local copy stands */
    }
  }, []);

  // Persist every change: cache locally, then push to the server (unless noPush).
  const saveIntake = useCallback((patch, opts) => {
    const noPush = !!(opts && opts.noPush);
    setIntake((s) => {
      if (!s) return s;
      if (s.committedBy) return s;
      const next = { ...s, ...patch, ts: noPush ? s.ts || 0 : Date.now() };
      saveToCache(next);
      if (!noPush && String(next.vin || '').length >= 6) {
        api
          .putIntake({
            id: next.id,
            vin: next.vin,
            stock: next.stock,
            vehicle: next.vehicle,
            miles: next.miles,
            estimator: next.estimator,
            quoteId: next.quoteId || null,
            ts: next.ts,
            data: {
              steps: { 1: next.steps[1], 2: next.steps[2], 3: next.steps[3], 4: next.steps[4] },
              roReady: next.roReady,
              photoCount: 0,
              notes: next.notes || '',
              mddTags: !!next.mddTags,
            },
          })
          .catch(() => {
            /* offline — the local cache keeps the work for resume */
          });
      }
      return next;
    });
  }, []);

  // Open an intake for a VIN: prefer the local cache, then fetch the server copy.
  const openFor = useCallback(
    (raw, seed) => {
      const v = String(raw || '').trim().toUpperCase();
      const cache = loadCache();
      let it = v && cache[v] ? cache[v] : blankIntake(v);
      // Seed the landing QUOTE DETAILS onto a fresh (untouched) intake only.
      if (seed && (!it.ts || it.ts === 0)) {
        it = {
          ...it,
          stock: it.stock || seed.stock || '',
          miles: it.miles || seed.miles || '',
          estimator: it.estimator || seed.estimator || '',
          mddTags: it.mddTags || !!seed.mddTags,
        };
      }
      setIntake(it);
      if (v.length >= 6) refreshFromServer(v);
    },
    [refreshFromServer]
  );
  const openExisting = (row) => { setVin(row.vin); openFor(row.vin); };
  // Auto-open a VIN handed in from another tab (e.g. tapping an In-Take Quote
  // card on the Vehicles tab). Consumed once so back-navigation still works.
  useEffect(() => {
    if (!openVin) return;
    setVin(openVin);
    openFor(openVin);
    onOpenVinConsumed?.();
  }, [openVin, openFor, onOpenVinConsumed]);
  // Commit to opening an intake for an already-validated VIN, seeding the
  // landing QUOTE DETAILS. Used by the plain (no-duplicate) path and by the
  // quote-only "Start intake anyway" path (both create a fresh intake, so the
  // seeds apply). A VIN with an existing intake never reaches here — that
  // dialog only offers Resume.
  const beginIntake = (v, overridden) => {
    setVinMessage(overridden ? 'Check digit override accepted — verify against the door label.' : 'Valid VIN');
    setVin(v); setVinOverride(overridden);
    openFor(v, { stock: homeStock, miles: homeMiles, estimator: homeEstimator, mddTags: homeMddTags });
  };
  const acceptVin = (raw, overridden = false) => {
    const v = String(raw || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (v.length !== 17) { setVinMessage('VIN must be 17 characters to start a new intake.'); return; }
    if (!vinValid(v) && !overridden) { setVinMessage('Invalid VIN check digit. Verify the VIN or use check digit override.'); return; }
    // Duplicate-VIN guard: an intake or a quote for this VIN already exists in
    // the data already fetched for the landing lists. Warn before starting so
    // the tech can resume/open the existing record instead of duplicating it.
    const intakeRow = homeRows.find((r) => String(r.vin || '').toUpperCase() === v) || null;
    const quoteRow = recentQuotes.find((q) => String(q.vin || '').toUpperCase() === v) || null;
    if (intakeRow || quoteRow) {
      setDupWarn({ vin: v, intakeRow, quoteRow, overridden });
      return;
    }
    beginIntake(v, overridden);
  };
  const ensureIntakeQuote = async () => {
    if (intake?.quoteId) return intake.quoteId;
    const id = 'q' + Date.now() + Math.random().toString(36).slice(2, 6);
    const r = await api.linkIntakeQuote(intake.id, id);
    const canonical = r?.quoteId || id;
    setIntake((s) => s ? { ...s, quoteId: canonical } : s);
    return canonical;
  };
  // Same as ensureIntakeQuote, but explains failures with a toast instead of
  // dying silently (the camera/quote buttons looked "dead" otherwise).
  // Returns the quote id on success, null on failure.
  const ensureIntakeQuoteWithFeedback = async () => {
    try {
      return await ensureIntakeQuote();
    } catch (e) {
      if (e?.status === 409) {
        showToast?.('This intake was already committed — it is locked. Refreshing…');
        refreshFromServer(intake.vin);
      } else if (e?.status === 401) {
        showToast?.('You are signed out — sign in again first.');
      } else {
        showToast?.('Could not reach the server — check your connection and try again.');
      }
      return null;
    }
  };
  const decodeIntake = useCallback(async (v) => {
    // Read vehicle through the ref so this callback stays stable — otherwise
    // every keystroke in the vehicle field would recreate it.
    if (!v || v.length !== 17 || intakeRef.current?.vehicle) return;
    setDecoding(true);
    const desc = await decodeVinInfo(v);
    if (desc) saveIntake({ vehicle: desc });
    setDecoding(false);
  }, [saveIntake]);
  useEffect(() => { if (intakeVin?.length === 17) decodeIntake(intakeVin); }, [intakeVin, decodeIntake]); // best effort

  // Debounced VIN entry — open the intake once the VIN looks real.
  const vinTimer = useRef(null);
  const onVinChange = (raw) => {
    const v = raw.toUpperCase();
    setVin(v);
    clearTimeout(vinTimer.current);
    if (!intake || intake.vin !== v.trim()) {
      vinTimer.current = setTimeout(() => openFor(v), 350);
    }
  };
  useEffect(() => () => clearTimeout(vinTimer.current), []);

  const [pinOpen, setPinOpen] = useState(false);
  const locked = !!(intake && intake.committedBy); // committed → read-only

  const doCommit = ({ signerId, pin, forEmployeeId }) =>
    api.commitIntake({ id: intake.id, signerId, pin, forEmployeeId }).then((r) => {
      setIntake((s) => {
        const next = { ...s, committedBy: r.committedBy, overriddenBy: r.overriddenBy || null };
        saveToCache(next);
        return next;
      });
      setPinOpen(false);
      showToast && showToast('Intake committed ✓');
    });

  const cleanVin = vin.trim().toUpperCase();
  const started = intake && cleanVin.length >= 6;

  // Walk-around photos for the opened intake (thumbnails shown inline).
  // Refreshed when the camera closes so new shots appear immediately.
  const [intakePhotos, setIntakePhotos] = useState([]);
  const [lightbox, setLightbox] = useState(null); // enlarged photo URL
  const photoQuoteId = intake?.quoteId ?? null;
  useEffect(() => {
    if (!photoQuoteId || walkOpen) { if (!photoQuoteId) setIntakePhotos([]); return; }
    let live = true;
    api.quotePhotos(photoQuoteId).then((j) => { if (live) setIntakePhotos(j?.photos || []); }).catch(() => {});
    return () => { live = false; };
  }, [photoQuoteId, walkOpen]);

  // Body Quoter sub-view — opens over the checklist for the current VIN and
  // returns here on back. Keeps the Intake tab as the single host.
  if (quoting && intake) {
    return (
      <QuoteScreen
        prefill={{ vin: intake.vin, stock: intake.stock, vehicle: intake.vehicle, estimator: intake.estimator, miles: intake.miles, quoteId: intake.quoteId, startAtPhotos: quoting === 'photos' }}
        onClose={() => setQuoting(false)}
        onQuoteId={(id) => saveIntake({ quoteId: id })}
        showToast={showToast}
      />
    );
  }

  // Reopen a saved quote directly from the landing "RECENT QUOTES" list.
  if (standaloneQuote) {
    return (
      <QuoteScreen
        prefill={standaloneQuote}
        onClose={() => setStandaloneQuote(null)}
        showToast={showToast}
      />
    );
  }

  if (!started) {
    const recentSearch = homeSearch.trim().toUpperCase();
    const recentFiltered = recentQuotes.filter((q) => !recentSearch || [q.vin, q.stock, q.vehicle, q.estimator].join(' ').toUpperCase().includes(recentSearch));
    const knownEst = homeEstimator && estimators.includes(homeEstimator);
    const missing = [
      !homeStock.trim() && 'Stock #',
      !homeMiles.trim() && 'Miles',
      !homeEstimator.trim() && 'Estimator',
      !homeMddTags && 'MDD tags checkbox',
    ].filter(Boolean);
    const homeReady = missing.length === 0;
    return (
      <div className="screen">
        <div className="screen-topbar"><div className="screen-title-row"><span className="screen-title">Intake</span><span className="mono" style={{ fontSize: 9.5, color: 'var(--muted)' }}>TR-INTAKE-V2</span></div></div>
        <div className="screen-body">
          {/* QUOTE DETAILS */}
          <div className="card">
            <div className="card-title">QUOTE DETAILS</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 8 }}>
              <div>
                <div className="field-label">STOCK #</div>
                <input className="input mono" value={homeStock} placeholder="T-0000" autoCapitalize="characters" onChange={(e) => setHomeStock(e.target.value.toUpperCase())} />
              </div>
              <div>
                <div className="field-label">MILES</div>
                <input className="input mono" value={homeMiles} inputMode="numeric" placeholder="e.g. 45000" onChange={(e) => setHomeMiles(e.target.value.replace(/[^0-9]/g, ''))} />
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <div className="field-label">ESTIMATOR</div>
                <select className="input" value={knownEst ? homeEstimator : (homeEstCustom || homeEstimator ? '__custom' : '')} onChange={(e) => { if (e.target.value === '__custom') { setHomeEstCustom(true); setHomeEstimator(''); } else { setHomeEstCustom(false); setHomeEstimator(e.target.value); } }}>
                  <option value="">Select name…</option>
                  {estimators.map((name) => <option key={name} value={name}>{name}</option>)}
                  <option value="__custom">Other / enter manually</option>
                </select>
                {(homeEstCustom || (homeEstimator && !knownEst)) && <input className="input" style={{ marginTop: 6 }} value={homeEstimator} placeholder="Estimator name" onChange={(e) => setHomeEstimator(e.target.value)} />}
              </div>
            </div>
          </div>

          {/* MDD tags */}
          <label className="card" style={{ display: 'flex', alignItems: 'center', gap: 11, cursor: 'pointer' }}>
            <input type="checkbox" checked={homeMddTags} onChange={(e) => setHomeMddTags(e.target.checked)} style={{ width: 22, height: 22, flex: 'none', accentColor: 'var(--red)', cursor: 'pointer' }} />
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>Are both Key &amp; Vehicle MDD tags present?</span>
          </label>

          {/* SCAN VIN — only once the quote details above are filled in */}
          <button
            className="btn btn-red"
            style={{ height: 60, fontSize: 20, letterSpacing: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, opacity: homeReady ? 1 : 0.45 }}
            aria-disabled={!homeReady}
            onClick={() => {
              if (!homeReady) { showToast?.(`Fill in first: ${missing.join(', ')}`); return; }
              setScanning(true);
            }}
          >
            <span aria-hidden="true">📷</span> SCAN VIN
          </button>
          {!homeReady && <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center', marginTop: -6 }}>Needed before scanning: {missing.join(' · ')}</div>}

          {/* OR divider */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
            <span className="oswald" style={{ fontWeight: 600, fontSize: 12, letterSpacing: 2, color: 'var(--muted)' }}>OR</span>
            <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
          </div>

          {/* ENTER VIN MANUALLY */}
          <button className="btn btn-outline-brown" style={{ height: 50, fontSize: 16, letterSpacing: 1 }} onClick={() => setManualOpen((v) => !v)}>ENTER VIN MANUALLY</button>
          {manualOpen && (
            <div className="card">
              <div className="field-label">17-CHARACTER VIN</div>
              <input className="input mono" value={vin} maxLength={17} autoFocus onChange={(e) => { setVin(e.target.value.toUpperCase()); setVinMessage(''); }} placeholder="17-character VIN" autoCapitalize="characters" autoCorrect="off" spellCheck={false} />
              <div style={{ fontSize: 11, marginTop: 7, color: vinMessage === 'Valid VIN' ? 'var(--green)' : 'var(--red)' }}>{vin.length}/17 {vinMessage}</div>
              <button className="btn btn-dark" style={{ marginTop: 9 }} disabled={vin.length !== 17} onClick={() => acceptVin(vin)}>Start / Resume</button>
              <button className="btn btn-outline" style={{ marginTop: 7 }} disabled={vin.length !== 17 || vinValid(vin)} onClick={() => acceptVin(vin, true)}>Use check digit override</button>
            </div>
          )}

          {/* RECENT QUOTES */}
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 8 }}>
            <div className="oswald" style={{ fontWeight: 700, fontSize: 13.5, letterSpacing: 2, color: 'var(--muted)' }}>RECENT QUOTES</div>
            <span style={{ color: 'var(--red)', fontWeight: 600, fontSize: 13 }}>All quotes ({recentQuotes.length}) →</span>
          </div>
          {recentQuotes.length > 5 && (
            <div style={{ position: 'relative' }}>
              <span aria-hidden="true" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 15, color: 'var(--red)', pointerEvents: 'none' }}>🔍</span>
              <input
                className="input"
                style={{ paddingLeft: 38, background: '#fff', border: '2px solid var(--red)', borderRadius: 11, fontWeight: 600, boxShadow: '0 1px 4px rgba(176,50,42,.12)' }}
                placeholder="Search VIN, stock, vehicle, estimator…"
                value={homeSearch}
                onChange={(e) => setHomeSearch(e.target.value)}
              />
            </div>
          )}
          {!recentQuotes.length ? (
            <div className="empty-note">No quotes yet — scan your first truck.</div>
          ) : !recentFiltered.length ? (
            <div className="empty-note">No saved quotes match.</div>
          ) : (
            recentFiltered.slice(0, homeSearch ? 20 : 6).map((q) => (
              <RecentQuoteCard key={q.id} quote={q} onClick={() => setStandaloneQuote({ vin: q.vin, stock: q.stock, vehicle: q.vehicle, estimator: q.estimator, miles: q.miles, quoteId: q.id })} />
            ))
          )}

          {/* In-progress intakes (resume). Completed intakes live under the
              Vehicles tab's In-Take Quotes bucket, so they're omitted here. */}
          {(() => {
            const rows = homeRows.filter((r) => !r.completedAt);
            if (!rows.length) return null;
            return (
              <div>
                <div className="card-title" style={{ padding: '7px 2px' }}>IN PROGRESS INTAKES · {rows.length}</div>
                {rows.map((r) => <IntakeHomeCard key={r.id} row={r} onClick={() => openExisting(r)} />)}
              </div>
            );
          })()}
        </div>
        {scanning && <VinScanner onDetected={(v, ok) => {
          setScanning(false);
          // Never silently seed from a bad scan: block invalid check digits and
          // route to manual entry so the override is an explicit user choice.
          const d = scannedVinDecision(v, ok);
          if (d.seed) {
            acceptVin(d.vin);
          } else {
            setVin(d.vin);
            setManualOpen(true);
            setVinMessage(d.message);
          }
        }} onCancel={() => setScanning(false)} />}
        {dupWarn && (
          <DuplicateVinDialog
            warn={dupWarn}
            onOpenIntake={(row) => { setDupWarn(null); openExisting(row); }}
            onOpenQuote={(q) => { setDupWarn(null); setStandaloneQuote({ vin: q.vin, stock: q.stock, vehicle: q.vehicle, estimator: q.estimator, miles: q.miles, quoteId: q.id }); }}
            onStartAnyway={() => { const { vin: v, overridden } = dupWarn; setDupWarn(null); beginIntake(v, overridden); }}
            onCancel={() => setDupWarn(null)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="screen">
      <div className="screen-topbar" style={{ padding: '8px 14px 10px' }}>
        <div className="screen-title-row">
          <span className="screen-title">Intake</span>
          <span className="mono" style={{ fontSize: 9.5, color: 'var(--muted)' }}>TR-INTAKE-V2</span>
        </div>
        <input
          className="input mono"
          placeholder="VIN…"
          value={vin}
          maxLength={17}
          onChange={(e) => onVinChange(e.target.value)}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
        />
      </div>

      <div className="screen-body">
        {!started && (
          <div className="empty-note">Enter a VIN to start or resume an intake.</div>
        )}

        {started && (
          <>
            {/* vehicle detail fields */}
            <div className="card">
              <div className="card-title">TRUCK</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 6 }}>
                <div>
                  <div className="field-label">STOCK #</div>
                  <input
                    className="input"
                    value={intake.stock}
                    disabled={locked}
                    onChange={(e) => saveIntake({ stock: e.target.value.trim().toUpperCase() })}
                  />
                </div>
                <div>
                  <div className="field-label">MILES</div>
                  <input
                    className="input"
                    value={intake.miles}
                    disabled={locked}
                    onChange={(e) => saveIntake({ miles: e.target.value.trim() })}
                  />
                </div>
                <div style={{ gridColumn: '1 / span 2' }}>
                  <div className="field-label">VEHICLE</div>
                  <input
                    className="input"
                    value={intake.vehicle}
                    disabled={locked}
                    onChange={(e) => saveIntake({ vehicle: e.target.value })}
                  />
                </div>
                <div style={{ gridColumn: '1 / span 2' }}>
                  <div className="field-label">ESTIMATOR</div>
                   <select disabled={locked} className="input" value={estimators.includes(intake.estimator) ? intake.estimator : (estCustom || intake.estimator ? '__custom' : '')} onChange={(e) => { if (e.target.value === '__custom') { setEstCustom(true); saveIntake({ estimator: '' }); } else { setEstCustom(false); saveIntake({ estimator: e.target.value }); } }}>
                     <option value="">Select estimator…</option>
                     {estimators.map((name) => <option key={name} value={name}>{name}</option>)}
                     <option value="__custom">Other / enter manually</option>
                   </select>
                    {(estCustom || (intake.estimator !== '' && !estimators.includes(intake.estimator))) && <input disabled={locked} className="input" style={{marginTop:6}} value={intake.estimator} placeholder="Estimator name" onChange={(e) => saveIntake({ estimator: e.target.value })} />}
                </div>
                <label style={{ gridColumn: '1 / span 2', display:'flex', alignItems:'center', gap:9, padding:'10px', border:'1px solid var(--border)', borderRadius:9, fontSize:12, fontWeight:600 }}>
                  <input type="checkbox" checked={!!intake.mddTags} disabled={locked} onChange={e => saveIntake({ mddTags: e.target.checked })} />
                  Are both Key &amp; Vehicle MDD tags present?
                </label>
              </div>
            </div>
            <div className="card">
              <div className="card-title">WALK-AROUND PHOTOS · {intakePhotos.length} / 24</div>
              <div style={{fontSize:11,color:'var(--muted)',marginTop:5}}>Capture the truck from every angle before the quote is finalized.</div>
              {intakePhotos.length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginTop: 9 }}>
                  {intakePhotos.map((p) => (
                    <img
                      key={p.id}
                      src={`/api/quoter/photo?id=${encodeURIComponent(p.id)}`}
                      alt={p.slot || 'walk-around photo'}
                      loading="lazy"
                      onClick={() => setLightbox(`/api/quoter/photo?id=${encodeURIComponent(p.id)}`)}
                      style={{ width: '100%', aspectRatio: '4 / 3', objectFit: 'cover', borderRadius: 7, border: '1px solid var(--border)', cursor: 'pointer' }}
                    />
                  ))}
                </div>
              )}
              {!locked && <button className="btn btn-dark" style={{marginTop:9}} onClick={async () => { if (await ensureIntakeQuoteWithFeedback()) setWalkOpen(true); }}>TAKE WALK-AROUND PHOTOS</button>}
              <div style={{ marginTop: 10 }}>
                <div className="field-label">NOTES</div>
                {locked || quoteRowRef.current?.committedBy ? (
                  (quoteNotes || '').trim()
                    ? <div style={{ padding: '9px 11px', borderRadius: 9, background: 'var(--panel)', border: '1px solid var(--border)', fontSize: 12.5, color: 'var(--brown)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{quoteNotes.trim()}</div>
                    : <div style={{ fontSize: 11, color: 'var(--muted)' }}>No notes.</div>
                ) : (intake.quoteId || quoteRowRef.current) ? (
                  <textarea
                    className="input"
                    rows={3}
                    maxLength={2000}
                    placeholder="Anything worth remembering about this truck…"
                    value={quoteNotes}
                    onChange={(e) => saveQuoteNotes(e.target.value)}
                    style={{ resize: 'none', minHeight: 74, fontFamily: 'inherit', lineHeight: 1.4 }}
                  />
                ) : (
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>Take a walk-around photo or start the body quote first — notes save with the quote.</div>
                )}
              </div>
            </div>
            {/* Body Quoter */}
            <div className="card" style={quoteSummary ? { borderLeft: '4px solid var(--red)' } : undefined}>
              <div className="card-title">{quoteSummary ? 'BODY QUOTE LINKED' : 'BODY QUOTER'}</div>
              {quoteSummary ? (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 12, fontWeight: 700 }}><span>{quoteSummary.lineCount} lines</span><span>{quoteSummary.hrs} hr of work</span><span>{quoteSummary.photoCount} photos</span></div>
                  {(quoteSummary.notes || '').trim() && <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 8, background: 'var(--panel)', fontSize: 11.5, color: 'var(--brown)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}><b style={{ fontSize: 9.5, color: 'var(--muted)', letterSpacing: 0.8 }}>NOTES</b><br />{quoteSummary.notes.trim()}</div>}
                  <button className="btn btn-outline-red" style={{ marginTop: 9 }} onClick={() => { setQuoting(true); }}>REOPEN QUOTE</button>
                </>
              ) : (
                <>
                  <button className="btn btn-red" style={{ marginTop: 9 }} disabled={locked || !intake.stock.trim() || !String(intake.miles).trim() || !intake.estimator.trim() || !intake.mddTags} onClick={async () => { if (await ensureIntakeQuoteWithFeedback()) setQuoting('photos'); }}>
                    Photo Damage
                  </button>
                  <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 6 }}>Take close-ups of each damage spot, then run the assessment for hours &amp; price.</div>
                  {!intake.stock.trim() || !String(intake.miles).trim() || !intake.estimator.trim() || !intake.mddTags ? <div style={{ fontSize: 10, color: 'var(--red)', marginTop: 6 }}>Complete stock #, miles, estimator, and confirm both MDD tags before photographing damage.</div> : null}
                </>
              )}
            </div>

            {/* Commit sign-off: PIN sign-off marks the intake complete and locks it. */}
            <div className="card">
              {locked ? (
                <div style={{ padding: '10px 12px', borderRadius: 8, background: '#e8f3ea', border: '1px solid var(--green)' }}>
                  <SignatureBadge committedBy={intake.committedBy} overriddenBy={intake.overriddenBy} />
                  <div style={{ fontSize: 9.5, color: 'var(--muted)', marginTop: 4 }}>
                    Committed and locked{intake.completedAt ? ' · ' + new Date(intake.completedAt).toLocaleDateString() : ''}. A correction is a new record, not an edit.
                  </div>
                </div>
              ) : (
                <>
                  <button className="btn btn-green" style={{ height: 46 }} onClick={() => setPinOpen(true)}>
                    ✍ Commit intake
                  </button>
                  <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 6, textAlign: 'center' }}>
                    Committing signs off the intake with your PIN and locks it.
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </div>

      {pinOpen && (
        <PinDialog
          title="Commit intake"
          subtitle={intake ? `${intake.vin} · ${intake.vehicle || 'vehicle'}` : ''}
          onCommit={doCommit}
          onClose={() => setPinOpen(false)}
        />
      )}
      {walkOpen && (
        <WalkAroundCamera quoteId={intake.quoteId} committed={locked} onClose={() => setWalkOpen(false)} showToast={showToast} />
      )}
      {lightbox && (
        <div className="lightbox-overlay" onClick={() => setLightbox(null)}>
          <div className="lightbox-img" style={{ backgroundImage: `url("${lightbox}")` }} />
        </div>
      )}
    </div>
  );
}

// Shared quote-list card (recent quotes on the landing + In-Take Quotes on the
// Vehicles tab). Shows the first damage-line thumbnail when available.
export function RecentQuoteCard({ quote: q, onClick, badge, footer }) {
  const hrs = q.totals?.hrs ?? q.hrs ?? 0;
  const lineCount = Number.isFinite(q.lineCount)
    ? q.lineCount
    : Array.isArray(q.lines) ? q.lines.filter((l) => l && l.cls).length : 0;
  const stamp = q.ts ?? q.completedAt ?? null;
  const date = stamp ? new Date(stamp).toLocaleDateString() : (q.dateISO ? new Date(q.dateISO).toLocaleDateString() : '—');
  return (
    <button className="card" onClick={onClick} style={{ textAlign: 'left', width: '100%', cursor: 'pointer', padding: 13, display: 'flex', gap: 11, alignItems: 'center' }}>
      {q.cover ? (
        <img src={q.cover} alt="" style={{ width: 46, height: 46, borderRadius: 8, objectFit: 'cover', flex: '0 0 auto', border: '1px solid var(--border)' }} />
      ) : (
        <div style={{ width: 46, height: 46, borderRadius: 8, flex: '0 0 auto', background: 'var(--panel)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted2)', fontSize: 18 }}>🚚</div>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span className="oswald" style={{ fontSize: 15, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1, minWidth: 0 }}>{q.vehicle || 'Vehicle not decoded'}</span>
          {badge && <span style={{ fontSize: 8.5, fontWeight: 700, color: '#fff', background: 'var(--gold)', padding: '2px 7px', borderRadius: 4, flex: '0 0 auto' }}>{badge}</span>}
        </div>
        <div className="mono" style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 3 }}>{q.stock ? 'STOCK ' + q.stock + ' · ' : ''}{q.vin ? q.vin.slice(-8) : ''}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px 10px', fontSize: 10, color: 'var(--brown)', marginTop: 5 }}>
          <span>{date}</span>
          {lineCount > 0 && <span>{lineCount} lines</span>}
          {hrs > 0 && <b>{hrs} hr</b>}
        </div>
        {footer && <div style={{ fontSize: 10.5, fontWeight: 700, marginTop: 6, color: 'var(--red)' }}>{footer}</div>}
      </div>
    </button>
  );
}

// Duplicate-VIN guard. Shown at intake when a scanned/entered VIN already has
// an in-progress intake and/or a saved quote. Lets the tech OPEN the existing
// record (resume intake / open quote, matching the landing cards) or START
// ANYWAY. Styled to match PinDialog (lightbox overlay + card).
function DuplicateVinDialog({ warn, onOpenIntake, onOpenQuote, onStartAnyway, onCancel }) {
  const { vin, intakeRow, quoteRow } = warn;
  // The data model is one intake per VIN, so once an intake exists there is no
  // "new intake" — the only sane action is to resume it. "Start anyway" only
  // makes sense when just a QUOTE exists (a quoted truck now being intaken):
  // that path creates a fresh intake, so the landing seeds apply as usual.
  return (
    <div className="lightbox-overlay" onClick={onCancel} style={{ cursor: 'default', padding: 18 }}>
      <div className="card" onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 380, maxHeight: '90%', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span className="oswald" style={{ fontWeight: 700, fontSize: 18, flex: 1, color: 'var(--amber)' }}>Record already exists</span>
          <span onClick={onCancel} style={{ fontSize: 20, color: 'var(--muted)', cursor: 'pointer', lineHeight: 1 }}>✕</span>
        </div>
        <div className="mono" style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>{vin}</div>
        <div style={{ fontSize: 12, color: 'var(--brown)', marginTop: 10, lineHeight: 1.5 }}>
          {intakeRow
            ? 'This VIN already has an intake on file. Resuming continues right where it left off — there is only one intake per truck.'
            : 'This VIN already has a body quote on file. You can open that quote, or start the intake for this quoted truck.'}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
          {intakeRow ? (
            <button className="btn btn-dark" style={{ height: 46 }} onClick={() => onOpenIntake(intakeRow)}>
              {intakeRow.completedAt ? 'Open existing intake' : 'Resume existing intake'}
              <span style={{ display: 'block', fontSize: 10, fontWeight: 400, opacity: 0.85, marginTop: 2 }}>
                {intakeRow.vehicle || 'Vehicle not decoded'}{intakeRow.stock ? ' · STOCK ' + intakeRow.stock : ''}
              </span>
            </button>
          ) : (
            quoteRow && (
              <button className="btn btn-outline-red" style={{ height: 46 }} onClick={() => onOpenQuote(quoteRow)}>
                Open existing quote
                <span style={{ display: 'block', fontSize: 10, fontWeight: 400, opacity: 0.85, marginTop: 2 }}>
                  {quoteRow.vehicle || 'Vehicle not decoded'}{quoteRow.stock ? ' · STOCK ' + quoteRow.stock : ''}
                </span>
              </button>
            )
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btn btn-outline" style={{ flex: 1, height: 44 }} onClick={onCancel}>Cancel</button>
          {!intakeRow && quoteRow && (
            <button className="btn btn-outline-brown" style={{ flex: 1, height: 44 }} onClick={onStartAnyway}>Start intake anyway</button>
          )}
        </div>
      </div>
    </div>
  );
}

function IntakeHomeCard({ row, onClick }) {
  return <button className="card" onClick={onClick} style={{textAlign:'left',width:'100%',cursor:'pointer',padding:13}}>
    <div style={{display:'flex',gap:8,alignItems:'center'}}><span className="oswald" style={{fontSize:16}}>{row.vehicle || 'Vehicle not decoded'}</span><span style={{marginLeft:'auto',fontSize:10,color:row.completedAt?'var(--green)':'var(--amber)',fontWeight:700}}>{row.completedAt ? 'COMPLETE ✓' : 'IN PROGRESS'}</span></div>
    <div className="mono" style={{fontSize:11,color:'var(--muted)',marginTop:5}}>{row.vin}</div>
    <div style={{display:'flex',flexWrap:'wrap',gap:'4px 12px',fontSize:10,color:'var(--brown)',marginTop:8}}><span>STOCK {row.stock || '—'}</span><span>{row.estimator || 'No estimator'}</span><span>{row.updatedAt ? new Date(row.updatedAt).toLocaleDateString() : '—'}</span>{row.quote && <><span>{row.quote.lineCount} lines</span><b>{row.quote.hrs} hr</b></>}</div>
  </button>;
}

