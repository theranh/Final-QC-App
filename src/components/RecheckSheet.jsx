import { REQUIRE_PHOTO_ON_FAIL, catByKey, chipStyle } from '../lib/constants';
import { fmtDT } from '../lib/format';
import PhotoRow from './PhotoRow';
import SignaturePad from './SignaturePad';
import VoiceNoteButton from './VoiceNoteButton';

export default function RecheckSheet({ record, users, rcUid, onSetRcUid, marks, notes, photosMap, repairs, onMark, onNote, onRepair, onTakePhoto, onRemovePhoto, sigRef, sigSigned, onSigChange, onClearSig, onClose, onCommit, onOpenLightbox }) {
  const rcInsp = users.find((u) => u.id === rcUid) || users[0];
  const open = record.openItems || [];
  let undecided = 0, noteMissing = 0, photoMissing = 0, refails = 0;

  const items = open.map((oi, i) => {
    const key = 'rc|' + i;
    const mk = marks[key];
    if (mk !== 'p' && mk !== 'f') undecided++;
    const isF = mk === 'f';
    const note = notes[key] || '';
    const phs = photosMap[key] || [];
    let needLabel = '';
    if (isF) {
      refails++;
      const needN = !note.trim();
      const needP = REQUIRE_PHOTO_ON_FAIL && !phs.length;
      if (needN) noteMissing++;
      if (needP) photoMissing++;
      if (needN && needP) needLabel = 'New fail note + photo required';
      else if (needN) needLabel = 'New fail note required';
      else if (needP) needLabel = 'Photo required to fail again';
    }
    return { key, oi, mk, isF, note, phs, needLabel };
  });

  const ready = undecided === 0 && noteMissing === 0 && photoMissing === 0;
  const canCommit = ready && sigSigned;
  const warnParts = [];
  if (noteMissing) warnParts.push(`${noteMissing} re-fail${noteMissing === 1 ? '' : 's'} missing a note`);
  if (photoMissing) warnParts.push(`${photoMissing} missing the required photo`);

  const commitLabel = !ready
    ? undecided
      ? `Decide ${undecided} more item${undecided === 1 ? '' : 's'}`
      : noteMissing
      ? `Add new fail note${noteMissing === 1 ? '' : 's'}`
      : `Add photo${photoMissing === 1 ? '' : 's'} to re-fail`
    : !sigSigned
    ? 'Sign above to commit'
    : refails
    ? `Commit — ${refails} item${refails === 1 ? '' : 's'} fail again`
    : 'Commit — cleared → PASS on re-check';

  return (
    <div className="screen">
      <div className="screen-topbar" style={{ padding: '10px 14px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <span className="icon-btn" onClick={onClose}>‹</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span className="oswald" style={{ fontWeight: 600, fontSize: 15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {record.id} · {record.stock} · {record.vehicle}
              </span>
              <span style={{ fontSize: 8.5, fontWeight: 700, color: '#fff', background: 'var(--amber)', padding: '2px 7px', borderRadius: 5, flex: '0 0 auto' }}>RE-CHECK</span>
            </div>
            <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>Only previously failed items — {open.length} to clear</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 9, overflowX: 'auto', paddingBottom: 2 }}>
          {users.map((u) => {
            const on = rcInsp && rcInsp.id === u.id;
            return (
              <span key={u.id} className={'pill-btn' + (on ? ' on green' : '')} onClick={() => onSetRcUid(u.id)} style={on ? { background: '#F0F6F1', border: '1.5px solid var(--green)', color: 'var(--ink)' } : {}}>
                {u.name} · {u.title}
              </span>
            );
          })}
        </div>
      </div>
      <div className="screen-body">
        {items.map(({ key, oi, mk, isF, note, phs, needLabel }) => (
          <div key={key} style={{ background: '#fff', border: isF ? '1.5px solid var(--red)' : mk === 'p' ? '1.5px solid var(--green)' : '1px solid var(--border)', borderRadius: 12, padding: '11px 12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={chipStyle(oi.cat)}>{catByKey(oi.cat).seg}</span>
              <span style={{ fontSize: 12.5, fontWeight: 700, flex: 1, minWidth: 0 }}>{oi.item}</span>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8, background: '#F9F7F5', border: '1px solid var(--border2)', borderRadius: 8, padding: 8 }}>
              {(oi.photos || []).map((src, idx) => (
                <div key={idx} className="photo-thumb" style={{ width: 46, height: 38, backgroundImage: `url('${src}')` }} onClick={() => onOpenLightbox(src)} />
              ))}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 10, color: 'var(--brown)', lineHeight: 1.4 }}>&ldquo;{oi.note || '—'}&rdquo;</div>
                <div className="mono" style={{ fontSize: 8.5, color: 'var(--muted)', marginTop: 2 }}>failed {fmtDT(record.ts)} · {record.inspector}</div>
              </div>
            </div>
            <input
              className="input"
              value={repairs[key] || ''}
              onChange={(e) => onRepair(key, e)}
              placeholder="Repaired by / RO # (optional)…"
              style={{ marginTop: 8, height: 44, fontSize: 12 }}
            />
            <div style={{ display: 'flex', gap: 7, marginTop: 8 }}>
              <div
                style={{ flex: 1.4, height: 46, borderRadius: 9, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, cursor: 'pointer', background: mk === 'p' ? 'var(--green)' : '#fff', color: mk === 'p' ? '#fff' : 'var(--green)', border: '1.5px solid ' + (mk === 'p' ? 'var(--green)' : 'var(--green)') }}
                onClick={() => onMark(key, 'p')}
              >
                Pass — cleared ✓
              </div>
              <div
                style={{ flex: 1, height: 46, borderRadius: 9, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, cursor: 'pointer', background: mk === 'f' ? 'var(--red)' : '#fff', color: mk === 'f' ? '#fff' : 'var(--red)', border: '1.5px solid ' + (mk === 'f' ? 'var(--red)' : 'var(--border)') }}
                onClick={() => onMark(key, 'f')}
              >
                Fail again
              </div>
            </div>
            {isF && (
              <>
                <div style={{ display: 'flex', gap: 7, marginTop: 9, alignItems: 'center', flexWrap: 'wrap' }}>
                  <PhotoRow photos={phs} onAdd={() => onTakePhoto(key)} onRemove={(idx) => onRemovePhoto(key, idx)} />
                  <input className="input" value={note} onChange={(e) => onNote(key, e)} placeholder="New fail note (required)…" style={{ flex: 1, minWidth: 140, height: 44, fontSize: 12 }} />
                  <VoiceNoteButton
                    currentNote={note}
                    onNote={(text) => onNote(key, { target: { value: text } })}
                  />
                </div>
                {needLabel && <div style={{ fontSize: 9, color: 'var(--red)', fontWeight: 700, marginTop: 5 }}>● {needLabel}</div>}
              </>
            )}
          </div>
        ))}

        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <div className="card-title" style={{ flex: 1 }}>RE-CHECK SIGNATURE — LOCKS THIS RE-CHECK</div>
            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--red)', cursor: 'pointer', padding: 6 }} onClick={onClearSig}>Clear</div>
          </div>
          <SignaturePad ref={sigRef} onSignedChange={onSigChange} />
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 7 }} className="mono">
            <span style={{ fontSize: 9, color: 'var(--muted)' }}>{rcInsp.name} — {rcInsp.title}</span>
            <span style={{ fontSize: 9, color: 'var(--muted)' }}>{fmtDT(Date.now())}</span>
          </div>
        </div>
        <div style={{ fontSize: 10, color: 'var(--muted)', textAlign: 'center', padding: '0 12px 4px', lineHeight: 1.5 }}>
          The original fail record stays on the inspection and still counts in first-pass metrics.
        </div>
      </div>
      <div className="screen-footer">
        {warnParts.length > 0 && <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--red)', textAlign: 'center', marginBottom: 7 }}>● {warnParts.join(' · ')}</div>}
        <div className={'btn' + (canCommit ? (refails ? ' btn-red' : ' btn-green') : ' disabled')} onClick={() => canCommit && onCommit()}>
          {commitLabel}
        </div>
      </div>
    </div>
  );
}
