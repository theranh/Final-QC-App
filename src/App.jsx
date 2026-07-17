import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import { CATS, CHECKLIST } from './lib/constants';
import { initDraftBoot, newDraft, persistDraftBundle, saveLS, loadLS, stripRc } from './lib/storage';
import { curPeriod } from './lib/stats';
import { exportCsv, exportBackup } from './lib/exports';
import { compressImageFile } from './lib/photo';
import { vinValid, decodeVinInfo } from './lib/vin';
import { api } from './lib/api';
import { useAuth } from './hooks/useAuth';

import Header from './components/Header';
import BottomNav from './components/BottomNav';
import Toast from './components/Toast';
import Lightbox from './components/Lightbox';
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

export default function App() {
  const auth = useAuth();

  if (auth.status === 'loading') return <LoadingScreen />;
  if (auth.status === 'signed_out') return <LoginScreen />;
  if (auth.status === 'error') return <ErrorScreen onRetry={auth.refresh} />;
  if (auth.status !== 'active') return <AccessScreen status={auth.status} email={auth.email} />;

  return <AuthedApp me={auth.employee} onAuthRefresh={auth.refresh} />;
}

function AuthedApp({ me }) {
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
  const [saving, setSaving] = useState(false);

  const [tab, setTab] = useState('inspect');
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

  const [toastMsg, setToastMsg] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  const [lastBackupAt, setLastBackupAt] = useState(() => loadLS('lastBackupAt', null));

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
  const loadData = useCallback(async () => {
    setLoadState('loading');
    // Retry transient failures (network blips, cold starts, brief 5xx) with
    // backoff before surfacing the error screen.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const data = await api.bootstrap();
        setRecs(data.inspections);
        setNextQc(data.nextQc);
        setLoadState('ready');
        return;
      } catch (err) {
        if (err.status === 401 || attempt === 2) {
          setLoadState('error');
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  }, []);
  useEffect(() => {
    loadData();
  }, [loadData]);

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
  const autoVehicleRef = useRef({ vin: null, value: null });
  const draftVin = stage === 'form' ? (draft.vin || '').toUpperCase() : '';
  useEffect(() => {
    if (draftVin.length !== 17 || !vinValid(draftVin)) return;
    if (autoVehicleRef.current.vin === draftVin) return;
    let cancelled = false;
    decodeVinInfo(draftVin).then((desc) => {
      if (cancelled || !desc) return;
      const prevAuto = autoVehicleRef.current.value;
      autoVehicleRef.current = { vin: draftVin, value: desc };
      setDraft((prev) => {
        const cur = (prev.vehicle || '').trim();
        if (cur && cur !== prevAuto) return prev; // inspector typed their own — leave it
        if (cur === desc) return prev;
        return { ...prev, vehicle: desc };
      });
      showToast('Vehicle filled from VIN ✓');
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftVin]);

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
  const periodObj = useMemo(() => curPeriod(recs, period), [recs, period]);
  const onExportCsv = () => {
    const ok = exportCsv(recs, periodObj);
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
  const onExportBackup = () => {
    exportBackup([meUser], recs, nextQc || 1001, meUser.id);
    const ts = Date.now();
    setLastBackupAt(ts);
    saveLS('lastBackupAt', ts);
    showToast('Backup downloaded ✓');
  };

  // ---------- nav ----------
  const openRecs = recs.filter((r) => r.status === 'open');
  const inFlow = stage != null;
  const onNavChange = (k) => {
    setTab(k);
    setViewRec((prev) => (k === 'records' ? prev : null));
  };

  if (loadState === 'loading') return <LoadingScreen />;
  if (loadState === 'error') return <ErrorScreen onRetry={loadData} />;

  if (printing) {
    return <PrintReport recs={recs} period={period} onClose={() => setPrinting(false)} onPrint={() => window.print()} />;
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
      <RecordDetail record={record} onBack={() => setViewRec(null)} onStartRecheck={openRecheck} onOpenLightbox={setLightbox} />
    ) : (
      <RecordsList recs={recs} q={q} onQ={setQ} fRes={fRes} onFRes={setFRes} fFrom={fFrom} onFFrom={setFFrom} fTo={fTo} onFTo={setFTo} onOpenRecord={setViewRec} />
    );
  } else if (tab === 'reports') {
    content = <ReportsScreen recs={recs} period={period} onPeriod={setPeriod} onExportCsv={onExportCsv} onExportPdf={onExportPdf} />;
  } else if (tab === 'settings') {
    content = (
      <SettingsScreen
        me={me}
        lastBackupAt={lastBackupAt}
        recs={recs}
        nextQc={nextQc || 1001}
        onExportBackup={onExportBackup}
        onImported={loadData}
        showToast={showToast}
      />
    );
  }

  return (
    <div className="app-shell">
      <div className="app-frame">
        <Header tab={tab} />
        {content}
        {!inFlow && <BottomNav tab={tab} onChange={onNavChange} openRecheckCount={openRecs.length} />}
        <Toast message={toastMsg} />
        <Lightbox src={lightbox} onClose={() => setLightbox(null)} />
        {scanning && <VinScanner onDetected={onVinDetected} onCancel={() => setScanning(false)} />}
        <input ref={photoInputRef} type="file" accept="image/*" capture="environment" onChange={onPhotoFile} style={{ display: 'none' }} />
      </div>
    </div>
  );
}
