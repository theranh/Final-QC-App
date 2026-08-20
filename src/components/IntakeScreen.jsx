import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import QuoteScreen from './QuoteScreen';
import PinDialog, { SignatureBadge } from './PinDialog';
import VinScanner from './VinScanner';
import { prefetchZxing } from '../lib/zxingDecode';
import WalkAroundCamera from './WalkAroundCamera';
import { vinValid, decodeVinInfo, scannedVinDecision } from '../lib/vin';
import { subscribePending, subscribePersistence, queueServerDelete, attemptServerDelete } from '../lib/photoQueue';
import { createSaveTracker } from '../lib/saveTracker';
import SaveStatusPill from './SaveStatusPill';

// Intake tab — VIN-keyed intake with the 9-item RO-ready sign-off and PIN
// commit. Completing the RO-ready checklist (9/9) is what gates completed_at,
// which feeds the In-Take Quotes bucket. The persistence shape matches the old
// client (a `steps` key may still exist in saved data for compat; it is no
// longer rendered or required).

// ---------- local cache (offline resume, per VIN, cap 40) ----------
const LS_INTAKE = 'trqc.intake.cache.v2';

function loadCache() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LS_INTAKE) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
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

function intakeFromCache(raw, vin) {
  const blank = blankIntake(vin);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return blank;
  return {
    ...blank,
    ...raw,
    vin,
    steps: {
      1: Array.isArray(raw.steps?.[1]) ? raw.steps[1] : blank.steps[1],
      2: Array.isArray(raw.steps?.[2]) ? raw.steps[2] : blank.steps[2],
      3: Array.isArray(raw.steps?.[3]) ? raw.steps[3] : blank.steps[3],
      4: Array.isArray(raw.steps?.[4]) ? raw.steps[4] : blank.steps[4],
    },
    roReady: Array.isArray(raw.roReady) ? raw.roReady : blank.roReady,
  };
}

