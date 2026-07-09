// Thin fetch wrapper for the Final QC API. All requests ride the session cookie.

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    credentials: 'include',
    headers: body != null ? { 'Content-Type': 'application/json' } : undefined,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    const err = new Error('Signed out');
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
    const err = new Error((data && data.message) || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  me: () => request('GET', '/api/me'),
  bootstrap: () => request('GET', '/api/bootstrap'),
  createInspection: (payload) => request('POST', '/api/inspections', payload),
  commitRecheck: (qc, payload) => request('POST', `/api/inspections/${encodeURIComponent(qc)}/recheck`, payload),
  importLegacy: (payload) => request('POST', '/api/import', payload),
  employees: () => request('GET', '/api/employees'),
  addEmployee: (payload) => request('POST', '/api/employees', payload),
  updateEmployee: (id, patch) => request('PATCH', `/api/employees/${id}`, patch),
};
