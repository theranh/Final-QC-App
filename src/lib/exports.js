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

// Download a server-generated backup payload (authoritative database export).
export function downloadServerBackup(backup) {
  download('TruckRanch_FinalQC_backup_' + fileStamp() + '.json', JSON.stringify(backup), 'application/json');
}

export function parseBackupFile(file) {
  return new Promise((resolve, reject) => {
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const data = JSON.parse(rd.result);
        if (isOldReconRecord(data && data[0]) || isOldReconRecord(data && data.inspections && data.inspections[0])) {
          resolve({ oldRecon: true, records: Array.isArray(data) ? data : data.inspections });
          return;
        }
        // Accept both server backups (employees array) and older on-device
        // backups (users array) — inspections are required either way.
        if (!data || !Array.isArray(data.inspections) || !(Array.isArray(data.users) || Array.isArray(data.employees))) throw new Error('bad');
        resolve(data);
      } catch {
        reject(new Error('Invalid backup file'));
      }
    };
    rd.onerror = () => reject(new Error('Could not read that file'));
    rd.readAsText(file);
  });
}

// ---------- old "Truck Recon Checklist" app (truck-recon-checklist Repl) ----------
// That app stored records on-device as an array of:
//   { id, stockNumber, mileage, truckInfo:{year,make,model,vin}, inspector, notes,
//     status: 'in-progress'|'passed'|'failed', createdAt, completedAt,
//     checklist: [{ category, label, checked, failed, deferred, note, photos }] }

function isOldReconRecord(r) {
  return !!(r && typeof r === 'object' && r.truckInfo && Array.isArray(r.checklist));
}

// Old category names -> this app's category keys. Anything unrecognized lands in
// Mechanical so no failed item is ever dropped from the record.
function oldCatToKey(cat) {
  const c = String(cat || '').toLowerCase();
  if (/cosm|paint|body|exterior|glass/.test(c)) return 'cosm';
  if (/detail|interior|odor|clean/.test(c)) return 'detail';
  if (/bed/.test(c)) return 'bed';
  if (/ceramic|coat/.test(c)) return 'ceramic';
  if (/under/.test(c)) return 'under';
  return 'mech'; // Mechanical, Electrical, Road Test, etc.
}

const isPortablePhoto = (p) => typeof p === 'string' && p.startsWith('data:') && p.length <= 2_000_000;

// Convert old-app records into this app's import payload. Only completed
// inspections with a usable date are converted (in-progress drafts have nothing
// final to record). FQ numbers are NOT assigned here — the server allocates them
// atomically on import so they can never collide with other inspections.
export function convertOldReconBackup(records) {
  const usableTs = (r) => new Date(r.completedAt || r.createdAt || NaN).getTime();
  const done = records
    .filter((r) => isOldReconRecord(r) && (r.status === 'passed' || r.status === 'failed') && Number.isFinite(usableTs(r)) && usableTs(r) > 0)
    .sort((a, b) => usableTs(a) - usableTs(b));
  const skipped = records.length - done.length;
  const inspections = done.map((r) => {
    const items = { mech: [], cosm: [], detail: [], bed: [], ceramic: [], under: [] };
    let checked = 0;
    let failCount = 0;
    (r.checklist || []).forEach((ci) => {
      const mark = ci.failed ? 'f' : ci.checked ? 'p' : 'n';
      if (mark !== 'n') checked++;
      const it = { item: ci.label || 'Item', mark };
      if (mark === 'f') {
        failCount++;
        it.note = (ci.note || '').trim();
        it.photos = (ci.photos || []).filter(isPortablePhoto).slice(0, 12);
      }
      items[oldCatToKey(ci.category)].push(it);
    });
    const t = r.truckInfo || {};
    const failed = r.status === 'failed';
    return {
      ts: usableTs(r),
      stock: String(r.stockNumber || '').trim(),
      vehicle: [t.year, t.make, t.model].filter(Boolean).join(' '),
      vin: String(t.vin || '').trim().toUpperCase().slice(0, 17),
      result: failed ? 'fail' : 'pass',
      status: failed ? 'open' : 'pass',
      items,
      checked,
      failCount,
      optOut: {},
      sig: null,
      inspector: r.inspector || '',
      generalNote: (r.notes || '').trim() || undefined,
      mileage: r.mileage || undefined,
      legacyApp: 'truck-recon-checklist',
    };
  });
  return { inspections, skippedInProgress: skipped };
}