function intakeFromServerRow(j) {
  const d = j.data || {};
  return {
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
}

function mergeCanonicalServerFields(local, server) {
  return {
    ...local,
    id: server.id || local.id,
    completedAt: server.completedAt || null,
    committedBy: server.committedBy || null,
    overriddenBy: server.overriddenBy || null,
    quoteId: server.quoteId || null,
  };
}

export default function IntakeScreen({ showToast, openVin, onOpenVinConsumed, openQuote, onOpenQuoteConsumed }) {
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
  const [walkQuoteId, setWalkQuoteId] = useState(null);
  const [walkMode, setWalkMode] = useState('guided'); // 'guided' | 'extra' (after-the-fact additions)
  const [, setDecoding] = useState(false);
  const [estimators, setEstimators] = useState([]);
  const [quoteSummary, setQuoteSummary] = useState(null);
  const [quoteNotes, setQuoteNotes] = useState('');
  const quoteRowRef = useRef(null); // full quote entry backing the notes editor
  const ratesVersionRef = useRef(null); // rates version the quote view was loaded with
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
  // Every open/retry receives a generation. A response from an earlier visit
  // to the same VIN must not replace a newer A→B→A session.
  const openGenerationRef = useRef(0);
  const lastEditTsRef = useRef(0);
  // Per-truck save status: 'saved' only after the server confirms; a failed
  // push shows a RETRY. Each opened VIN gets its OWN tracker instance; the
  // onChange guard means a retired tracker (previous truck) can never update
  // the UI, and completion callbacks hold their own instance, so a late
  // response for truck A can never mark truck B as saved.
  const [saveStatus, setSaveStatus] = useState('idle');
  const saveTrackerRef = useRef(null);
  const makeSaveTracker = useCallback(() => {
    const t = createSaveTracker((s) => { if (saveTrackerRef.current === t) setSaveStatus(s); });
    return t;
  }, []);
  if (!saveTrackerRef.current) saveTrackerRef.current = makeSaveTracker();
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
  // Fresh tracker whenever a different truck is opened (effect, not render).
  useEffect(() => {
    saveTrackerRef.current = makeSaveTracker();
    setSaveStatus('idle');
  }, [intakeVin, makeSaveTracker]);
  useEffect(() => {
    if (intakeVin == null) { setQuoteSummary(null); return; }
    let live = true;
    api.quoterSync().then((j) => {
      if (!live) return;
      // Remember which rates version this quote view was built from — sent
      // back at commit so a rate change mid-quote can't silently reprice.
      if (j && j.ratesVersion != null) ratesVersionRef.current = Number(j.ratesVersion);
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
      // Review-gated lines are excluded from billing — surfaced prominently
      // in the commit confirmation so a sign-off can't miss them.
      const reviewCount = (Array.isArray(q.lines) ? q.lines : []).filter((l) => l && l.status === 'done' && l.review).length;
      api.quotePhotos(q.id).then((p) => live && setQuoteSummary({ id: q.id, lineCount: lines.length, reviewCount, hrs: q.totals?.hrs || 0, notes: q.notes || '', photoCount: (p?.photos || []).length })).catch(() => live && setQuoteSummary({ id: q.id, lineCount: lines.length, reviewCount, hrs: q.totals?.hrs || 0, notes: q.notes || '', photoCount: 0 }));
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
      // Capture the tracker instance: a late response for a previous truck's
      // tracker must never touch the currently open truck's status.
      const tr = saveTrackerRef.current;
      const tok = tr.begin('notes');
      api.patchQuoteNotes({
        id, notes: next,
        meta: { vin: cur?.vin || '', stock: cur?.stock || '', miles: cur?.miles || '', vehicle: cur?.vehicle || '', estimator: cur?.estimator || '' },
      }).then(() => tr.succeed('notes', tok)).catch((e) => {
        if (e?.status === 409) {
          // Locked quote — retrying can't help; don't leave a red pill up.
          tr.reset('notes');
          showToast?.('This quote is committed — notes are locked.');
        } else {
          tr.fail('notes', tok, 'error');
        }
      });
    }, 600);
  }, [showToast]);
  // Re-send the latest notes text immediately (RETRY on the status pill).
  const retryNotesPush = useCallback(() => {
    clearTimeout(notesTimerRef.current);
    const cur = intakeRef.current;
    const id = quoteRowRef.current?.id || cur?.quoteId;
    const tr = saveTrackerRef.current;
    if (!id) { tr.reset('notes'); return; }
    const tok = tr.begin('notes');
    api.patchQuoteNotes({
      id, notes: quoteRowRef.current?.notes ?? '',
      meta: { vin: cur?.vin || '', stock: cur?.stock || '', miles: cur?.miles || '', vehicle: cur?.vehicle || '', estimator: cur?.estimator || '' },
    }).then(() => tr.succeed('notes', tok)).catch((e) => {
      if (e?.status === 409) { tr.reset('notes'); showToast?.('This quote is committed — notes are locked.'); }
      else tr.fail('notes', tok, 'error');
    });
  }, [showToast]);
  useEffect(() => () => clearTimeout(notesTimerRef.current), []);

  // Adopt a server row for a VIN, honoring the old conflict rule.
  const [serverCheckFailed, setServerCheckFailed] = useState(false);
  const refreshFromServer = useCallback(async (v, expectedGeneration) => {
    const generation = expectedGeneration ?? ++openGenerationRef.current;
    const isCurrent = () =>
      generation === openGenerationRef.current && intakeRef.current?.vin === v;
    try {
      const j = await api.getIntake(v);
      if (!isCurrent()) return;
      if (!j || !j.found) { setServerCheckFailed(false); return; }
      const cur = intakeRef.current;
      const serverIsFinal = !!(j.completedAt || j.committedBy);
      if (!serverIsFinal && (j.updatedAt || 0) <= (cur.ts || 0)) {
        // Preserve newer local edits, but server-owned identity/linkage fields
        // must always win. Otherwise a stale browser cache can hide the
        // canonical quote and its walk-around photos.
        const next = mergeCanonicalServerFields(cur, j);
        saveToCache(next);
        intakeRef.current = next;
        lastEditTsRef.current = Math.max(lastEditTsRef.current, Number(next.ts) || 0);
        setIntake(next);
        setServerCheckFailed(false);
        return;
      }
      const it = intakeFromServerRow(j);
      saveToCache(it);
      intakeRef.current = it;
      lastEditTsRef.current = Math.max(lastEditTsRef.current, Number(it.ts) || 0);
      setIntake(it);
      setServerCheckFailed(false);
    } catch {
      // Offline — local copy stands, but say so instead of looking current.
      if (isCurrent()) setServerCheckFailed(true);
    }
  }, []);

  // Server payload for an intake row (shared by autosave and the repair path).
  const intakePayload = (it) => ({
    id: it.id,
    vin: it.vin,
    stock: it.stock,
    vehicle: it.vehicle,
    miles: it.miles,
    estimator: it.estimator,
    quoteId: it.quoteId || null,
    ts: it.ts,
    data: {
      steps: { 1: it.steps[1], 2: it.steps[2], 3: it.steps[3], 4: it.steps[4] },
      roReady: it.roReady,
      photoCount: 0,
      notes: it.notes || '',
      mddTags: !!it.mddTags,
    },
  });

  // Persist every change: cache locally, then push to the server (unless
  // noPush). The cache write, network call, and tracker updates all happen
  // OUTSIDE the React state updater (updaters must stay pure — StrictMode
  // double-invokes them, which would double the PUTs and corrupt sequencing).
  // intakeRef is advanced synchronously so back-to-back keystrokes always
  // build on the latest snapshot even before React re-renders.
  const saveIntake = useCallback((patch, opts) => {
    const noPush = !!(opts && opts.noPush);
    const s = intakeRef.current;
    if (!s || s.committedBy) return;
    const ts = noPush
      ? s.ts || 0
      : Math.max(Date.now(), (Number(s.ts) || 0) + 1, lastEditTsRef.current + 1);
    if (!noPush) lastEditTsRef.current = ts;
    const next = { ...s, ...patch, ts };
    intakeRef.current = next;
    setIntake(next);
    saveToCache(next);
    if (!noPush && String(next.vin || '').length >= 6) {
      const tr = saveTrackerRef.current; // instance-captured (see notes save)
      const tok = tr.begin('intake');
      api
        .putIntake(intakePayload(next))
        .then(() => tr.succeed('intake', tok))
        .catch(() => {
          // Offline/server error — the local cache keeps the work for
          // resume; surface it honestly with an in-place retry.
          tr.fail('intake', tok, 'error');
        });
    }
  }, []);
  // Re-push the whole latest intake (RETRY on the status pill).
  const retryIntakePush = useCallback(() => {
    const cur = intakeRef.current;
    const tr = saveTrackerRef.current;
    if (!cur || cur.committedBy || String(cur.vin || '').length < 6) { tr.reset('intake'); return; }
    const tok = tr.begin('intake');
    api.putIntake(intakePayload(cur))
      .then(() => tr.succeed('intake', tok))
      .catch(() => tr.fail('intake', tok, 'error'));
  }, []);
  // One retry button drives every failed channel for this truck.
  const retryFailedSaves = useCallback(() => {
    if (saveTrackerRef.current.channelState('intake') === 'error') retryIntakePush();
    if (saveTrackerRef.current.channelState('notes') === 'error') retryNotesPush();
  }, [retryIntakePush, retryNotesPush]);

  // Open an intake for a VIN: prefer the local cache, then fetch the server copy.
  const openFor = useCallback(
    (raw, seed, authoritativeRow) => {
      const v = String(raw || '').trim().toUpperCase();
      const generation = ++openGenerationRef.current;
      const cache = loadCache();
      let it = v && cache[v] ? intakeFromCache(cache[v], v) : blankIntake(v);
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
      if (authoritativeRow?.found) {
        const serverIsFinal = !!(authoritativeRow.completedAt || authoritativeRow.committedBy);
        it = serverIsFinal || (authoritativeRow.updatedAt || 0) > (it.ts || 0)
          ? intakeFromServerRow(authoritativeRow)
          : mergeCanonicalServerFields(it, authoritativeRow);
        saveToCache(it);
      }
      // Keep the ref in sync before the network request starts. A fast server
      // response can otherwise arrive before React commits setIntake(), see the
      // previous VIN/null ref, and discard the canonical saved details.
      intakeRef.current = it;
      lastEditTsRef.current = Math.max(lastEditTsRef.current, Number(it.ts) || 0);
      setServerCheckFailed(false);
      setIntake(it);
      if (v.length >= 6 && !authoritativeRow?.found) refreshFromServer(v, generation);
    },
    [refreshFromServer]
  );
  const openExisting = (row) => {
    setVin(row.vin);
    openFor(row.vin, null, row?.found ? row : null);
  };
  // Auto-open a VIN handed in from another tab (e.g. tapping an In-Take Quote
  // card on the Vehicles tab). Consumed once so back-navigation still works.
  useEffect(() => {
    if (!openVin) return;
    setVin(openVin);
    openFor(openVin);
    onOpenVinConsumed?.();
  }, [openVin, openFor, onOpenVinConsumed]);
  // Auto-open a saved quote handed in from global search (quote-only record —
  // no intake exists, so it opens as a standalone quote, same as the RECENT
  // QUOTES list). Consumed once so back-navigation still works.
  useEffect(() => {
    if (!openQuote?.quoteId) return;
    setStandaloneQuote(openQuote);
    onOpenQuoteConsumed?.();
  }, [openQuote, onOpenQuoteConsumed]);
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
  const linkOperationIsCurrent = (operation) =>
    !!operation &&
    operation.generation === openGenerationRef.current &&
    intakeRef.current?.vin === operation.vin &&
    intakeRef.current?.id === operation.id;

  const ensureIntakeQuote = async (operation) => {
    let cur = intakeRef.current;
    if (!cur) return null;
    const op = operation || {
      generation: openGenerationRef.current,
      vin: cur.vin,
      id: cur.id,
    };
    if (!linkOperationIsCurrent(op)) return null;
    if (cur.quoteId) return cur.quoteId;

    // A newly scanned VIN starts as an untouched local intake. Persist that
    // row before linking its quote; the server cannot link a quote to an
    // intake id that does not exist yet.
    if (!cur.ts) {
      const ts = Math.max(Date.now(), lastEditTsRef.current + 1);
      lastEditTsRef.current = ts;
      cur = { ...cur, ts };
      intakeRef.current = cur;
      setIntake(cur);
      saveToCache(cur);
      await api.putIntake(intakePayload(cur));
      if (!linkOperationIsCurrent(op)) return null;
    }

    const id = 'q' + Date.now() + Math.random().toString(36).slice(2, 6);
    const r = await api.linkIntakeQuote(cur.id, id);
    if (!linkOperationIsCurrent(op)) return null;
    const canonical = r?.quoteId || id;
    // Preserve edits made while the link request was in flight, but only for
    // this exact open generation/VIN/intake id.
    const linked = { ...intakeRef.current, quoteId: canonical };
    intakeRef.current = linked;
    setIntake(linked);
    saveToCache(linked);
    return canonical;
  };
  // Same as ensureIntakeQuote, but explains failures with a toast instead of
  // dying silently (the camera/quote buttons looked "dead" otherwise).
  // Returns the quote id on success, null on failure.
  const ensureIntakeQuoteWithFeedback = async () => {
    const cur = intakeRef.current;
    if (!cur) return null;
    const operation = {
      generation: openGenerationRef.current,
      vin: cur.vin,
      id: cur.id,
    };
    try {
      return await ensureIntakeQuote(operation);
    } catch (e) {
      if (!linkOperationIsCurrent(operation)) return null;
      if (e?.status === 409) {
        // 409 means "committed or not found". Repair by VIN, never blindly:
        // another phone may already own this VIN's server row under a
        // different id, and re-pushing ours would split the truck across two
        // rows. So: adopt an existing uncommitted VIN row (link against its
        // id), stop on a committed one, and only re-push our row when the
        // server has no row for this VIN at all (first save never landed).
        try {
          if (String(operation.vin || '').length >= 6) {
            const j = await api.getIntake(operation.vin).catch(() => null);
            if (!linkOperationIsCurrent(operation)) return null;
            if (j?.found && j.id) {
              if (j.committedBy) {
                showToast?.('This intake was already committed — it is locked. Refreshing…');
                refreshFromServer(operation.vin);
                return null;
              }
              if (j.quoteId) {
                const live = intakeRef.current;
                const serverIsNewer =
                  !!(j.completedAt || j.committedBy) ||
                  (Number(j.updatedAt) || 0) > (Number(live?.ts) || 0);
                const base = serverIsNewer ? intakeFromServerRow(j) : live;
                const linked = { ...base, id: j.id, quoteId: j.quoteId };
                intakeRef.current = linked;
                setIntake(linked);
                saveToCache(linked);
                return j.quoteId;
              }
              const qid = 'q' + Date.now() + Math.random().toString(36).slice(2, 6);
              const r = await api.linkIntakeQuote(j.id, qid);
              if (!linkOperationIsCurrent(operation)) return null;
              const canonical = r?.quoteId || qid;
              const live = intakeRef.current;
              const serverIsNewer =
                !!(j.completedAt || j.committedBy) ||
                (Number(j.updatedAt) || 0) > (Number(live?.ts) || 0);
              const base = serverIsNewer ? intakeFromServerRow(j) : live;
              const linked = { ...base, id: j.id, quoteId: canonical };
              intakeRef.current = linked;
              setIntake(linked);
              saveToCache(linked);
              return canonical;
            }
            await api.putIntake(intakePayload(intakeRef.current));
            if (!linkOperationIsCurrent(operation)) return null;
            return await ensureIntakeQuote(operation);
          }
        } catch {
          if (linkOperationIsCurrent(operation)) {
            showToast?.('Could not reach the server — check your connection and try again.');
          }
          return null;
        }
        if (linkOperationIsCurrent(operation)) {
          showToast?.('This intake was already committed — it is locked. Refreshing…');
          refreshFromServer(operation.vin);
        }
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
    const generation = openGenerationRef.current;
    setDecoding(true);
    const desc = await decodeVinInfo(v);
    if (
      desc &&
      generation === openGenerationRef.current &&
      intakeRef.current?.vin === v &&
      !intakeRef.current?.vehicle
    ) {
      saveIntake({ vehicle: desc });
    }
    if (generation === openGenerationRef.current) setDecoding(false);
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
  const [commitConfirm, setCommitConfirm] = useState(false); // summary shown before the PIN dialog
  const locked = !!(intake && intake.committedBy); // committed → read-only

  // "What's left" progress strip — card anchors for tap-to-scroll.
  const truckCardRef = useRef(null);
  const photosCardRef = useRef(null);
  const notesCardRef = useRef(null);
  const quoteCardRef = useRef(null);

  const doCommit = ({ signerId, pin, forEmployeeId }) =>
    api.commitIntake({ id: intake.id, signerId, pin, forEmployeeId, ratesVersion: ratesVersionRef.current }).then((r) => {
      const cur = intakeRef.current;
      if (!cur) return;
      const next = { ...cur, committedBy: r.committedBy, overriddenBy: r.overriddenBy || null, completedAt: r.completedAt || Date.now() };
      intakeRef.current = next;
      saveToCache(next);
      setIntake(next);
      setPinOpen(false);
      showToast && showToast('Intake saved ✓');
    });

  const cleanVin = vin.trim().toUpperCase();
  const started = intake && cleanVin.length >= 6;

  // Walk-around photos for the opened intake (thumbnails shown inline).
  // Refreshed when the camera closes so new shots appear immediately.
  const [intakePhotos, setIntakePhotos] = useState([]);
  // Damage close-ups (slots starting with "dmg") are shown apart from the
  // walk-around set so reviewers see truck condition vs. quoted damage.
  // Everything else is ONE walk-around set — guided-slot shots and any
  // additional pictures are all just photos; no separation shown anywhere.
  const walkPhotos = intakePhotos.filter((p) => !String(p.slot || '').startsWith('dmg'));
  const damagePhotos = intakePhotos.filter((p) => String(p.slot || '').startsWith('dmg'));
  const [lightbox, setLightbox] = useState(null); // { url, id } of enlarged photo
  const photoQuoteId = intake?.quoteId ?? null;
  // Photos can still be uploading in the background (weak signal) when the
  // grid first loads — track the retry queue and refresh the list as shots
  // land, so a saved intake never looks like photos went missing.
  const [pendingUploads, setPendingUploads] = useState(0);
  useEffect(() => subscribePending(setPendingUploads), []);
  // Warn when IndexedDB is unavailable — queued photos won't survive a close.
  const [persistenceOk, setPersistenceOk] = useState(null);
  useEffect(() => subscribePersistence(setPersistenceOk), []);
  const [photoLoadError, setPhotoLoadError] = useState(false);
  const [photoLoadAttempt, setPhotoLoadAttempt] = useState(0); // bumped by RETRY
  useEffect(() => {
    if (!photoQuoteId || walkOpen) { if (!photoQuoteId) setIntakePhotos([]); return; }
    let live = true;
    const load = () => api.quotePhotos(photoQuoteId)
      .then((j) => { if (live) { setIntakePhotos(j?.photos || []); setPhotoLoadError(false); } })
      .catch(() => { if (live) setPhotoLoadError(true); });
    load();
    // While uploads are draining, poll so each arriving shot appears; the
    // pendingUploads dependency triggers a final refresh when it hits zero.
    const t = pendingUploads > 0 ? setInterval(load, 4000) : null;
    return () => { live = false; if (t) clearInterval(t); };
  }, [photoQuoteId, walkOpen, quoting, pendingUploads, photoLoadAttempt]);

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
    const openRecentQuote = async (q) => {
      try {
        // The landing lists load independently and have different limits, so
        // they cannot reliably tell us whether this quote owns an intake.
        // Resolve the VIN against the server before choosing the destination.
        const linkedIntake = await api.getIntake(q.vin);
        if (linkedIntake?.found && linkedIntake.quoteId === q.id) {
          openExisting(linkedIntake);
          return;
        }
        setStandaloneQuote({ vin: q.vin, stock: q.stock, vehicle: q.vehicle, estimator: q.estimator, miles: q.miles, quoteId: q.id });
      } catch {
        showToast?.('Could not open this vehicle — check your connection and try again.');
      }
    };
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
                <div className="field-label">STOCK # <span style={{ color: 'var(--red)' }}>*</span></div>
                <input className="input mono" value={homeStock} placeholder="T-0000" autoCapitalize="characters" onChange={(e) => setHomeStock(e.target.value.toUpperCase())} />
              </div>
              <div>
                <div className="field-label">MILES <span style={{ color: 'var(--red)' }}>*</span></div>
                <input className="input mono" value={homeMiles} inputMode="numeric" placeholder="e.g. 45000" onChange={(e) => setHomeMiles(e.target.value.replace(/[^0-9]/g, ''))} />
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <div className="field-label">ESTIMATOR <span style={{ color: 'var(--red)' }}>*</span></div>
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
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>Are both Key &amp; Vehicle MDD tags present? <span style={{ color: 'var(--red)' }}>*</span></span>
          </label>

          {/* VIN entry actions share a generous, side-by-side tap area. */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <button
              className="btn btn-red"
              style={{ minHeight: 64, fontSize: 16, letterSpacing: 0.8, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, opacity: homeReady ? 1 : 0.45 }}
              aria-disabled={!homeReady}
              onClick={() => {
                if (!homeReady) { showToast?.(`Fill in first: ${missing.join(', ')}`); return; }
                setScanning(true);
              }}
            >
              <span aria-hidden="true">📷</span> SCAN VIN
            </button>
            <button
              className="btn btn-outline-brown"
              style={{ minHeight: 64, fontSize: 13, letterSpacing: 0.6, lineHeight: 1.15, whiteSpace: 'normal' }}
              onClick={() => setManualOpen((v) => !v)}
            >
              ENTER VIN MANUALLY
            </button>
          </div>
          {manualOpen && (
            <div className="card">
              <div className="field-label">17-CHARACTER VIN</div>
              <input className="input mono" value={vin} maxLength={17} autoFocus onChange={(e) => { setVin(e.target.value.toUpperCase()); setVinMessage(''); }} placeholder="17-character VIN" autoCapitalize="characters" autoCorrect="off" spellCheck={false} />
              <div style={{ fontSize: 11, marginTop: 7, color: vinMessage === 'Valid VIN' ? 'var(--green)' : 'var(--red)' }}>{vin.length}/17 {vinMessage}</div>
              <button className="btn btn-dark" style={{ marginTop: 9 }} disabled={vin.length !== 17} onClick={() => acceptVin(vin)}>Start / Resume</button>
              {/* After a failed scan the tech lands here — rescanning must not
                  require backing out of the card. */}
              <button className="btn btn-outline-brown" style={{ marginTop: 7 }} onClick={() => { setManualOpen(false); setVinMessage(''); setScanning(true); }}>📷 OPEN CAMERA AGAIN</button>
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
              <RecentQuoteCard key={q.id} quote={q} onClick={() => openRecentQuote(q)} />
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
          <div className="empty-note">
            <strong>Start where the truck is.</strong>
            Enter or scan the VIN to begin a new intake or safely resume one already in progress.
          </div>
        )}

        {started && (
          <>
            {/* Saved banner — the step-by-step progress strip was removed (too busy). */}
            {locked && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '8px 12px', borderRadius: 10, background: '#e8f3ea', border: '1px solid var(--green)', color: 'var(--green)', fontSize: 12, fontWeight: 700, letterSpacing: 0.5 }}>
                ✓ COMMITTED &amp; LOCKED — intake complete
              </div>
            )}
            {/* Per-truck save status — 'Saved to server' only after the server
                confirms; failed pushes offer an in-place RETRY. */}
            {!locked && (
              <SaveStatusPill status={saveStatus} pendingPhotos={pendingUploads} onRetry={retryFailedSaves} />
            )}
            {/* vehicle detail fields */}
            <div className="card" ref={truckCardRef}>
              <div className="card-title">TRUCK</div>
              {serverCheckFailed && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, padding: '7px 10px', borderRadius: 8, background: 'var(--panel)', border: '1px solid var(--brown)', fontSize: 11, fontWeight: 700, color: 'var(--brown)' }}>
                  <span style={{ flex: 1 }}>Couldn’t check the server — showing the copy on this device.</span>
                  <button className="btn btn-outline-brown" style={{ height: 44, padding: '0 16px', fontSize: 11 }} onClick={() => intakeVin && refreshFromServer(intakeVin)}>RETRY</button>
                </div>
              )}
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
            <div className="card" ref={photosCardRef}>
              <div className="card-title">
                WALK-AROUND PHOTOS · {walkPhotos.length}
                {pendingUploads > 0 && <span style={{ marginLeft: 8, color: 'var(--amber)', fontWeight: 700 }}>· sending {pendingUploads}…</span>}
              </div>
              <div style={{fontSize:11,color:'var(--muted)',marginTop:5}}>Capture the truck from every angle before the quote is finalized.</div>
              {persistenceOk === false && (
                <div style={{ marginTop: 8, padding: '7px 10px', borderRadius: 8, background: '#fdf3e0', border: '1px solid var(--amber)', fontSize: 11, fontWeight: 700, color: '#8a6210' }}>
                  ⚠ This browser can’t save photos for retry (private mode or blocked storage). Keep the app open until every photo finishes sending.
                </div>
              )}
              {photoLoadError && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, padding: '7px 10px', borderRadius: 8, background: '#fdecea', border: '1px solid var(--red)', fontSize: 11, fontWeight: 700, color: 'var(--red)' }}>
                  <span style={{ flex: 1 }}>Photos didn’t load — check your connection.</span>
                  <button className="btn btn-outline-red" style={{ height: 44, padding: '0 16px', fontSize: 11 }} onClick={() => setPhotoLoadAttempt((n) => n + 1)}>RETRY</button>
                </div>
              )}
              {walkPhotos.length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginTop: 9 }}>
                  {walkPhotos.map((p) => (
                    <img
                      key={p.id}
                      src={`/api/quoter/photo?id=${encodeURIComponent(p.id)}${p.bust ? `&t=${p.bust}` : ''}`}
                      alt={p.slot || 'walk-around photo'}
                      loading="lazy"
                      onClick={() => setLightbox({ url: `/api/quoter/photo?id=${encodeURIComponent(p.id)}`, id: p.id })}
                      style={{ width: '100%', aspectRatio: '4 / 3', objectFit: 'cover', borderRadius: 7, border: '1px solid var(--border)', cursor: 'pointer' }}
                    />
                  ))}
                </div>
              )}
              {!locked && <button className="btn btn-dark" style={{marginTop:9}} onClick={async () => {
                const quoteId = await ensureIntakeQuoteWithFeedback();
                if (quoteId) {
                  setWalkQuoteId(quoteId);
                  setWalkOpen(true);
                }
              }}>TAKE WALK-AROUND PHOTOS</button>}
              {/* Saved trucks can always ADD new photos after the fact —
                  each one is a brand-new picture; nothing saved is touched. */}
              {locked && intake.quoteId && !quoteRowRef.current?.committedBy && (
                <button className="btn btn-outline" style={{ marginTop: 9 }} onClick={() => {
                  setWalkMode('extra');
                  setWalkQuoteId(intake.quoteId);
                  setWalkOpen(true);
                }}>+ ADD PHOTOS</button>
              )}
            </div>
            {/* Notes — its own card so it stands apart from the photo grid. */}
            <div className="card" ref={notesCardRef} style={{ borderLeft: '4px solid var(--amber)' }}>
              <div className="card-title">NOTES</div>
              <div style={{ marginTop: 8 }}>
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
            <div className="card" ref={quoteCardRef} style={quoteSummary ? { borderLeft: '4px solid var(--red)' } : undefined}>
              <div className="card-title">{quoteSummary ? 'BODY QUOTE LINKED' : 'BODY QUOTER'}</div>
              {quoteSummary ? (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 12, fontWeight: 700 }}><span>{quoteSummary.lineCount} lines</span><span>{quoteSummary.hrs} hr of work</span><span>{quoteSummary.photoCount} photos</span></div>
                  {(quoteSummary.notes || '').trim() && <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 8, background: 'var(--panel)', fontSize: 11.5, color: 'var(--brown)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}><b style={{ fontSize: 9.5, color: 'var(--muted)', letterSpacing: 0.8 }}>NOTES</b><br />{quoteSummary.notes.trim()}</div>}
                  {damagePhotos.length > 0 && (
                    <>
                      <div style={{ fontSize: 9.5, color: 'var(--muted)', letterSpacing: 0.8, fontWeight: 700, marginTop: 10 }}>DAMAGE PHOTOS · {damagePhotos.length}</div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginTop: 6 }}>
                        {damagePhotos.map((p) => (
                          <img
                            key={p.id}
                            src={`/api/quoter/photo?id=${encodeURIComponent(p.id)}${p.bust ? `&t=${p.bust}` : ''}`}
                            alt="damage photo"
                            loading="lazy"
                            onClick={() => setLightbox({ url: `/api/quoter/photo?id=${encodeURIComponent(p.id)}`, id: p.id })}
                            style={{ width: '100%', aspectRatio: '4 / 3', objectFit: 'cover', borderRadius: 7, border: '1px solid var(--red)', cursor: 'pointer' }}
                          />
                        ))}
                      </div>
                    </>
                  )}
                  <button className="btn btn-outline-red" style={{ marginTop: 9 }} onClick={() => { setQuoting(true); }}>{locked ? 'REVIEW QUOTE' : 'REOPEN QUOTE'}</button>
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
                    Saved and locked{intake.completedAt ? ' · ' + new Date(intake.completedAt).toLocaleDateString() : ''}. Photos, notes, and the quote below stay visible for review. A correction is a new record, not an edit.
                  </div>
                </div>
              ) : (
                <>
                  <button className="btn btn-green" style={{ height: 46 }} onClick={() => setCommitConfirm(true)}>
                    SAVE
                  </button>
                  <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 6, textAlign: 'center' }}>
                    Committing signs off the intake with your PIN and locks it. Photos, notes, and the quote stay visible for review.
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </div>

      {commitConfirm && intake && (
        <CommitConfirmDialog
          intake={intake}
          quoteSummary={quoteSummary}
          onContinue={() => { setCommitConfirm(false); setPinOpen(true); }}
          onCancel={() => setCommitConfirm(false)}
        />
      )}
      {pinOpen && (
        <PinDialog
          title="Commit & lock intake"
          subtitle={intake ? `${intake.vin} · ${intake.vehicle || 'vehicle'}` : ''}
          onCommit={doCommit}
          onClose={() => setPinOpen(false)}
        />
      )}
      {walkOpen && (
        <WalkAroundCamera quoteId={walkQuoteId || intake.quoteId} committed={!!quoteRowRef.current?.committedBy} addOnly={locked} initialMode={walkMode} onClose={() => { setWalkOpen(false); setWalkQuoteId(null); setWalkMode('guided'); }} showToast={showToast} />
      )}
      {lightbox && (
        <div className="lightbox-overlay" onClick={() => setLightbox(null)}>
          <div className="lightbox-img" style={{ backgroundImage: `url("${lightbox.url}")` }} />
          {/* ROTATE is always available — straightening a sideways shot is
              allowed even after sign-off. DELETE stays locked once committed. */}
          {lightbox.id && (
            <button
              className="btn btn-outline-brown lightbox-action"
              onClick={async (e) => {
                e.stopPropagation();
                try {
                  // Rotate 90° clockwise client-side, then overwrite via the
                  // photo upsert (in-place overwrite is allowed even after
                  // sign-off; only new photos/deletes are frozen).
                  const img = new Image();
                  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = lightbox.url; });
                  // Cap the longest side (same 1600px cap as the camera) so the
                  // re-encoded JPEG always fits the server's size limit.
                  const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
                  const w = Math.max(1, Math.round(img.naturalWidth * scale));
                  const h = Math.max(1, Math.round(img.naturalHeight * scale));
                  const c = document.createElement('canvas');
                  c.width = h; c.height = w;
                  const ctx = c.getContext('2d');
                  ctx.translate(c.width / 2, c.height / 2);
                  ctx.rotate(Math.PI / 2);
                  ctx.drawImage(img, -w / 2, -h / 2, w, h);
                  const dataUrl = c.toDataURL('image/jpeg', 0.8);
                  const meta = intakePhotos.find((p) => p.id === lightbox.id);
                  await api.putQuotePhoto({ id: lightbox.id, quoteId: photoQuoteId, slot: meta?.slot || '', dataUrl });
                  // Cache-bust so the fresh rotation shows immediately.
                  const bust = `/api/quoter/photo?id=${encodeURIComponent(lightbox.id)}&t=${Date.now()}`;
                  setLightbox({ ...lightbox, url: bust });
                  setIntakePhotos((prev) => prev.map((p) => (p.id === lightbox.id ? { ...p, bust: Date.now() } : p)));
                  showToast?.('Photo rotated ✓');
                } catch (err) {
                  showToast?.('Couldn’t rotate the photo — check your connection and try again.');
                }
              }}
            >
              ↻ ROTATE
            </button>
          )}
          {lightbox.id && !quoteRowRef.current?.committedBy && (
            <button
              className="btn btn-outline-red lightbox-action"
              onClick={async (e) => {
                e.stopPropagation();
                if (!window.confirm('Delete this photo? This can’t be undone.')) return;
                try {
                  await api.deleteQuotePhoto({ id: lightbox.id });
                  setIntakePhotos((prev) => prev.filter((p) => p.id !== lightbox.id));
                  setLightbox(null);
                  showToast?.('Photo deleted');
                } catch (err) {
                  if (err?.status === 409) {
                    // Someone signed off the quote since this screen loaded —
                    // it's frozen now. Reflect that so the delete button hides.
                    if (quoteRowRef.current) quoteRowRef.current.committedBy = quoteRowRef.current.committedBy || 'committed';
                    setLightbox(null);
                    showToast?.('This quote has been signed off — its photos are locked.');
                  } else if (err?.status === 404) {
                    // Already gone on the server — reflect it locally.
                    setIntakePhotos((prev) => prev.filter((p) => p.id !== lightbox.id));
                    setLightbox(null);
                    showToast?.('Photo deleted');
                  } else {
                    // Transient (offline / 5xx / signed out): make the delete
                    // durable — it retries via the queue flush — and reflect
                    // the inspector's intent locally right away.
                    await queueServerDelete(lightbox.id);
                    attemptServerDelete(lightbox.id);
                    setIntakePhotos((prev) => prev.filter((p) => p.id !== lightbox.id));
                    setLightbox(null);
                    showToast?.('Offline — photo will be deleted from the server when the connection returns.');
                  }
                }
              }}
            >
              🗑 DELETE PHOTO
            </button>
          )}
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

