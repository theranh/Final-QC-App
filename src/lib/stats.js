import { CATS, catByKey, WEEK_STARTS_ON } from './constants';
import { fmtD, fileStamp } from './format';

export function periodDefs(allRecs) {
  const now = new Date();
  const ws = WEEK_STARTS_ON === 'Sunday' ? 0 : 1;
  const diff = (now.getDay() - ws + 7) % 7;
  const wStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff).getTime();
  const mStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const defs = [
    { k: 'wtd', label: 'Week to date', start: wStart, end: Infinity, file: 'WTD_' + fileStamp() },
    { k: 'mtd', label: 'Month to date', start: mStart, end: Infinity, file: 'MTD_' + fileStamp() },
  ];
  const monthKeys = {};
  const addTs = (ts) => {
    if (!ts) return;
    const dd = new Date(ts);
    monthKeys[dd.getFullYear() + '-' + dd.getMonth()] = true;
  };
  allRecs.forEach((r) => {
    addTs(r.ts);
    addTs(r.clearedTs);
    (r.rechecks || []).forEach((c) => addTs(c.ts));
  });
  const curKey = now.getFullYear() + '-' + now.getMonth();
  const months = Object.keys(monthKeys)
    .filter((k) => k !== curKey)
    .map((k) => {
      const [y, m] = k.split('-').map(Number);
      return new Date(y, m, 1);
    })
    .filter((dm) => dm < new Date(now.getFullYear(), now.getMonth(), 1))
    .sort((a, b) => b - a);
  months.forEach((cur) => {
    const nxt = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
    const lab = cur.toLocaleString('en-US', { month: 'long', year: 'numeric' });
    defs.push({ k: 'm' + cur.getFullYear() + '-' + cur.getMonth(), label: lab, start: cur.getTime(), end: nxt.getTime(), file: lab.replace(' ', '_') });
  });
  return defs;
}

export function curPeriod(allRecs, periodKey) {
  const defs = periodDefs(allRecs);
  const d = defs.find((x) => x.k === periodKey) || defs[1];
  const recs = allRecs.filter((r) => r.ts >= d.start && r.ts < d.end);
  const rangeLabel = fmtD(d.start) + ' – ' + (d.end === Infinity ? 'today' : fmtD(d.end - 1));
  return { ...d, recs, rangeLabel };
}

export function computeStats(allRecs, period) {
  const recs = period.recs;
  const total = recs.length;
  const pass = recs.filter((r) => r.result === 'pass').length;
  const fail = total - pass;
  const rate = total ? Math.round((pass / total) * 1000) / 10 : null;
  const catFails = {};
  const itemFails = {};
  const byInsp = {};
  recs.forEach((r) => {
    const key = r.inspector + ' — ' + r.title;
    byInsp[key] = byInsp[key] || { name: r.inspector, title: r.title, total: 0, fails: 0 };
    byInsp[key].total++;
    if (r.result === 'fail') byInsp[key].fails++;
    CATS.forEach((c) => {
      (r.items[c.k] || []).forEach((it) => {
        if (it.mark === 'f') {
          catFails[c.k] = (catFails[c.k] || 0) + 1;
          const ik = c.k + '|' + it.item;
          itemFails[ik] = (itemFails[ik] || 0) + 1;
        }
      });
    });
  });
  const top = Object.keys(itemFails)
    .map((k) => {
      const [ck, item] = k.split('|');
      return { k: ck, seg: catByKey(ck).seg, cat: catByKey(ck).label, item, count: itemFails[k] };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);
  const insp = Object.values(byInsp).sort((a, b) => b.total - a.total);
  const openNow = allRecs.filter((r) => r.status === 'open').length;
  const clearedRecs = allRecs.filter((r) => r.status === 'cleared' && r.clearedTs >= period.start && r.clearedTs < (period.end === Infinity ? Date.now() + 1 : period.end));
  const cleared = clearedRecs.length;
  let avgClear = null;
  if (cleared) {
    const sum = clearedRecs.reduce((a, r) => a + (r.clearedTs - r.ts), 0);
    avgClear = Math.round((sum / cleared / 86400000) * 10) / 10;
  }
  return { total, pass, fail, rate, catFails, top, insp, openNow, cleared, avgClear };
}
