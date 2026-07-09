import { CATS } from './constants';
import { csvEsc, download, fmtDT, fileStamp } from './format';
import { failList, statusMeta, recheckDatesLabel } from './records';
import { computeStats } from './stats';

export function exportCsv(allRecs, period) {
  if (!period.recs.length) return false;
  const st = computeStats(allRecs, period);
  const esc = csvEsc;
  const L = [];
  L.push('TRUCK RANCH — FINAL QC REPORT');
  L.push('Period,' + esc(period.label) + ',' + esc(period.rangeLabel));
  L.push('Generated,' + esc(fmtDT(Date.now())));
  L.push('');
  L.push('Total inspections,' + st.total);
  L.push('Pass (first-pass),' + st.pass);
  L.push('Fail (first inspection),' + st.fail);
  L.push('Final QC Rate (first-pass),' + (st.rate == null ? '' : st.rate + '%'));
  L.push('Open re-checks (current),' + st.openNow);
  L.push('Re-checks cleared in period,' + st.cleared);
  L.push('Avg fail to cleared,' + (st.avgClear == null ? '' : st.avgClear + ' days'));
  L.push('');
  L.push('Fails by type (failed items, first inspection)');
  CATS.forEach((c) => L.push(esc(c.label) + ',' + (st.catFails[c.k] || 0)));
  L.push('');
  L.push('Most-failed items');
  st.top.forEach((t) => L.push(esc(t.cat + ' — ' + t.item) + ',' + t.count));
  L.push('');
  L.push('By inspector');
  st.insp.forEach((r) => L.push(esc(r.name + ' (' + r.title + ')') + ',' + r.total + ' inspections,' + r.fails + ' failed first-pass'));
  L.push('');
  L.push(['ID', 'Date', 'VIN', 'Stock #', 'Vehicle', 'Inspector', 'Title', 'Status', 'Items checked', 'Failed items', 'Re-check dates'].map(esc).join(','));
  period.recs
    .slice()
    .sort((a, b) => a.ts - b.ts)
    .forEach((r) => {
      const fails = failList(r, CATS)
        .map((f) => f.catLabel + ': ' + f.item + (f.note ? ' (' + f.note + ')' : ''))
        .join('; ');
      L.push(
        [r.id, fmtDT(r.ts), r.vin || '', r.stock, r.vehicle, r.inspector, r.title, statusMeta(r).txt, r.checked, fails, recheckDatesLabel(r, fmtDT)]
          .map(esc)
          .join(',')
      );
    });
  download('TruckRanch_FinalQC_' + period.file + '.csv', '﻿' + L.join('\r\n'), 'text/csv;charset=utf-8');
  return true;
}

export function exportBackup(users, recs, seq, defaultUid) {
  download(
    'TruckRanch_FinalQC_backup_' + fileStamp() + '.json',
    JSON.stringify({ app: 'TruckRanch Final QC', exportedAt: new Date().toISOString(), users, inspections: recs, seq, defaultUid }),
    'application/json'
  );
}

export function parseBackupFile(file) {
  return new Promise((resolve, reject) => {
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const data = JSON.parse(rd.result);
        if (!data || !Array.isArray(data.inspections) || !Array.isArray(data.users)) throw new Error('bad');
        resolve(data);
      } catch {
        reject(new Error('Invalid backup file'));
      }
    };
    rd.onerror = () => reject(new Error('Could not read that file'));
    rd.readAsText(file);
  });
}
