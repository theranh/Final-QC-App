import { catByKey } from './constants';

export function statusMeta(r) {
  if (r.status === 'open') return { label: 'OPEN RE-CHECK', bg: '#B07A1E', txt: 'Fail — open re-check' };
  if (r.status === 'cleared') return { label: 'PASS · RE-CHECK', bg: '#2F7D4F', txt: 'Pass on re-check' };
  return { label: 'PASS', bg: '#2F7D4F', txt: 'Pass' };
}

export function failList(r, cats) {
  const out = [];
  cats.forEach((c) => {
    (r.items[c.k] || []).forEach((it) => {
      if (it.mark === 'f') {
        out.push({ catLabel: catByKey(c.k).label, seg: c.seg, k: c.k, item: it.item, note: it.note || '', photos: it.photos || [] });
      }
    });
  });
  return out;
}

export function recheckDatesLabel(r, fmtDT) {
  return (r.rechecks || []).map((c) => fmtDT(c.ts)).join('; ');
}

export function filterRecords(recs, { q, fRes, fFrom, fTo }) {
  const query = (q || '').trim().toLowerCase();
  return recs.filter((r) => {
    if (query && !`${r.stock} ${r.vehicle} ${r.vin || ''} ${r.inspector} ${r.id}`.toLowerCase().includes(query)) return false;
    if (fRes === 'pass' && r.status === 'open') return false;
    if (fRes === 'fail' && r.status !== 'open') return false;
    if (fFrom) {
      const t = new Date(fFrom + 'T00:00:00').getTime();
      if (r.ts < t) return false;
    }
    if (fTo) {
      const t = new Date(fTo + 'T23:59:59').getTime();
      if (r.ts > t) return false;
    }
    return true;
  });
}