// Pre-PIN confirmation summary: what exactly is being committed & locked.
// Excluded/review-pending damage lines are the headline — they are NOT in the
// quote total, and this is the last chance to notice before sign-off.
function CommitConfirmDialog({ intake, quoteSummary, onContinue, onCancel }) {
  const reviewCount = quoteSummary?.reviewCount || 0;
  return (
    <div className="lightbox-overlay" onClick={onCancel} style={{ cursor: 'default', padding: 18 }}>
      <div className="card" onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 380, maxHeight: '90%', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span className="oswald" style={{ fontWeight: 700, fontSize: 18, flex: 1 }}>Commit &amp; lock this intake?</span>
          <button type="button" className="dialog-close" onClick={onCancel} aria-label="Close">✕</button>
        </div>
        <div className="mono" style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>{intake.vin}</div>
        <div style={{ fontSize: 12.5, fontWeight: 700, marginTop: 6 }}>{intake.vehicle || 'Vehicle not decoded'}{intake.stock ? ` · STOCK ${intake.stock}` : ''}</div>

        {quoteSummary ? (
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 10, padding: '9px 11px', borderRadius: 9, background: 'var(--panel)', border: '1px solid var(--border)', fontSize: 12, fontWeight: 700 }}>
            <span>{quoteSummary.lineCount} damage line{quoteSummary.lineCount === 1 ? '' : 's'}</span>
            <span>{quoteSummary.hrs} hr quoted</span>
            <span>{quoteSummary.photoCount} photos</span>
          </div>
        ) : (
          <div style={{ marginTop: 10, padding: '9px 11px', borderRadius: 9, background: 'var(--panel)', border: '1px solid var(--border)', fontSize: 12, color: 'var(--brown)', fontWeight: 600 }}>
            No body quote linked to this intake.
          </div>
        )}

        {reviewCount > 0 && (
          <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 9, background: '#fdf6e3', border: '2px solid var(--amber)', fontSize: 12.5, fontWeight: 700, color: 'var(--amber)' }}>
            ⚠ {reviewCount} line{reviewCount === 1 ? ' is' : 's are'} EXCLUDED from the quote total — pending review. {reviewCount === 1 ? 'It stays' : 'They stay'} excluded after commit.
          </div>
        )}

        <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 10, lineHeight: 1.5 }}>
          Committing signs off with your PIN and locks this intake. A correction afterwards is a new record, not an edit.
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button className="btn btn-outline" style={{ height: 44, flex: '0 0 38%' }} onClick={onCancel}>Cancel</button>
          <button className="btn btn-green" style={{ height: 44, flex: 1 }} onClick={onContinue}>Continue to PIN sign-off</button>
        </div>
      </div>
    </div>
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
          <button type="button" className="dialog-close" onClick={onCancel} aria-label="Close">✕</button>
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

