import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import { CATS, CHECKLIST } from './lib/constants';
import { initDraftBoot, newDraft, persistDraftBundle, saveLS, loadLS, stripRc } from './lib/storage';
import { curPeriod } from './lib/stats';
import { exportCsv, exportBackup, downloadServerBackup } from './lib/exports';
import { compressImageFile } from './lib/photo';
import { vinValid } from './lib/vin';
import { useVinAutofill } from './hooks/useVinAutofill';
import { api } from './lib/api';
import { useAuth } from './hooks/useAuth';
import useAppUpdate from './hooks/useAppUpdate';

import Header from './components/Header';
import BottomNav from './components/BottomNav';
import DashScreen from './components/DashScreen';
import VehiclesScreen from './components/VehiclesScreen';
import VehicleCard from './components/VehicleCard';
import IntakeScreen from './components/IntakeScreen';
import Toast from './components/Toast';
import Lightbox from './components/Lightbox';
import { prefetchZxing } from './lib/zxingDecode';
import VinScanner from './components/VinScanner';
import HomeScreen from './components/HomeScreen';
import NewInspectionForm from './components/NewInspectionForm';
import ChecklistSheet from './components/ChecklistSheet';
import ResultScreen from './components/ResultScreen';
import RecheckSheet from './components/RecheckSheet';
import RecordsList from './components/RecordsList';
import RecordDetail from './components/RecordDetail';
import ReportsScreen from './components/ReportsScreen';
import PrintReport from './components/PrintReport';
import SettingsScreen from './components/SettingsScreen';
import { LoadingScreen, LoginScreen, AccessScreen, ErrorScreen } from './components/AuthScreens';
import UpdateBanner from './components/UpdateBanner';
import PhotoQueueIndicator from './components/PhotoQueueIndicator';

export default function App() {
  const auth = useAuth();

  if (auth.status === 'loading') return <LoadingScreen />;
  if (auth.status === 'signed_out') return <LoginScreen />;
  if (auth.status === 'error') return <ErrorScreen onRetry={auth.refresh} detail={auth.errorDetail} />;
  if (auth.status !== 'active') return <AccessScreen status={auth.status} email={auth.email} />;

  return <AuthedApp me={auth.employee} onAuthRefresh={auth.refresh} />;
}

