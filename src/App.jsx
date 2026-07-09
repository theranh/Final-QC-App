import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import { CATS, CHECKLIST } from './lib/constants';
import { initBoot, newDraft, persistDraftBundle, saveLS, loadLS, stripRc, migrateRecord } from './lib/storage';
import { failList } from './lib/records';
import { curPeriod } from './lib/stats';
import { exportCsv, exportBackup, parseBackupFile } from './lib/exports';
import { compressImageFile } from './lib/photo';

import Header from './components/Header';
import BottomNav from './components/BottomNav';
import StaleTabBanner from './components/StaleTabBanner';
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

export default function App() {
  const [boot] = useState(() => initBoot());

  const [users, setUsers] = useState(() => boot.users);
  const [defaultUid, setDefaultUid] = useState(() => boot.defaultUid);
  const [recs, setRecs] = useState(() => boot.recs);
  const [seq, setSeq] = useState(() => boot.seq);

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
  const [rcUid, setRcUid] = useState(null);
  const [scanning, setScanning] = useState(false);

  const [q, setQ] = useState('');
  const [fRes, setFRes] = useState('all');
  const [fFrom, setFFrom] = useState('');
  const [fTo, setFTo] = useState('');
  const [viewRec, setViewRec] = useState(null);

  const [period, setPeriod] = useState('mtd');
  const [printing, setPrinting] = useState(false);

  const [editUser, setEditUser] = useState(null);
  const [uName, setUName] = useState('');
  const [uTitle, setUTitle] = useState('');
  const [uEmail, setUEmail] = useState('');

  const [toastMsg, setToastMsg] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  const [staleTabWarning, setStaleTabWarning] = useState(false);
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

  // A failed localStorage write is otherwise silent — surface it so nobody believes
  // an inspection is safely committed when the device is actually out of storage.
  const warnIfStorageFailed = useCallback(
    (ok) => {
      if (!ok) showToast('Storage full — could not save. Export a backup and free up space (Settings).');
    },
    [showToast]
  );

  // ---------- persistence ----------
  useEffect(() => { warnIfStorageFailed(saveLS('users', users)); }, [users, warnIfStorageFailed]);
  useEffect(() => { warnIfStorageFailed(saveLS('inspections', recs)); }, [recs, warnIfStorageFailed]);
  useEffect(() => { warnIfStorageFailed(saveLS('seq', seq)); }, [seq, warnIfStorageFailed]);
  useEffect(() => { warnIfStorageFailed(saveLS('default', defaultUid)); }, [defaultUid, warnIfStorageFailed]);
  useEffect(() => {
    clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      warnIfStorageFailed(persistDraftBundle({ draft, marks, notes, photos: photosMap, optOut, stage }));
    }, 250);
    return () => clearTimeout(persistTimerRef.current);
  }, [draft, marks, notes, photosMap, optOut, stage, warnIfStorageFailed]);

  // ---------- multi-tab / multi-window safety net ----------
  // All inspections live under one localStorage key with a full read-modify-write cycle per
  // change, so two tabs of the same browser open at once can silently clobber each other's
  // writes. We can't merge them safely, so make the collision visible instead of silent.
  useEffect(() => {
    const onStorage = (e) => {
      // The 'storage' event only fires in OTHER tabs/windows than the one that wrote —
      // exactly the case we need to warn about.
      if (!e.key || !e.key.startsWith('fqc_') || e.key === 'fqc_draft') return;
      setStaleTabWarning(true);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

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

  const insp = users.find((u) => u.id === draft.uid) || users[0];

  // ---------- VIN scan ----------
  const onVinDetected = (vin, ok) => {
    setScanning(false);
    dset({ vin });
    showToast(ok ? 'VIN scanned — check digit OK ✓' : 'VIN scanned — check digit FAILED, verify against the label');
  };

  // ---------- commit original inspection ----------
  const commit = () => {
    if (!sigSigned) return;
    const u = insp;
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
    const id = 'FQ-' + seq;
    const rec = {
      id,
      ts: Date.now(),
      stock: draft.stock.trim(),
      vehicle: draft.vehicle.trim(),
      vin: (draft.vin || '').trim().toUpperCase(),
      vinPhoto: (photosMap['vin'] || [])[0] || null,
      inspector: u.name,
      title: u.title,
      result: failCount ? 'fail' : 'pass',
      status: failCount ? 'open' : 'pass',
      clearedTs: null,
      rechecks: [],
      optOut: { ...optOut },
      items,
      checked,
      failCount,
      sig: sigRef.current ? sigRef.current.toDataURL() : null,
      committed: true,
    };
    rec.openItems = failCount ? failList(rec, CATS).map((f) => ({ cat: f.k, item: f.item, note: f.note, photos: f.photos })) : [];
    setRecs((prev) => [rec, ...prev]);
    setSeq((prev) => prev + 1);
    saveLS('draft', null);
    setDraft(newDraft(defaultUid));
    setMarks({});
    setNotes({});
    setPhotosMap({});
    setOptOut({});
    setSigSigned(false);
    setStage(null);
    setTab('records');
    setViewRec(id);
    showToast(id + (failCount ? ' committed — open re-check' : ' committed & locked ✓'));
  };

  // ---------- re-check ----------
  const openRecheck = (id) => {
    setStage('recheck');
    setRecheckId(id);
    setRcUid(defaultUid);
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
    if (!sigSigned) return;
    const r = recs.find((x) => x.id === recheckId);
    if (!r || r.status !== 'open') return;
    const u = users.find((x) => x.id === rcUid) || users[0];
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
    const cycle = { ts: Date.now(), inspector: u.name, title: u.title, sig: rcSigRef.current ? rcSigRef.current.toDataURL() : null, items: cycleItems };
    const still = cycleItems.filter((x) => x.outcome === 'fail').map((x) => ({ cat: x.cat, item: x.item, note: x.note || '', photos: x.photos || [] }));
    const updated = { ...r, rechecks: (r.rechecks || []).concat([cycle]), openItems: still, status: still.length ? 'open' : 'cleared', clearedTs: still.length ? null : cycle.ts };
    setRecs((prev) => prev.map((x) => (x.id === r.id ? updated : x)));
    const msg = still.length ? `${r.id} re-check committed — ${still.length} item${still.length === 1 ? '' : 's'} still open` : `${r.id} cleared — PASS on re-check ✓`;
    closeRecheck();
    showToast(msg);
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

  // ---------- settings / users ----------
  const editUserStart = (u) => {
    setEditUser(u ? u.id : 'new');
    setUName(u ? u.name : '');
    setUTitle(u ? u.title : '');
    setUEmail(u ? u.email : '');
  };
  const saveUser = () => {
    const name = uName.trim();
    const title = uTitle.trim();
    const email = uEmail.trim();
    if (!name || !title) return;
    if (editUser === 'new') setUsers((prev) => prev.concat([{ id: Date.now(), name, title, email }]));
    else setUsers((prev) => prev.map((u) => (u.id === editUser ? { ...u, name, title, email } : u)));
    setEditUser(null);
    showToast('Inspector saved ✓');
  };
  const deleteUser = () => {
    if (editUser === 'new') return;
    if (users.length <= 1) {
      showToast('Keep at least one inspector');
      return;
    }
    if (!window.confirm('Delete this inspector? Past inspections keep their recorded name.')) return;
    const remaining = users.filter((u) => u.id !== editUser);
    setUsers(remaining);
    if (defaultUid === editUser) setDefaultUid(remaining[0].id);
    if (draft.uid === editUser) dset({ uid: remaining[0].id });
    setEditUser(null);
    showToast('Inspector deleted');
  };
  const makeDefault = (id) => {
    setDefaultUid(id);
    showToast('Default inspector set ✓');
  };

  // ---------- backup ----------
  const onExportBackup = () => {
    exportBackup(users, recs, seq, defaultUid);
    const ts = Date.now();
    setLastBackupAt(ts);
    saveLS('lastBackupAt', ts);
    showToast('Backup downloaded ✓');
  };
  const onImportFile = (file) => {
    parseBackupFile(file)
      .then((data) => {
        if (!window.confirm(`Replace ALL data on this device with this backup?\n${data.inspections.length} inspections · ${data.users.length} users`)) return;
        const migrated = data.inspections.map((r) => migrateRecord({ ...r }));
        setUsers(data.users);
        setRecs(migrated);
        setSeq(data.seq || 1001);
        setDefaultUid(data.defaultUid || (data.users[0] && data.users[0].id));
        setViewRec(null);
        setEditUser(null);
        showToast('Backup restored ✓');
      })
      .catch((err) => showToast(err.message));
  };

  // ---------- nav ----------
  const openRecs = recs.filter((r) => r.status === 'open');
  const inFlow = stage != null;
  const onNavChange = (k) => {
    setTab(k);
    setViewRec((prev) => (k === 'records' ? prev : null));
    setEditUser(null);
  };

  if (printing) {
    return <PrintReport recs={recs} period={period} onClose={() => setPrinting(false)} onPrint={() => window.print()} />;
  }

  let content = null;
  if (stage === 'form') {
    content = (
      <NewInspectionForm
        draft={draft}
        onDraftChange={dset}
        users={users}
        optOut={optOut}
        onToggleOptOut={toggleOptOut}
        photosMap={photosMap}
        onTakePhoto={takePhoto}
        onRemovePhoto={removePhoto}
        onScanVin={() => setScanning(true)}
        onClose={() => setStage(null)}
        onGoSettings={() => { setTab('settings'); setStage(null); }}
        onStart={() => setStage('sheet')}
        nextId={'FQ-' + seq}
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
        seq={seq}
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
        users={users}
        rcUid={rcUid}
        onSetRcUid={setRcUid}
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
        nextId={'FQ-' + seq}
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
        users={users}
        defaultUid={defaultUid}
        onMakeDefault={makeDefault}
        editUser={editUser}
        uName={uName}
        uTitle={uTitle}
        uEmail={uEmail}
        onUName={setUName}
        onUTitle={setUTitle}
        onUEmail={setUEmail}
        onAddUser={() => editUserStart(null)}
        onEditUser={editUserStart}
        onSaveUser={saveUser}
        onCancelUser={() => setEditUser(null)}
        onDeleteUser={deleteUser}
        lastBackupAt={lastBackupAt}
        recs={recs}
        seq={seq}
        onExportBackup={onExportBackup}
        onImportFile={onImportFile}
      />
    );
  }

  return (
    <div className="app-shell">
      <div className="app-frame">
        {staleTabWarning && <StaleTabBanner onReload={() => window.location.reload()} />}
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
