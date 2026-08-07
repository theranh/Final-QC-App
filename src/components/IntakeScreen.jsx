import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import QuoteScreen from './QuoteScreen';
import PinDialog, { SignatureBadge } from './PinDialog';

// Intake tab — the TR-INTAKE-V2 checklist, in-app. Replaces the old deep link
// into the Body Quoter. Wording below is copied verbatim from the Quoter's
// intakeSpec()/intakeRoSpec(); the persistence shape matches the old client.

// ---------- checklist spec (verbatim from the Quoter) ----------
const INTAKE_SPEC = [
  {
    k: '1',
    title: 'UVEye Scan',
    tag: 'UVEYE',
    intro: 'This is the first thing that happens. It creates the condition scan the whole intake hangs on.',
    items: [
      'Pull the truck through the UVEye machine — full body, undercarriage, and tire scan.',
      'Tie the VIN to the scan right away, before moving on — so the scan attaches to the correct truck.',
      'Glance at the scan for anything flagged (tires, damage, leaks) to carry into the walk-around.',
    ],
  },
  {
    k: '2',
    title: 'vAuto Appraisal & Photos',
    tag: 'VAUTO',
    intro: 'Build the working record off the original appraisal, then document the truck as it sits.',
    items: [
      'Open vAuto and find the truck\u2019s original appraisal (click Appraisals, enter the last 6 of the VIN).',
      'Click on the original appraisal, then click the 3 dots in the top-right corner and select \u201cCopy as New\u201d to create the working record.',
      'Update the mileage to the actual odometer reading.',
      'Add walk-around photos — see the shot list below.',
      'Mark and photograph every damage or fix on the truck. If it needs work, it gets a photo.',
      'Final step: click the 3 dots in the top-right corner again and click \u201cSave\u201d.',
    ],
  },
  {
    k: '3',
    title: 'Body Quoter App',
    tag: 'BODY QUOTER',
    intro: 'Turn the damage into priced work the RO can quote from. In the app:',
    items: [
      'Scan or manually enter the VIN to start the quote.',
      'Verify the truck information is correct.',
      'Add the stock # and the Estimator.',
      'Take and upload photos of the damage.',
      'Confirm the quote is accurate and make any necessary adjustments.',
      'Click the PDF button and attach the quote to the MDD card in the attachment file (Step 4).',
    ],
  },
  {
    k: '4',
    title: 'Enter Everything in MDD',
    tag: 'MDD',
    intro: 'MDD is the finish line. This is where the RO gets written from — nothing should be missing.',
    items: [
      'Add the tasks the truck needs from the catalog, comparing against your walk-around (Body Shop, Bumper, PDR, Tires, Detail, etc.).',
      'If emissions are not ready, add a Drive Cycle task.',
      'Confirm the Body Quoter estimate PDF has been added to the MDD card.',
      'Make sure all relevant flags are added to the vehicle card.',
      'In Communications, spell out the body shop work in detail — note each damage, the specific panels affected, and exactly what needs to be repaired or replaced.',
    ],
  },
];

const RO_SPEC = [
  'VIN tied to the UVEye scan',
  'Current mileage entered',
  'vAuto record copied as new',
  'Full walk-around photo set',
  'Every damage / fix marked & photo\u2019d',
  'Body Quoter estimate PDF in MDD',
  'Recon tasks added in MDD',
  'MDD tracking tags on key & vehicle',
  'All info in MDD, RO-ready',
];

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
  };
}