function AuthedApp({ me, onAuthRefresh }) {
  const { updateReady, applyUpdate } = useAppUpdate();
  const [boot] = useState(() => initDraftBoot());

  // The signed-in employee IS the inspector — identity comes from Replit Auth,
  // it can never be picked or typed in.
  const meUser = useMemo(
    () => ({ id: 'me', name: me.name, title: me.title, email: me.email }),
    [me.name, me.title, me.email]
  );

  const [recs, setRecs] = useState([]);
  const [nextQc, setNextQc] = useState(null);
  const [loadState, setLoadState] = useState('loading'); // loading | ready | error
  const [loadError, setLoadError] = useState(null); // last startup failure detail (shown on ErrorScreen)
  const [saving, setSaving] = useState(false);

  const [tab, setTab] = useState('dash');
  const [intakeOpenVin, setIntakeOpenVin] = useState(null); // VIN to auto-open on the Intake tab
  const [stage, setStage] = useState(() => boot.stage);
  const [draft, setDraft] = useState(() => boot.draft);
  const [marks, setMarks] = useState(() => boot.marks);
  const [notes, setNotes] = useState(() => boot.notes);
  const [photosMap, setPhotosMap] = useState(() => boot.photos);
  const [optOut, setOptOut] = useState(() => boot.optOut);
  const [repairs, setRepairs] = useState({});
  const [sigSigned, setSigSigned] = useState(false);

  const [recheckId, setRecheckId] = useState(null);
  const [scanning, setScanning] = useState(false);

  const [q, setQ] = useState('');
  const [fRes, setFRes] = useState('all');
  const [fFrom, setFFrom] = useState('');
  const [fTo, setFTo] = useState('');
  const [viewRec, setViewRec] = useState(null);

  const [period, setPeriod] = useState('mtd');
  const [printing, setPrinting] = useState(false);

  // Server-composed dashboard payload (QC + Body Quoter + tracker sheet).
  // All KPIs are computed server-side; screens only render this.
  const [dash, setDash] = useState(null);
  const [vehFilter, setVehFilter] = useState('awaitingFinalQc');
  const [vehQ, setVehQ] = useState('');
  const [vehSel, setVehSel] = useState(null); // { vin, qcNumber }

  const [toastMsg, setToastMsg] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  const [lastBackupAt, setLastBackupAt] = useState(() => loadLS('lastBackupAt', null));
  // Authoritative team-wide last-backup time (admins only): read from the
  // server's audit log, so exports taken on ANY device/admin count.
  // null = no export ever; undefined = not loaded yet.
  const [serverBackupAt, setServerBackupAt] = useState(undefined);
  const refreshBackupStatus = useCallback(() => {
    if (!me.isAdmin) return;
    api
      .backupStatus()
      .then((d) => setServerBackupAt(d.lastExportAt ? new Date(d.lastExportAt).getTime() : null))
      .catch(() => {}); // silent — keep the last known value
  }, [me.isAdmin]);
  useEffect(() => { refreshBackupStatus(); }, [refreshBackupStatus]);
  useEffect(() => { prefetchZxing(); }, []); // warm the barcode decoder before the scanner opens

  const sigRef = useRef(null);
  const rcSigRef = useRef(null);
  const photoInputRef = useRef(null);
  const photoKeyRef = useRef(null);
  const toastTimerRef = useRef(null);
  const persistTimerRef = useRef(null);

  const showToast = useCallback((msg) => {
    clearTimeout(toastTimerRef.current);
    setToastMsg(msg);
    toastTimerRef.current = setTimeout(() => setToastMsg(null), 2600);
  }, []);

  // ---------- initial data load (shared database) ----------
  const loadGenRef = useRef(0); // only the latest loadData run may touch state
  const loadData = useCallback(async () => {
    const gen = ++loadGenRef.current;
    const live = () => gen === loadGenRef.current;
    setLoadState('loading');
    // Server runs on an always-on Reserved VM — no cold start to wait out.
    // One quick retry absorbs a momentary network blip; a second failure is
    // a real outage and surfaces the error screen right away. 401 means the
    // session expired — hand control back to the auth flow (sign-in screen).
    const MAX_ATTEMPTS = 2;
    const RETRY_DELAY_MS = 1000;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const data = await api.bootstrap();
        if (!live()) return;
        dataGenRef.current++;
        setRecs(data.inspections);
        setNextQc(data.nextQc);
        setLoadState('ready');
        return;
      } catch (err) {
        if (!live()) return;
        if (err.status === 401) {
          onAuthRefresh?.(); // session expired → back to sign-in, not "server unreachable"
          return;
        }
        if (attempt === MAX_ATTEMPTS - 1) {
          setLoadError(err && err.message ? String(err.message) : 'Unknown error');
          setLoadState('error');
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        if (!live()) return;
      }
    }
  }, [onAuthRefresh]);
  useEffect(() => {
    loadData();
  }, [loadData]);

  // ---------- background refresh (keeps all devices in sync) ----------
  // Silently refetch shared data so inspections entered on other devices show
  // up without a manual reload. Runs every 30s while the tab is visible, plus
  // immediately when the tab regains focus/visibility. Never touches drafts
  // (device-local) and never flips the loading/error screens.
  const refreshInFlightRef = useRef(false);
  const dataGenRef = useRef(0); // bumped on every local mutation so stale refreshes are discarded
  const refreshData = useCallback(async () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (refreshInFlightRef.current) return; // single-flight: no overlapping refreshes
    refreshInFlightRef.current = true;
    const gen = dataGenRef.current;
    try {
      const data = await api.bootstrap();
      // If a save/re-check/import landed while this fetch was in flight, its
      // result is newer than this snapshot — drop it; the next tick refetches.
      if (gen !== dataGenRef.current) return;
      setRecs(data.inspections);
      setNextQc(data.nextQc);
    } catch {
      // Silent: transient network blips shouldn't disturb the UI; the next
      // tick or focus event will retry.
    } finally {
      refreshInFlightRef.current = false;
    }
  }, []);
  useEffect(() => {
    const id = setInterval(refreshData, 30000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') refreshData();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', refreshData);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', refreshData);
    };
  }, [refreshData]);

  // ---------- dashboard payload (server-composed; never recomputed here) ----------
  const dashInFlightRef = useRef(false);
  const refreshDash = useCallback(async () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (dashInFlightRef.current) return;
    dashInFlightRef.current = true;
    try {
      const d = await api.dashboard();
      setDash(d);
    } catch {
      // Silent — the dashboard shows the last payload until the next tick.
    } finally {
      dashInFlightRef.current = false;
    }
  }, []);
  useEffect(() => {
    refreshDash();
    const id = setInterval(refreshDash, 60000);
    window.addEventListener('focus', refreshDash);
    return () => {
      clearInterval(id);
      window.removeEventListener('focus', refreshDash);
    };
  }, [refreshDash]);

  // Archived units stay viewable in Records but are excluded from every
  // client-side report/export (CSV, PDF, period derivation) — mirrors server.
  const activeRecs = useMemo(() => recs.filter((r) => !r.archived), [recs]);

  // Reports uses its own range so past months stay server-computed too.
  const [reportDash, setReportDash] = useState(null);
  const periodObjForRange = useMemo(() => curPeriod(activeRecs, period), [activeRecs, period]);
  useEffect(() => {
    if (tab !== 'reports') return;
    const isoDay = (ts) => {
      const d = new Date(ts);
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    };
    const from = isoDay(periodObjForRange.start);
    const to = isoDay(periodObjForRange.end === Infinity ? Date.now() : periodObjForRange.end - 1);
    let dead = false;
    setReportDash(null);
    api.dashboard(from, to).then((d) => { if (!dead) setReportDash(d); }).catch(() => {});
    return () => { dead = true; };
  }, [tab, period, periodObjForRange.start, periodObjForRange.end]);

  // ---------- draft persistence (device-local scratch space only) ----------
  useEffect(() => {
    clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      persistDraftBundle({ draft, marks, notes, photos: photosMap, optOut, stage });
    }, 250);
    return () => clearTimeout(persistTimerRef.current);
  }, [draft, marks, notes, photosMap, optOut, stage]);

  // ---------- photos ----------
  const takePhoto = useCallback((key) => {
    photoKeyRef.current = key;
    if (photoInputRef.current) {
      photoInputRef.current.value = '';
      photoInputRef.current.click();
    }
  }, []);

  const onPhotoFile = useCallback(
    async (e) => {
      const file = e.target.files && e.target.files[0];
      const key = photoKeyRef.current;
      e.target.value = '';
      if (!file || !key) return;
      try {
        const url = await compressImageFile(file);
        setPhotosMap((prev) => {
          const p = { ...prev };
          if (key === 'vin') p[key] = [url];
          else p[key] = (p[key] || []).concat([url]);
          return p;
        });
      } catch {
        showToast('Could not read that image');
      }
    },
    [showToast]
  );

  const removePhoto = useCallback((key, idx) => {
    if (!window.confirm('Remove this photo?')) return;
    setPhotosMap((prev) => {
      const p = { ...prev };
      p[key] = (p[key] || []).filter((_, i) => i !== idx);
      return p;
    });
  }, []);

  // ---------- checklist state ----------
  const mark = useCallback((key, val) => {
    setMarks((prev) => {
      const m = { ...prev };
      m[key] = m[key] === val ? null : val;
      return m;
    });
  }, []);
  const noteSet = useCallback((key, e) => {
    const v = e.target.value;
    setNotes((prev) => ({ ...prev, [key]: v }));
  }, []);
  const repairSet = useCallback((key, e) => {
    const v = e.target.value;
    setRepairs((prev) => ({ ...prev, [key]: v }));
  }, []);
  const dset = useCallback((patch) => {
    setDraft((prev) => ({ ...prev, ...patch }));
  }, []);
  const toggleOptOut = useCallback((k) => {
    setOptOut((prev) => ({ ...prev, [k]: !prev[k] }));
  }, []);

  const insp = meUser;

  // ---------- VIN scan ----------
  const onVinDetected = (vin, ok) => {
    setScanning(false);
    dset({ vin });
    showToast(ok ? 'VIN scanned — check digit OK ✓' : 'VIN scanned — check digit FAILED, verify against the label');
  };

  // ---------- VIN → auto-fill Year / Make / Model ----------
  // Once a valid 17-char VIN is scanned or typed, decode it (NHTSA vPIC, best-effort)
  // and fill the vehicle field — but never overwrite text the inspector typed themselves.
  const draftVin = stage === 'form' ? (draft.vin || '').toUpperCase() : '';
  useVinAutofill(draftVin, setDraft, showToast);

  // ---------- commit original inspection ----------
  const commit = () => {
    if (!sigSigned || saving) return;
    const items = {};
    let checked = 0;
    let failCount = 0;
    CATS.forEach((c) => {
      items[c.k] = CHECKLIST[c.k].map((item, i) => {
        const key = c.k + '|' + i;
        const mk = optOut[c.k] ? 'n' : marks[key] || 'n';
        if (mk !== 'n') checked++;
        const it = { item, mark: mk };
        if (mk === 'f') {
          failCount++;
          it.note = (notes[key] || '').trim();
          it.photos = photosMap[key] || [];
        }
        return it;
      });
    });
    const payload = {
      stock: draft.stock.trim(),
      vehicle: draft.vehicle.trim(),
      vin: (draft.vin || '').trim().toUpperCase(),
      vinPhoto: (photosMap['vin'] || [])[0] || null,
      optOut: { ...optOut },
      items,
      checked,
      failCount,
      sig: sigRef.current ? sigRef.current.toDataURL() : null,
    };
    setSaving(true);
    api
      .createInspection(payload)
      .then(({ record, nextQc: nq }) => {
        dataGenRef.current++;
        setRecs((prev) => [record, ...prev]);
        setNextQc(nq);
        saveLS('draft', null);
        setDraft(newDraft('me'));
        setMarks({});
        setNotes({});
        setPhotosMap({});
        setOptOut({});
        setSigSigned(false);
        setStage(null);
        setTab('records');
        setViewRec(record.id);
        showToast(record.id + (record.failCount ? ' committed — open re-check' : ' committed & locked ✓'));
      })
      .catch((err) => {
        if (err.status === 401) window.location.href = '/api/login';
        else showToast('Could not save: ' + err.message);
      })
      .finally(() => setSaving(false));
  };

  // ---------- re-check ----------
  const openRecheck = (id) => {
    setStage('recheck');
    setRecheckId(id);
    setSigSigned(false);
    setMarks((prev) => stripRc(prev));
    setNotes((prev) => stripRc(prev));
    setPhotosMap((prev) => stripRc(prev));
    setRepairs({});
  };
  const closeRecheck = () => {
    setStage(null);
    setRecheckId(null);
    setSigSigned(false);
    setMarks((prev) => stripRc(prev));
    setNotes((prev) => stripRc(prev));
    setPhotosMap((prev) => stripRc(prev));
    setRepairs({});
  };
  const commitRecheck = () => {
    if (!sigSigned || saving) return;
    const r = recs.find((x) => x.id === recheckId);
    if (!r || r.status !== 'open') return;
    const open = r.openItems || [];
    for (let i = 0; i < open.length; i++) {
      const key = 'rc|' + i;
      const mk = marks[key];
      if (mk !== 'p' && mk !== 'f') return;
      if (mk === 'f') {
        if (!(notes[key] || '').trim()) return;
        if (!(photosMap[key] || []).length) return;
      }
    }
    const cycleItems = open.map((oi, i) => {
      const key = 'rc|' + i;
      const it = { cat: oi.cat, item: oi.item, origNote: oi.note || '', repairedBy: (repairs[key] || '').trim(), outcome: marks[key] === 'f' ? 'fail' : 'pass' };
      if (it.outcome === 'fail') {
        it.note = (notes[key] || '').trim();
        it.photos = photosMap[key] || [];
      }
      return it;
    });
    setSaving(true);
    api
      .commitRecheck(r.id, { sig: rcSigRef.current ? rcSigRef.current.toDataURL() : null, items: cycleItems })
      .then(({ record }) => {
        dataGenRef.current++;
        setRecs((prev) => prev.map((x) => (x.id === record.id ? record : x)));
        const still = (record.openItems || []).length;
        const msg = still ? `${record.id} re-check committed — ${still} item${still === 1 ? '' : 's'} still open` : `${record.id} cleared — PASS on re-check ✓`;
        closeRecheck();
        showToast(msg);
      })
      .catch((err) => {
        if (err.status === 401) window.location.href = '/api/login';
        else if (err.status === 409) {
          showToast('This inspection was already updated — reloading');
          loadData();
          closeRecheck();
        } else showToast('Could not save: ' + err.message);
      })
      .finally(() => setSaving(false));
  };

  // ---------- reports ----------
  const periodObj = useMemo(() => curPeriod(activeRecs, period), [activeRecs, period]);
  const onExportCsv = () => {
    const ok = exportCsv(activeRecs, periodObj);
    showToast(ok ? 'Excel (CSV) downloaded ✓' : 'No inspections in this period');
  };
  const onExportPdf = () => {
    if (!periodObj.recs.length) {
      showToast('No inspections in this period');
      return;
    }
    setPrinting(true);
  };

  // ---------- backup ----------
  const onExportBackup = async (opts = {}) => {
    const markDone = () => {
      const ts = Date.now();
      setLastBackupAt(ts);
      saveLS('lastBackupAt', ts);
      if (me?.isAdmin) setServerBackupAt(ts); // server audited the export just now
      showToast('Backup downloaded ✓');
    };
    if (me?.isAdmin && opts.full) {
      // Full export (all Quoter photos, hundreds of MB): the server streams it,
      // so hand the URL straight to the browser's downloader instead of
      // buffering the whole file in page memory.
      const a = document.createElement('a');
      a.href = '/api/export?photos=full';
      document.body.appendChild(a);
      a.click();
      a.remove();
      const ts = Date.now();
      setLastBackupAt(ts);
      saveLS('lastBackupAt', ts);
      setServerBackupAt(ts); // the server audits the export as it streams
      showToast('Full backup download started (large file — check your downloads)');
      return;
    }
    if (me?.isAdmin) {
      // Admins get the authoritative server export: full database contents
      // (inspections + employee allowlist + QC counter), not client state.
      try {
        const backup = await api.exportBackup();
        downloadServerBackup(backup);
        markDone();
      } catch (err) {
        showToast('Backup failed: ' + err.message);
      }
      return;
    }
    exportBackup([meUser], recs, nextQc || 1001, meUser.id);
    markDone();
  };

  // ---------- nav ----------
  const openRecs = recs.filter((r) => r.status === 'open');
  const inFlow = stage != null;
  const onNavChange = (k) => {
    setTab(k);
    setViewRec((prev) => (k === 'records' ? prev : null));
    if (k !== 'vehicles') setVehSel(null);
    if (k === 'dash' || k === 'vehicles') refreshDash();
  };
  // Open the intake (walk-around photos + details) for an awaiting-QC unit.
  const openIntakeFor = (v) => {
    setIntakeOpenVin(v.vin);
    setTab('intake');
  };
  const openVehicle = (vin, qcNumber) => {
    setTab('vehicles');
    setVehSel({ vin, qcNumber });
  };
  // Stale-backup nudge (admins): no server export in the audit log for over a
  // week — or ever. Hidden until the status has actually loaded.
  const backupNudge =
    me.isAdmin &&
    serverBackupAt !== undefined &&
    (serverBackupAt == null || Date.now() - serverBackupAt > 7 * 86400000);

  if (loadState === 'loading') return <LoadingScreen />;
  if (loadState === 'error') return <ErrorScreen onRetry={loadData} detail={loadError} />;

  if (printing) {
    return <PrintReport recs={activeRecs} period={period} onClose={() => setPrinting(false)} onPrint={() => window.print()} />;
  }

  const nextId = nextQc ? 'FQ-' + nextQc : 'FQ-…';

  let content = null;
  if (stage === 'form') {
    content = (
      <NewInspectionForm
        draft={draft}
        onDraftChange={dset}
        users={[meUser]}
        optOut={optOut}
        onToggleOptOut={toggleOptOut}
        photosMap={photosMap}
        onTakePhoto={takePhoto}
        onRemovePhoto={removePhoto}
        onScanVin={() => setScanning(true)}
        onClose={() => setStage(null)}
        onGoSettings={() => { setTab('settings'); setStage(null); }}
        onStart={() => setStage('sheet')}
        nextId={nextId}
        openRecs={openRecs}
        onOpenRecheck={openRecheck}
      />
    );
  } else if (stage === 'sheet') {
    content = (
      <ChecklistSheet
        draft={draft}
        insp={insp}
        marks={marks}
        notes={notes}
        photosMap={photosMap}
        optOut={optOut}
        onMark={mark}
        onNote={noteSet}
        onTakePhoto={takePhoto}
        onRemovePhoto={removePhoto}
        onClose={() => setStage('form')}
        onFinish={() => { setStage('result'); setSigSigned(false); }}
      />
    );
  } else if (stage === 'result') {
    content = (
      <ResultScreen
        draft={draft}
        insp={insp}
        marks={marks}
        optOut={optOut}
        seq={nextQc || '…'}
        sigRef={sigRef}
        sigSigned={sigSigned}
        onSigChange={setSigSigned}
        onClearSig={() => { sigRef.current && sigRef.current.clear(); }}
        onBack={() => setStage('sheet')}
        onCommit={commit}
      />
    );
  } else if (stage === 'recheck') {
    const record = recs.find((r) => r.id === recheckId);
    content = record ? (
      <RecheckSheet
        record={record}
        users={[meUser]}
        rcUid={meUser.id}
        onSetRcUid={() => {}}
        marks={marks}
        notes={notes}
        photosMap={photosMap}
        repairs={repairs}
        onMark={mark}
        onNote={noteSet}
        onRepair={repairSet}
        onTakePhoto={takePhoto}
        onRemovePhoto={removePhoto}
        sigRef={rcSigRef}
        sigSigned={sigSigned}
        onSigChange={setSigSigned}
        onClearSig={() => { rcSigRef.current && rcSigRef.current.clear(); }}
        onClose={closeRecheck}
        onCommit={commitRecheck}
        onOpenLightbox={setLightbox}
      />
    ) : null;
  } else if (tab === 'dash') {
    content = (
      <DashScreen
        dash={dash}
        onOpenStatus={(k) => { setVehFilter(k); setVehSel(null); setTab('vehicles'); }}
        onOpenVehicle={openVehicle}
      />
    );
  } else if (tab === 'vehicles') {
    const selVehicle = vehSel && dash ? (dash.vehicles || []).find((v) => v.qcNumber === vehSel.qcNumber) : null;
    content = selVehicle ? (
      <VehicleCard
        vehicle={selVehicle}
        record={recs.find((r) => r.id === selVehicle.qcNumber) || null}
        onBack={() => setVehSel(null)}
        onOpenRecord={(id) => { setTab('records'); setViewRec(id); }}
        onOpenLightbox={setLightbox}
      />
    ) : (
      <VehiclesScreen dash={dash} filter={vehFilter} onFilter={setVehFilter} q={vehQ} onQ={setVehQ} onOpenVehicle={openVehicle} onOpenIntake={openIntakeFor} />
    );
  } else if (tab === 'intake') {
    content = <IntakeScreen showToast={showToast} openVin={intakeOpenVin} onOpenVinConsumed={() => setIntakeOpenVin(null)} />;
  } else if (tab === 'inspect') {
    content = (
      <HomeScreen
        recs={recs}
        openRecs={openRecs}
        onNewInspection={() => setStage('form')}
        onOpenRecheck={openRecheck}
        onOpenRecord={(id) => { setTab('records'); setViewRec(id); }}
        onGoRecords={() => { setTab('records'); setViewRec(null); }}
      />
    );
  } else if (tab === 'records') {
    const record = viewRec ? recs.find((r) => r.id === viewRec) : null;
    content = record ? (
      <RecordDetail
        record={record}
        onBack={() => setViewRec(null)}
        onStartRecheck={openRecheck}
        onOpenLightbox={setLightbox}
        isAdmin={!!me?.isAdmin}
        onToggleArchive={(qc, archived) =>
          api
            .setArchived(qc, archived)
            .then(() => {
              setRecs((prev) => prev.map((x) => (x.id === qc ? { ...x, archived } : x)));
              showToast(archived ? 'Archived — hidden from dashboard & reports' : 'Unarchived — counting again');
              refreshDash();
            })
            .catch((err) => showToast(err.message))
        }
      />
    ) : (
      <RecordsList recs={recs} q={q} onQ={setQ} fRes={fRes} onFRes={setFRes} fFrom={fFrom} onFFrom={setFFrom} fTo={fTo} onFTo={setFTo} onOpenRecord={setViewRec} />
    );
  } else if (tab === 'reports') {
    content = <ReportsScreen recs={activeRecs} period={period} onPeriod={setPeriod} onExportCsv={onExportCsv} onExportPdf={onExportPdf} dash={reportDash} onOpenVehicle={openVehicle} />;
  } else if (tab === 'settings') {
    content = (
      <SettingsScreen
        me={me}
        lastBackupAt={lastBackupAt}
        serverBackupAt={serverBackupAt}
        recs={recs}
        nextQc={nextQc || 1001}
        onExportBackup={onExportBackup}
        onImported={loadData}
        onArchived={() => { refreshData(); refreshDash(); }}
        showToast={showToast}
      />
    );
  }

  return (
    <div className="app-shell">
      <div className="app-frame">
        {updateReady && <UpdateBanner onRefresh={applyUpdate} />}
        {backupNudge && !inFlow && tab !== 'settings' && (
          <div
            style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--amber)', color: '#fff', fontSize: 10.5, fontWeight: 700, padding: '8px 14px', cursor: 'pointer' }}
            onClick={() => { setTab('settings'); setViewRec(null); setVehSel(null); }}
          >
            <span style={{ flex: 1, lineHeight: 1.4 }}>
              {serverBackupAt == null
                ? '● The shared database has never been backed up. Export a backup from Settings.'
                : `● Last team backup was ${Math.floor((Date.now() - serverBackupAt) / 86400000)} days ago. Export a fresh backup from Settings.`}
            </span>
            <span style={{ flex: '0 0 auto', textDecoration: 'underline' }}>Settings →</span>
          </div>
        )}
        <Header tab={tab} onSettings={inFlow ? null : () => { setTab('settings'); setViewRec(null); setVehSel(null); }} />
        {content}
        {!inFlow && <BottomNav tab={tab} onChange={onNavChange} openRecheckCount={openRecs.length} />}
        <Toast message={toastMsg} />
        <PhotoQueueIndicator />
        <Lightbox src={lightbox} onClose={() => setLightbox(null)} />
        {scanning && <VinScanner onDetected={onVinDetected} onCancel={() => setScanning(false)} />}
        <input ref={photoInputRef} type="file" accept="image/*" capture="environment" onChange={onPhotoFile} style={{ display: 'none' }} />
      </div>
    </div>
  );
}
