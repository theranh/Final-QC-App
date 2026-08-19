import { CATS, CHECKLIST, REQUIRE_PHOTO_ON_FAIL, chipStyle } from '../lib/constants';
import PhotoRow from './PhotoRow';
import VoiceNoteButton from './VoiceNoteButton';

export default function ChecklistSheet({ draft, insp, marks, notes, photosMap, optOut, onMark, onNote, onTakePhoto, onRemovePhoto, onClose, onFinish }) {
  let answered = 0, total = 0, failCount = 0, noteMissing = 0, photoMissing = 0;

  const sections = CATS.map((c) => {
    const skipped = !!optOut[c.k];
    const items = skipped
      ? []
      : CHECKLIST[c.k].map((item, i) => {
          const key = c.k + '|' + i;
          const mk = marks[key];
          total++;
          if (mk) answered++;
          const isF = mk === 'f';
          const note = notes[key] || '';
          const phs = photosMap[key] || [];
          let needLabel = '';
          if (isF) {
            failCount++;
            const needN = !note.trim();
            const needP = REQUIRE_PHOTO_ON_FAIL && !phs.length;
            if (needN) noteMissing++;
            if (needP) photoMissing++;
            if (needN && needP) needLabel = 'Fail note + photo required';
            else if (needN) needLabel = 'Fail note required';
            else if (needP) needLabel = 'Photo required to save a Fail';
          }
          return { key, item, isF, mk, note, phs, needLabel };
        });
    return { c, skipped, items };
  });

  const segs = CATS.map((c) => {
    if (optOut[c.k]) return { label: c.seg, bar: '#D6CFC7', color: 'var(--muted2)' };
    const done = CHECKLIST[c.k].every((x, j) => marks[c.k + '|' + j]);
    const anyF = CHECKLIST[c.k].some((x, j) => marks[c.k + '|' + j] === 'f');
    return { label: c.seg, bar: done ? (anyF ? 'var(--red)' : 'var(--green)') : 'var(--border)', color: done ? (anyF ? 'var(--red)' : 'var(--green)') : 'var(--muted)' };
  });

  const ready = answered === total && noteMissing === 0 && photoMissing === 0;
  const warnParts = [];
  if (noteMissing) warnParts.push(`${noteMissing} fail${noteMissing === 1 ? '' : 's'} missing a note`);
  if (photoMissing) warnParts.push(`${photoMissing} missing the required photo`);

  const finishLabel = ready
    ? failCount ? `Review Result → ${failCount} fail${failCount === 1 ? '' : 's'}` : 'Review Result → all pass'
    : answered < total
    ? `Answer all items (${total - answered} left)`
    : noteMissing && photoMissing
    ? 'Add fail notes & photos to finish'
    : noteMissing
    ? `Add fail note${noteMissing === 1 ? '' : 's'} to finish`
    : `Add fail photo${photoMissing === 1 ? '' : 's'} to finish`;

  return (
    <div className="screen">
      <div className="screen-topbar" style={{ padding: '10px 14px 10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <span className="icon-btn" onClick={onClose}>‹</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="oswald" style={{ fontWeight: 600, fontSize: 14.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {draft.stock.trim()} · {draft.vehicle.trim()}
            </div>
            <div className="mono" style={{ fontSize: 9, color: 'var(--muted)', marginTop: 1 }}>
              {draft.vin ? `VIN …${draft.vin.toUpperCase().slice(-8)} · ` : ''}{insp.name} — {insp.title}
            </div>
          </div>
          <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--muted)', flex: '0 0 auto' }}>{answered} / {total}</span>
        </div>
        <div style={{ display: 'flex', gap: 4, marginTop: 9 }}>
          {segs.map((sg, i) => (
            <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'center' }}>
              <span style={{ width: '100%', height: 5, borderRadius: 3, background: sg.bar }} />
              <span style={{ fontSize: 8, fontWeight: 700, color: sg.color }}>{sg.label}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="screen-body" style={{ padding: '10px 13px 14px', gap: 0 }}>
        {sections.map(({ c, skipped, items }) => (
          <div key={c.k}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 2px 7px' }}>
              <span style={chipStyle(c.k)}>{c.seg}</span>
              <span className="oswald" style={{ fontWeight: 600, fontSize: 15 }}>{c.label}</span>
              <span style={{ flex: 1 }} />
              {skipped && <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--muted)' }}>NOT ON THIS UNIT · ALL N/A</span>}
            </div>
            {items.map(({ key, item, isF, mk, note, phs, needLabel }) => (
              <div key={key} style={{ background: '#fff', border: isF ? '1.5px solid var(--red)' : '1px solid var(--border)', borderRadius: 10, padding: '9px 11px', marginBottom: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, flex: 1, minWidth: 0 }}>{item}</span>
                  <div className="seg-btn pf" style={{ background: mk === 'p' ? 'var(--green)' : '#fff', color: mk === 'p' ? '#fff' : 'var(--muted)', borderColor: mk === 'p' ? 'var(--green)' : 'var(--border)' }} onClick={() => onMark(key, 'p')}>Pass</div>
                  <div className="seg-btn pf" style={{ background: mk === 'f' ? 'var(--red)' : '#fff', color: mk === 'f' ? '#fff' : 'var(--muted)', borderColor: mk === 'f' ? 'var(--red)' : 'var(--border)' }} onClick={() => onMark(key, 'f')}>Fail</div>
                  <div className="seg-btn na" style={{ background: mk === 'n' ? 'var(--muted)' : '#fff', color: mk === 'n' ? '#fff' : 'var(--muted)', borderColor: mk === 'n' ? 'var(--muted)' : 'var(--border)' }} onClick={() => onMark(key, 'n')}>N/A</div>
                </div>
                {isF && (
                  <>
                    <div style={{ display: 'flex', gap: 7, marginTop: 9, alignItems: 'center', flexWrap: 'wrap' }}>
                      <PhotoRow photos={phs} onAdd={() => onTakePhoto(key)} onRemove={(idx) => onRemovePhoto(key, idx)} />
                      <input
                        className="input"
                        value={note}
                        onChange={(e) => onNote(key, e)}
                        placeholder="Fail note (required)…"
                        style={{ flex: 1, minWidth: 140, height: 44, fontSize: 12 }}
                      />
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
          </div>
        ))}
      </div>
      <div className="screen-footer">
        {warnParts.length > 0 && <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--red)', textAlign: 'center', marginBottom: 7 }}>● {warnParts.join(' · ')}</div>}
        <div
          className={'btn' + (ready ? (failCount ? ' btn-dark' : ' btn-green') : ' disabled')}
          onClick={() => ready && onFinish()}
        >
          {finishLabel}
        </div>
      </div>
    </div>
  );
}