export default function IntakeScreen({ showToast }) {
  const [vin, setVin] = useState('');
  const [intake, setIntake] = useState(null);
  const [quoting, setQuoting] = useState(false); // Body Quoter sub-view
  const intakeRef = useRef(null);
  intakeRef.current = intake;

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
            quoteId: null,
            ts: next.ts,
            data: {
              steps: { 1: next.steps[1], 2: next.steps[2], 3: next.steps[3], 4: next.steps[4] },
              roReady: next.roReady,
              photoCount: 0,
              notes: next.notes || '',
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
    (raw) => {
      const v = String(raw || '').trim().toUpperCase();
      const cache = loadCache();
      const it = v && cache[v] ? cache[v] : blankIntake(v);
      setIntake(it);
      if (v.length >= 6) refreshFromServer(v);
    },
    [refreshFromServer]
  );

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

  const ikToggleStep = (k, idx) => {
    if (!intake || locked) return;
    const steps = { ...intake.steps, [k]: (intake.steps[k] || []).map((val, i) => (i === idx ? !val : val)) };
    saveIntake({ steps });
  };
  const ikToggleRo = (idx) => {
    if (!intake || locked) return;
    const roReady = (intake.roReady || []).map((val, i) => (i === idx ? !val : val));
    saveIntake({ roReady });
  };

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

  // ---------- progress ----------
  let overallDone = 0;
  let overallTotal = 0;
  if (intake) {
    INTAKE_SPEC.forEach((sp) => {
      const vals = intake.steps[sp.k] || [];
      overallTotal += sp.items.length;
      overallDone += sp.items.filter((_, i) => vals[i]).length;
    });
  }
  const overallPct = overallTotal ? Math.round((overallDone / overallTotal) * 100) : 0;
  const roDone = intake ? (intake.roReady || []).filter(Boolean).length : 0;
  const complete = roDone === 9 || (intake && intake.completedAt);

  // Body Quoter sub-view — opens over the checklist for the current VIN and
  // returns here on back. Keeps the Intake tab as the single host.
  if (quoting && intake) {
    return (
      <QuoteScreen
        prefill={{ vin: intake.vin, stock: intake.stock, vehicle: intake.vehicle, estimator: intake.estimator, miles: intake.miles }}
        onClose={() => setQuoting(false)}
        showToast={showToast}
      />
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
            {/* progress card */}
            <div className="card">
              <div className="card-title">INTAKE PROGRESS</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 6 }}>
                <span className="oswald" style={{ fontWeight: 700, fontSize: 22, color: complete ? 'var(--green)' : 'var(--ink)' }}>
                  {overallPct}%
                </span>
                <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>
                  {overallDone}/{overallTotal} steps done
                </span>
                <span style={{ flex: 1 }} />
                <span
                  style={{
                    fontSize: 9,
                    fontWeight: 700,
                    letterSpacing: 0.6,
                    color: '#fff',
                    background: complete ? 'var(--green)' : 'var(--amber)',
                    padding: '3px 8px',
                    borderRadius: 5,
                  }}
                >
                  {complete ? 'RO-READY ✓' : 'IN PROGRESS'}
                </span>
              </div>
              <div style={{ marginTop: 8, height: 7, borderRadius: 4, background: 'var(--panel2)', overflow: 'hidden' }}>
                <div style={{ width: overallPct + '%', height: '100%', background: complete ? 'var(--green)' : 'var(--red)', transition: 'width .2s' }} />
              </div>
              {intake.completedAt ? (
                <div style={{ fontSize: 10, color: 'var(--green)', fontWeight: 600, marginTop: 6 }}>
                  Completed {new Date(intake.completedAt).toLocaleDateString()}
                </div>
              ) : null}
            </div>

            {/* vehicle detail fields */}
            <div className="card">
              <div className="card-title">TRUCK</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 6 }}>
                <div>
                  <div className="field-label">STOCK #</div>
                  <input
                    className="input"
                    value={intake.stock}
                    onChange={(e) => saveIntake({ stock: e.target.value.trim().toUpperCase() })}
                  />
                </div>
                <div>
                  <div className="field-label">MILES</div>
                  <input
                    className="input"
                    value={intake.miles}
                    onChange={(e) => saveIntake({ miles: e.target.value.trim() })}
                  />
                </div>
                <div style={{ gridColumn: '1 / span 2' }}>
                  <div className="field-label">VEHICLE</div>
                  <input
                    className="input"
                    value={intake.vehicle}
                    onChange={(e) => saveIntake({ vehicle: e.target.value })}
                  />
                </div>
                <div style={{ gridColumn: '1 / span 2' }}>
                  <div className="field-label">ESTIMATOR</div>
                  <input
                    className="input"
                    value={intake.estimator}
                    onChange={(e) => saveIntake({ estimator: e.target.value })}
                  />
                </div>
              </div>
            </div>

            {/* step cards */}
            {INTAKE_SPEC.map((sp, si) => {
              const vals = intake.steps[sp.k] || [];
              const done = sp.items.filter((_, i) => vals[i]).length;
              const stepComplete = done === sp.items.length;
              return (
                <div className="card" key={sp.k}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                    <span
                      className="oswald"
                      style={{
                        width: 26,
                        height: 26,
                        borderRadius: 7,
                        background: stepComplete ? 'var(--green)' : 'var(--red)',
                        color: '#fff',
                        fontWeight: 700,
                        fontSize: 13,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flex: '0 0 auto',
                      }}
                    >
                      {si + 1}
                    </span>
                    <span className="oswald" style={{ fontWeight: 600, fontSize: 15, flex: 1, minWidth: 0 }}>
                      {sp.title}
                    </span>
                    <span style={{ fontSize: 8.5, fontWeight: 700, color: '#fff', background: 'var(--brown)', padding: '2px 6px', borderRadius: 4, flex: '0 0 auto' }}>
                      {sp.tag}
                    </span>
                    <span style={{ fontSize: 10, fontWeight: 700, color: stepComplete ? 'var(--green)' : 'var(--muted)', flex: '0 0 auto' }}>
                      {done}/{sp.items.length}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.45, marginTop: 6 }}>{sp.intro}</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                    {sp.items.map((text, i) => (
                      <IkRow key={i} text={text} on={!!vals[i]} onToggle={() => ikToggleStep(sp.k, i)} />
                    ))}
                  </div>
                  {sp.k === '3' && (
                    <button className="btn btn-red" style={{ marginTop: 10 }} onClick={() => setQuoting(true)}>
                      🛠 Open Body Quoter
                    </button>
                  )}
                </div>
              );
            })}

            {/* RO-Ready check */}
            <div className="card">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="oswald" style={{ fontWeight: 600, fontSize: 15, flex: 1 }}>RO-Ready Check</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: roDone === 9 ? 'var(--green)' : 'var(--muted)' }}>{roDone}/9</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                {RO_SPEC.map((text, i) => (
                  <IkRow key={i} text={text} on={!!(intake.roReady || [])[i]} onToggle={() => ikToggleRo(i)} />
                ))}
              </div>
              {complete && (
                <div style={{ marginTop: 10, textAlign: 'center', fontSize: 12, fontWeight: 700, color: 'var(--green)' }}>
                  ✓ Intake complete — this truck is RO-ready.
                </div>
              )}

              {/* Commit sign-off: required at commit, not at start. */}
              {locked ? (
                <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 8, background: '#e8f3ea', border: '1px solid var(--green)' }}>
                  <SignatureBadge committedBy={intake.committedBy} overriddenBy={intake.overriddenBy} />
                  <div style={{ fontSize: 9.5, color: 'var(--muted)', marginTop: 4 }}>
                    Committed and locked. A correction is a new record, not an edit.
                  </div>
                </div>
              ) : roDone === 9 ? (
                <button className="btn btn-green" style={{ marginTop: 10, height: 46 }} onClick={() => setPinOpen(true)}>
                  ✍ Commit intake
                </button>
              ) : null}
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
    </div>
  );
}

function IkRow({ text, on, onToggle }) {
  return (
    <div
      onClick={onToggle}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 9,
        padding: '9px 10px',
        borderRadius: 8,
        cursor: 'pointer',
        background: on ? '#e8f3ea' : '#fff',
        border: '1px solid ' + (on ? 'var(--green)' : 'var(--border)'),
      }}
    >
      <span
        style={{
          width: 20,
          height: 20,
          borderRadius: 5,
          flex: '0 0 auto',
          marginTop: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 12,
          fontWeight: 700,
          color: '#fff',
          background: on ? 'var(--green)' : 'transparent',
          border: '1.5px solid ' + (on ? 'var(--green)' : 'var(--muted2)'),
        }}
      >
        {on ? '✓' : ''}
      </span>
      <span style={{ fontSize: 12, lineHeight: 1.45, color: on ? 'var(--ink)' : 'var(--brown)', fontWeight: on ? 600 : 500 }}>{text}</span>
    </div>
  );
}
