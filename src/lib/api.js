// Thin fetch wrapper for the Final QC API. All requests ride the session cookie.

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    credentials: 'include',
    headers: body != null ? { 'Content-Type': 'application/json' } : undefined,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    // Session expired (common on a phone PWA left open for weeks). Tell the
    // app shell so it can swap to the sign-in screen instead of leaving dead
    // buttons behind.
    try { window.dispatchEvent(new Event('auth:expired')); } catch { /* SSR/test */ }
    const err = new Error('Signed out — please sign in again');
    err.status = 401;
    throw err;
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON response */
  }
  if (!res.ok) {
    const err = new Error((data && (data.message || data.error)) || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  me: () => request('GET', '/api/me'),
  bootstrap: () => request('GET', '/api/bootstrap'),
  dashboard: (from, to) =>
    request('GET', '/api/dashboard' + (from && to ? `?from=${from}&to=${to}` : '')),
  intakeByVin: (vin) => request('GET', `/api/intake/${encodeURIComponent(vin)}`),
  getIntake: (vin) => request('GET', `/api/quoter/intakes?vin=${encodeURIComponent(vin)}`),
  listIntakes: () => request('GET', '/api/quoter/intakes'),
  putIntake: (payload) => request('PUT', '/api/quoter/intakes', payload),
  linkIntakeQuote: (id, quoteId) => request('POST', `/api/quoter/intakes/${encodeURIComponent(id)}/link-quote`, { quoteId }),
  createInspection: (payload) => request('POST', '/api/inspections', payload),
  commitRecheck: (qc, payload) => request('POST', `/api/inspections/${encodeURIComponent(qc)}/recheck`, payload),
  importLegacy: (payload) => request('POST', '/api/import', payload),
  exportBackup: () => request('GET', '/api/export'),
  backupStatus: () => request('GET', '/api/backup-status'),
  employees: () => request('GET', '/api/employees'),
  repairImportedRechecks: () => request('POST', '/api/admin/repair-imported-rechecks'),
  archiveImported: () => request('POST', '/api/admin/archive-imported'),
  setArchived: (qcNumber, archived) => request('POST', '/api/admin/archive', { qcNumber, archived }),
  unlockQuotes: () => request('POST', '/api/admin/unlock-quotes'),
  addEmployee: (payload) => request('POST', '/api/employees', payload),
  updateEmployee: (id, patch) => request('PATCH', `/api/employees/${id}`, patch),
  setEmployeePin: (id, pin) => request('POST', `/api/employees/${id}/pin`, { pin }),

  // ---------- Production Tracker snapshots (admin) ----------
  trackerSnapshots: () => request('GET', '/api/tracker/snapshots'),
  snapshotTrackerMonth: (month) => request('POST', '/api/tracker/snapshot', { month }),

  // ---------- Body Quoter ----------
  quoterSync: () => request('GET', '/api/quoter/sync'),
  putQuote: (payload) => request('PUT', '/api/quoter/quotes', payload),
  patchQuoteNotes: (payload) => request('PATCH', '/api/quoter/quotes/notes', payload),
  deleteQuote: (id) => request('DELETE', `/api/quoter/quotes?id=${encodeURIComponent(id)}`),
  putQuotePhoto: (payload) => request('POST', '/api/quoter/photos', payload),
  quotePhotos: (quoteId) => request('GET', `/api/quoter/photos?quote=${encodeURIComponent(quoteId)}`),
  deleteQuotePhoto: (payload) => request('DELETE', '/api/quoter/photos', payload),
  postCorrection: (payload) => request('POST', '/api/quoter/corrections', payload),
  classify: (payload) => request('POST', '/api/quoter/classify', payload),

  photoOrientationCandidates: (quoteId) => request('GET', `/api/admin/photo-orientation-candidates?quoteId=${encodeURIComponent(quoteId)}`),
  photoOrientationScanAll: (offset) => request('GET', `/api/admin/photo-orientation-scan-all?offset=${offset}`),

  // ---------- PIN sign-off ----------
  signers: () => request('GET', '/api/quoter/signers'),
  commitIntake: (payload) => request('POST', '/api/quoter/commit-intake', payload),
  commitQuote: (payload) => request('POST', '/api/quoter/commit-quote', payload),
};
