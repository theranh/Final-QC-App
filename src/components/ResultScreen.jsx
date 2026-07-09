import { CATS, CHECKLIST, catByKey } from '../lib/constants';
import { fmtDT } from '../lib/format';
import SignaturePad from './SignaturePad';

export default function ResultScreen({ draft, insp, marks, optOut, seq, sigRef, sigSigned, onSigChange, onClearSig, onBack, onCommit }) {
  const fails = [];
  CATS.forEach((c) => {
    if (!optOut[c.k]) {
      CHECKLIST[c.k].forEach((item, i) => {
        if (marks[c.k + '|' + i] === 'f') fails.push({ cat: c.k, item });
      });
    }
  });
  const failCats = [...new Set(fails.map((f) => f.cat))];

  const catRows = CATS.map((c) => {
    if (optOut[c.k]) return { label: c.label, mark: '—', bg: 'var(--muted)', note: 'N/A · not on this unit', noteColor: 'var(--muted)' };
    const items = CHECKLIST[c.k];
    const f = items.filter((x, j) => marks[c.k + '|' + j] === 'f').length;
    const na = items.every((x, j) => marks[c.k + '|' + j] === 'n');
    const marked = items.filter((x, j) => marks[c.k + '|' + j] && marks[c.k + '|' + j] !== 'n').length;
    return {
      label: c.label,
      mark: na ? '—' : f ? '✕' : '✓',
      bg: na ? 'var(--muted)' : f ? 'var(--red)' : 'var(--green)',
      note: na ? 'N/A' : f ? `${f} fail${f === 1 ? '' : 's'}` : `${marked} / ${marked} pass`,
      noteColor: f ? 'var(--red)' : 'var(--muted)',
    };
  });

  const hasFails = fails.length > 0;
  const bannerBg = hasFails ? 'var(--red)' : 'var(--green)';
  const commitReady = sigSigned;
  const commitLabel = commitReady ? (hasFails ? 'Commit — open re-check' : 'Commit — lock inspection') : 'Sign above to commit';

  return (
    <div className="screen">
      <div className="screen-body" style={{ padding: '12px 14px', gap: 10 }}>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, color: 'var(--muted)' }}>
          INSPECTION RESULT · {draft.stock.trim()} · FQ-{seq}
        </div>
        <div className="result-banner" style={{ background: bannerBg }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="mark">{hasFails ? '✕' : '✓'}</span>
            <div>
              <div className="title">{hasFails ? `FAIL — ${fails.length} ITEM${fails.length === 1 ? '' : 'S'}` : 'PASS — ALL CATEGORIES'}</div>
              <div className="sub">{hasFails ? 'Opens a re-check — failed items must be cleared before this unit passes' : 'First-pass — counts toward the Final QC Rate'}</div>
            </div>
          </div>
        </div>
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', fontSize: 9.5, fontWeight: 700, letterSpacing: 0.8, color: 'var(--muted)' }}>RESULT BY CATEGORY</div>
          {catRows.map((c, i) => (
            <div key={i} className="card-row">
              <span style={{ width: 20, height: 20, borderRadius: 6, background: c.bg, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700 }}>{c.mark}</span>
              <span style={{ fontSize: 12.5, fontWeight: 600, flex: 1 }}>{c.label}</span>
              <span style={{ fontSize: 10, fontWeight: 700, color: c.noteColor }}>{c.note}</span>
            </div>
          ))}
        </div>
        {hasFails && (
          <div style={{ background: '#FBF3E4', border: '1px solid #E7D9BC', borderRadius: 10, padding: '9px 12px', fontSize: 10.5, color: '#6E5A32', lineHeight: 1.5 }}>
            {fails.length} fail record{fails.length === 1 ? '' : 's'} ({failCats.map((k) => catByKey(k).label).join(', ')}) locks on this inspection, counts in first-pass metrics, and opens a re-check on the Inspect screen.
          </div>
        )}
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <div className="card-title" style={{ flex: 1 }}>INSPECTOR SIGNATURE — LOCKS INSPECTION</div>
            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--red)', cursor: 'pointer', padding: 6 }} onClick={onClearSig}>Clear</div>
          </div>
          <SignaturePad ref={sigRef} onSignedChange={onSigChange} />
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 7 }} className="mono">
            <span style={{ fontSize: 9, color: 'var(--muted)' }}>{insp.name} — {insp.title}</span>
            <span style={{ fontSize: 9, color: 'var(--muted)' }}>{fmtDT(Date.now())}</span>
          </div>
        </div>
      </div>
      <div className="screen-footer" style={{ display: 'flex', gap: 8 }}>
        <div className="btn btn-outline" style={{ flex: '0 0 auto', width: 'auto', padding: '0 15px', height: 50 }} onClick={onBack}>Back</div>
        <div
          className={'btn' + (commitReady ? (hasFails ? ' btn-red' : ' btn-green') : ' disabled')}
          style={{ flex: 1, height: 50, fontSize: 13.5 }}
          onClick={() => commitReady && onCommit()}
        >
          {commitLabel}
        </div>
      </div>
    </div>
  );
}
