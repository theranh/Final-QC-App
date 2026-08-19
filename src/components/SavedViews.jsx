// Saved views (personal work queues / saved filters) for the Vehicles screen.
// Views are persisted through /api/collaboration/preferences so they survive
// device switches. Each view stores the bucket (filter), person, and query.
//
// Props:
//   bucket   string    — current filter value ('awaitingFinalQc' | 'completed')
//   person   string    — current person filter
//   q        string    — current search query
//   onApply  fn({bucket,person,q})  — called when a view is selected
//
// The default list behaviour (bucket/person/q props) is unchanged — this
// component only adds save / list / apply / delete on top.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

const BUCKET_LABEL = {
  awaitingFinalQc: 'In-Take Quotes',
  completed: "Completed QC's",
};

export default function SavedViews({ bucket, person, q, onApply }) {
  const [views, setViews] = useState(null);    // null = not loaded yet
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saveName, setSaveName] = useState('');
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [revision, setRevision] = useState(null);
  const inputRef = useRef(null);

  // Load preferences once on mount
  const loadViews = useCallback(() => {
    setLoading(true);
    setError(null);
    api.collabPreferences()
      .then((d) => {
        setViews(d.preferences?.savedViews || d.savedViews || []);
        setRevision(d.revision || null);
      })
      .catch((err) => setError(err.message || 'Could not load saved views'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadViews(); }, [loadViews]);

  // Persist updated views array to server
  const persist = useCallback((newViews) => {
    setSaving(true);
    setError(null);
    return api.saveCollabPreferences({ savedViews: newViews, revision })
      .then((d) => {
        setViews(d.preferences?.savedViews || newViews);
        setRevision(d.revision || null);
        return true;
      })
      .catch((err) => {
        if (err.status === 409 && err.data?.preferences) {
          setViews(err.data.preferences.savedViews || []);
          setRevision(err.data.revision || null);
          setError('Saved views changed on another device. Latest views loaded; try your change again.');
        } else {
          setError(err.message || 'Could not save');
        }
        return false;
      })
      .finally(() => setSaving(false));
  }, [revision]);

  const handleSave = () => {
    const name = saveName.trim();
    if (!name) return;
    const view = { id: String(Date.now()), name, bucket, person: person || '', query: q || '' };
    const next = [...(views || []), view];
    persist(next).then((saved) => {
      if (saved) {
        setSaveName('');
        setShowSaveForm(false);
      }
    });
  };

  const handleDelete = (id) => {
    const next = (views || []).filter((v) => v.id !== id);
    persist(next);
  };

  const handleApply = (view) => {
    onApply({ bucket: view.bucket, person: view.person || '', q: view.query ?? view.q ?? '' });
  };

  return (
    <div style={{ marginTop: 8 }}>
      {/* Saved view chips */}
      {views && views.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
          {views.map((v) => (
            <div
              key={v.id}
              style={{ display: 'flex', alignItems: 'center', height: 36, background: '#fff', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}
            >
              <button
                data-testid={`saved-view-apply-${v.id}`}
                onClick={() => handleApply(v)}
                style={{ height: '100%', padding: '0 10px 0 12px', background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 700, color: 'var(--brown)', display: 'flex', alignItems: 'center', gap: 5 }}
                title={`Apply: ${v.name} (${BUCKET_LABEL[v.bucket] || v.bucket}${v.person ? ', ' + v.person : ''}${(v.query ?? v.q) ? ', "' + (v.query ?? v.q) + '"' : ''})`}
              >
                {v.name}
              </button>
              <button
                data-testid={`saved-view-delete-${v.id}`}
                onClick={() => handleDelete(v.id)}
                aria-label={`Remove saved view "${v.name}"`}
                style={{ height: '100%', padding: '0 10px', background: 'none', border: 'none', borderLeft: '1px solid var(--border)', cursor: 'pointer', fontSize: 12, color: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                x
              </button>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div style={{ fontSize: 10.5, color: 'var(--red)', marginBottom: 6 }}>
          {error}{' '}
          <button onClick={loadViews} style={{ background: 'none', border: 'none', color: 'var(--red)', fontWeight: 700, cursor: 'pointer', textDecoration: 'underline', padding: 0, fontSize: 10.5 }}>
            Retry
          </button>
        </div>
      )}

      {/* Save current view */}
      {!showSaveForm ? (
        <button
          onClick={() => { setShowSaveForm(true); setTimeout(() => inputRef.current?.focus(), 50); }}
          style={{ height: 36, padding: '0 12px', background: 'none', border: '1px dashed var(--border)', borderRadius: 8, cursor: 'pointer', fontSize: 11, fontWeight: 700, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 5 }}
          title="Save current filter as a named view"
        >
          + Save current filter
        </button>
      ) : (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            ref={inputRef}
            className="input"
            style={{ flex: 1, height: 44, fontSize: 13 }}
            placeholder="View name…"
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') { setShowSaveForm(false); setSaveName(''); } }}
            maxLength={40}
            aria-label="Saved view name"
          />
          <button
            data-testid="saved-view-save-btn"
            onClick={handleSave}
            disabled={!saveName.trim() || saving}
            style={{ height: 44, padding: '0 14px', background: 'var(--brown)', color: '#fff', border: 'none', borderRadius: 9, fontWeight: 700, fontSize: 12, cursor: saveName.trim() && !saving ? 'pointer' : 'not-allowed' }}
          >
            {saving ? '…' : 'Save'}
          </button>
          <button
            onClick={() => { setShowSaveForm(false); setSaveName(''); }}
            style={{ height: 44, minWidth: 44, padding: '0 12px', background: '#fff', border: '1px solid var(--border)', borderRadius: 9, cursor: 'pointer', fontSize: 12, color: 'var(--muted)', fontWeight: 700 }}
            aria-label="Cancel saving view"
          >
            Cancel
          </button>
        </div>
      )}
      {loading && !views && (
        <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 4 }}>Loading saved views…</div>
      )}
    </div>
  );
}
