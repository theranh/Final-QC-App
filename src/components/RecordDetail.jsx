import { CATS, catByKey, chipStyle } from '../lib/constants';
import { fmtDT } from '../lib/format';
import { statusMeta } from '../lib/records';

export default function RecordDetail({ record: r, onBack, onStartRecheck, onOpenLightbox }) {
  const sm = statusMeta(r);
  const catRows = CATS.map((c) => {
    const arr = r.items[c.k] || [];
    const f = arr.filter((i) => i.mark === 'f').length;
    const na = arr.every((i) => i.mark === 'n');
    const marked = arr.filter((i) => i.mark !== 'n').length;
    return {
      label: c.label,
      mark: na ? '—' : f ? '✕' : '✓',
      bg: na ? 'var(--muted)' : f ? 'var(--red)' : 'var(--green)',
      note: na ? ((r.optOut && r.optOut[c.k]) ? 'N/A · not on unit' : 'N/A') : f ? `${f} fail${f === 1 ? '' : 's'}` : `${marked} / ${marked} pass`,
      noteColor: f ? 'var(--red)' : 'var(--muted)',
    };
  });

  const fails = [];
  CATS.forEach((c) => {
    (r.items[c.k] || []).forEach((it) => {
      if (it.mark === 'f') {
        fails.push({ chipLabel: c.seg, chipKey: c.k, item: it.item, note: it.note || '—', photos: it.photos || [] });
      }
    });
  });

  const rechecks = (r.rechecks || []).map((cy, ci) => {
    const anyFail = cy.items.some((x) => x.outcome === 'fail');
    return {
      title: `RE-CHECK ${ci + 1} OF ${r.rechecks.length}`,
      badge: anyFail ? 'FAILED AGAIN' : 'CLEARED ✓',
      bg: anyFail ? 'var(--red)' : 'var(--green)',
      meta: `${fmtDT(cy.ts)} · ${cy.inspector} — ${cy.title} · signature-locked`,
      items: cy.items,
      hasSig: !!cy.sig,
      sigSrc: cy.sig || '',
    };
  });

  const banner =
    r.status === 'open'
      ? { title: 'FAIL — OPEN RE-CHECK', sub: `${(r.openItems || []).length} item${(r.openItems || []).length === 1 ? '' : 's'} awaiting re-check`, bg: 'var(--amber)', mark: '✕' }
      : r.status === 'cleared'
      ? { title: 'PASS ON RE-CHECK', sub: `Failed first inspection · cleared ${fmtDT(r.clearedTs)}`, bg: 'var(--green)', mark: '✓' }
      : { title: 'PASS — ALL CATEGORIES', sub: 'First-pass · clean', bg: 'var(--green)', mark: '✓' };

  const meta = [
    { k: 'VIN — PRIMARY ID', v: r.vin || '—' },
    { k: 'STOCK #', v: r.stock },
    { k: 'VEHICLE', v: r.vehicle },
    { k: 'STATUS', v: sm.txt },
    { k: 'INSPECTOR', v: `${r.inspector} — ${r.title}` },
    { k: 'ITEMS CHECKED', v: String(r.checked) },
  ];

  return (
    <div className="screen">
      <div className="screen-topbar" style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 9 }}>
        <span className="icon-btn" onClick={onBack}>‹</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="oswald" style={{ fontWeight: 600, fontSize: 15 }}>{r.id}</div>
          <div className="mono" style={{ fontSize: 9, color: 'var(--muted)', marginTop: 1 }}>{fmtDT(r.ts)}</div>
        </div>
        <span style={{ fontSize: 8.5, fontWeight: 700, color: '#fff', background: '#4A4540', padding: '3px 8px', borderRadius: 5, flex: '0 0 auto' }}>LOCKED</span>
      </div>
      <div className="screen-body" style={{ padding: '12px 14px 16px', gap: 10 }}>
        <div className="result-banner" style={{ background: banner.bg }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="mark">{banner.mark}</span>
            <div>
              <div className="title">{banner.title}</div>
              <div className="sub">{r.stock} · {r.vehicle} — {banner.sub}</div>
            </div>
          </div>
        </div>

        <div className="card" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '9px 10px' }}>
          {meta.map((m) => (
            <div key={m.k}>
              <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: 0.5, color: 'var(--muted)' }}>{m.k}</div>
              <div style={{ fontSize: 11.5, fontWeight: 600, marginTop: 2 }}>{m.v}</div>
            </div>
          ))}
        </div>

        {r.vinPhoto && (
          <div className="card">
            <div className="card-title">PROOF OF UNIT — VIN LABEL PHOTO</div>
            <div style={{ display: 'flex', gap: 9, marginTop: 8, alignItems: 'center' }}>
              <div className="photo-thumb" style={{ width: 110, height: 80, backgroundImage: `url('${r.vinPhoto}')` }} onClick={() => onOpenLightbox(r.vinPhoto)} />
              <div className="mono" style={{ fontSize: 11, color: 'var(--ink)', wordBreak: 'break-all', lineHeight: 1.5 }}>{r.vin || '—'}</div>
            </div>
          </div>
        )}

        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', fontSize: 9.5, fontWeight: 700, letterSpacing: 0.8, color: 'var(--muted)' }}>ORIGINAL INSPECTION — BY CATEGORY</div>
          {catRows.map((c, i) => (
            <div key={i} className="card-row">
              <span style={{ width: 20, height: 20, borderRadius: 6, background: c.bg, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700 }}>{c.mark}</span>
              <span style={{ fontSize: 12.5, fontWeight: 600, flex: 1 }}>{c.label}</span>
              <span style={{ fontSize: 10, fontWeight: 700, color: c.noteColor }}>{c.note}</span>
            </div>
          ))}
        </div>

        {fails.length > 0 && (
          <div className="card" style={{ border: '1.5px solid var(--red)' }}>
            <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 0.8, color: 'var(--red)' }}>FAILED ITEMS — ORIGINAL INSPECTION</div>
            {fails.map((f, i) => (
              <div key={i} style={{ marginTop: 10, paddingTop: 10, borderTop: '1px dashed var(--border2)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={chipStyle(f.chipKey)}>{f.chipLabel}</span>
                  <span style={{ fontSize: 12.5, fontWeight: 700, flex: 1 }}>{f.item}</span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--brown)', marginTop: 5, lineHeight: 1.5 }}>&ldquo;{f.note}&rdquo;</div>
                {f.photos.length > 0 && (
                  <div style={{ display: 'flex', gap: 7, marginTop: 7, flexWrap: 'wrap' }}>
                    {f.photos.map((src, pi) => (
                      <div key={pi} className="photo-thumb" style={{ width: 96, height: 74, backgroundImage: `url('${src}')` }} onClick={() => onOpenLightbox(src)} />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {r.status === 'open' && (
          <div style={{ background: '#FBF3E4', border: '1.5px solid var(--amber)', borderRadius: 12, padding: '11px 12px' }}>
            <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 0.8, color: 'var(--amber)' }}>OPEN — AWAITING RE-CHECK</div>
            <div style={{ fontSize: 11, color: '#6E5A32', marginTop: 5, lineHeight: 1.5 }}>
              {(r.openItems || []).map((x) => `${catByKey(x.cat).label} — ${x.item}`).join(' · ')}
            </div>
            <div style={{ marginTop: 9, height: 48, borderRadius: 10, background: 'var(--amber)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, cursor: 'pointer' }} onClick={() => onStartRecheck(r.id)}>
              Start re-check
            </div>
          </div>
        )}

        {rechecks.map((rk, ri) => (
          <div key={ri} className="card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 0.8, color: 'var(--muted)', flex: 1 }}>{rk.title}</span>
              <span style={{ fontSize: 8.5, fontWeight: 700, color: '#fff', background: rk.bg, padding: '2px 7px', borderRadius: 4 }}>{rk.badge}</span>
            </div>
            <div className="mono" style={{ fontSize: 9, color: 'var(--muted)', marginTop: 3 }}>{rk.meta}</div>
            {rk.items.map((ki, ki_i) => (
              <div key={ki_i} style={{ marginTop: 9, paddingTop: 9, borderTop: '1px dashed var(--border2)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={chipStyle(ki.cat)}>{catByKey(ki.cat).seg}</span>
                  <span style={{ fontSize: 12, fontWeight: 700, flex: 1 }}>{ki.item}</span>
                  <span style={{ fontSize: 8.5, fontWeight: 700, color: '#fff', background: ki.outcome === 'fail' ? 'var(--red)' : 'var(--green)', padding: '2px 7px', borderRadius: 4 }}>
                    {ki.outcome === 'fail' ? 'FAIL AGAIN' : 'CLEARED ✓'}
                  </span>
                </div>
                {ki.repairedBy && <div className="mono" style={{ fontSize: 9, color: 'var(--muted)', marginTop: 4 }}>repaired: {ki.repairedBy}</div>}
                {ki.note && <div style={{ fontSize: 11, color: 'var(--brown)', marginTop: 4, lineHeight: 1.5 }}>&ldquo;{ki.note}&rdquo;</div>}
                {(ki.photos || []).length > 0 && (
                  <div style={{ display: 'flex', gap: 7, marginTop: 6, flexWrap: 'wrap' }}>
                    {ki.photos.map((src, pi) => (
                      <div key={pi} className="photo-thumb" style={{ width: 96, height: 74, backgroundImage: `url('${src}')` }} onClick={() => onOpenLightbox(src)} />
                    ))}
                  </div>
                )}
              </div>
            ))}
            {rk.hasSig && <div style={{ width: '100%', maxWidth: 260, height: 70, marginTop: 9, border: '1px solid var(--border2)', borderRadius: 8, background: `#FDFCFB url('${rk.sigSrc}') no-repeat left center`, backgroundSize: 'contain' }} />}
          </div>
        ))}

        {r.sig && (
          <div className="card">
            <div className="card-title">ORIGINAL SIGNATURE — LOCKED AT COMMIT</div>
            <div style={{ width: '100%', maxWidth: 300, height: 90, marginTop: 6, border: '1px solid var(--border2)', borderRadius: 8, background: `#FDFCFB url('${r.sig}') no-repeat left center`, backgroundSize: 'contain' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 7 }} className="mono">
              <span style={{ fontSize: 9, color: 'var(--muted)' }}>{r.inspector} — {r.title}</span>
              <span style={{ fontSize: 9, color: 'var(--muted)' }}>{fmtDT(r.ts)}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
