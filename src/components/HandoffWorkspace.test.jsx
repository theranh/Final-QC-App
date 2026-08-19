// Tests for collaboration module:
//   1. SavedViews — apply saved view calls onApply with correct shape
//   2. SavedViews — delete removes the view from the list
//   3. BulkActions — confirm dialog is required before bulk archive
//   4. ActivityTimeline — empty state renders when events=[]

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

// ── mocks ────────────────────────────────────────────────────────────────

const mockCollabPreferences = vi.fn(() => Promise.resolve({ preferences: { savedViews: [] } }));
const mockSaveCollabPreferences = vi.fn(() => Promise.resolve({ preferences: { savedViews: [] }, revision: '2026-08-19T12:00:00.000Z' }));
const mockCollabTimeline = vi.fn(() => Promise.resolve({ events: [], flags: [] }));
const mockAddCollabFlag = vi.fn(() => Promise.resolve({}));
const mockDeleteCollabFlag = vi.fn(() => Promise.resolve({}));
const mockCollabHandoff = vi.fn(() => Promise.resolve({
  awaitingFinalQc: [],
  staleIntakes: [],
  openRechecks: [],
  failedExports: [],
  activeFlags: [],
  generatedAt: new Date().toISOString(),
}));
const mockBulkArchive = vi.fn(() => Promise.resolve({ results: [], changed: 0 }));

vi.mock('../lib/api', () => ({
  api: {
    collabPreferences: (...a) => mockCollabPreferences(...a),
    saveCollabPreferences: (...a) => mockSaveCollabPreferences(...a),
    collabTimeline: (...a) => mockCollabTimeline(...a),
    addCollabFlag: (...a) => mockAddCollabFlag(...a),
    deleteCollabFlag: (...a) => mockDeleteCollabFlag(...a),
    collabHandoff: (...a) => mockCollabHandoff(...a),
    bulkArchive: (...a) => mockBulkArchive(...a),
  },
}));

vi.mock('../lib/photoQueue', () => ({
  subscribePending: (fn) => { fn(0); return () => {}; },
  flushQueue: () => {},
}));

afterEach(cleanup);

// ── SavedViews tests ──────────────────────────────────────────────────────

import SavedViews from './SavedViews';

describe('SavedViews', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls onApply with correct shape when a saved view is clicked', async () => {
    const view = { id: 'v1', name: 'My filter', bucket: 'completed', person: 'Mike', query: 'T-100' };
    mockCollabPreferences.mockResolvedValue({ preferences: { savedViews: [view] } });

    const onApply = vi.fn();
    render(<SavedViews bucket="awaitingFinalQc" person="" q="" onApply={onApply} />);

    const btn = await screen.findByTestId('saved-view-apply-v1');
    fireEvent.click(btn);

    expect(onApply).toHaveBeenCalledWith({ bucket: 'completed', person: 'Mike', q: 'T-100' });
  });

  it('removes the view from the list when delete is clicked', async () => {
    const view = { id: 'v2', name: 'Old filter', bucket: 'awaitingFinalQc', person: '', query: '' };
    mockCollabPreferences.mockResolvedValue({ preferences: { savedViews: [view] } });
    mockSaveCollabPreferences.mockResolvedValue({});

    render(<SavedViews bucket="awaitingFinalQc" person="" q="" onApply={vi.fn()} />);

    const delBtn = await screen.findByTestId('saved-view-delete-v2');
    fireEvent.click(delBtn);

    await waitFor(() => {
      expect(mockSaveCollabPreferences).toHaveBeenCalledWith({ savedViews: [], revision: null });
    });
  });

  it('saves a new view when the save form is submitted', async () => {
    mockCollabPreferences.mockResolvedValue({ preferences: { savedViews: [] } });
    mockSaveCollabPreferences.mockResolvedValue({});

    render(<SavedViews bucket="completed" person="Joe" q="T-99" onApply={vi.fn()} />);

    // Open form
    const addBtn = await screen.findByTitle('Save current filter as a named view');
    fireEvent.click(addBtn);

    // Type a name and save
    const input = screen.getByRole('textbox', { name: /saved view name/i });
    fireEvent.change(input, { target: { value: 'Joe completed' } });

    const saveBtn = screen.getByTestId('saved-view-save-btn');
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(mockSaveCollabPreferences).toHaveBeenCalled();
      const [arg] = mockSaveCollabPreferences.mock.calls[0];
      expect(arg.savedViews[0].name).toBe('Joe completed');
      expect(arg.savedViews[0].bucket).toBe('completed');
      expect(arg.savedViews[0].query).toBe('T-99');
    });
  });
});

// ── ActivityTimeline empty state ───────────────────────────────────────────

import ActivityTimeline from './ActivityTimeline';

describe('ActivityTimeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCollabTimeline.mockResolvedValue({ events: [], flags: [] });
  });

  it('shows empty-state message when no events exist', async () => {
    render(<ActivityTimeline vin="1FTFW1ET5BFC10312" qcNumber="FQ-1001" />);
    const empty = await screen.findByTestId('timeline-empty');
    expect(empty).toBeTruthy();
    expect(empty.textContent).toMatch(/no activity/i);
  });

  it('renders flag buttons for each flag kind', async () => {
    render(<ActivityTimeline vin="1FTFW1ET5BFC10312" />);
    // Wait for load
    await screen.findByTestId('timeline-empty');
    expect(screen.getByText('Needs wash')).toBeTruthy();
    expect(screen.getByText('Waiting parts')).toBeTruthy();
    expect(screen.getByText('Manager review')).toBeTruthy();
  });

  it('renders the server timeline contract and marks missing dates honestly', async () => {
    mockCollabTimeline.mockResolvedValue({
      events: [
        { eventType: 'quote_committed', occurredAt: null, actor: 'Alex', source: 'quotes' },
        { eventType: 'inspection_created', occurredAt: '2026-08-19T12:00:00.000Z', actor: 'Sam', source: 'inspections' },
      ],
      flags: [{ id: 7, kind: 'waiting_parts', creatorName: 'Pat', note: 'Mirror' }],
    });
    render(<ActivityTimeline vin="1FTFW1ET5BFC10312" />);
    expect(await screen.findByText('Body quote committed')).toBeTruthy();
    expect(screen.getByText('Date unknown')).toBeTruthy();
    expect(screen.getByText(/Added by Pat/)).toBeTruthy();
    expect(screen.getByText('Source: Body quote')).toBeTruthy();
  });
});

// ── BulkActions confirm dialog ─────────────────────────────────────────────

import RecordsList from './RecordsList';

function makeRecord(overrides = {}) {
  return {
    id: 'FQ-1001',
    ts: Date.now(),
    stock: 'T-4821',
    vehicle: '2021 F-150 XLT',
    vin: '1HGCM82633A004352',
    inspector: 'R. Delgado',
    title: 'VRA',
    result: 'pass',
    status: 'pass',
    rechecks: [],
    items: {},
    checked: 1,
    failCount: 0,
    ...overrides,
  };
}

describe('RecordsList bulk actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Suppress window.confirm calls
    vi.spyOn(window, 'confirm').mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not call bulk API when confirm is cancelled', async () => {
    window.confirm.mockReturnValue(false);
    const recs = [makeRecord()];

    render(
      <RecordsList
        recs={recs}
        q="" onQ={vi.fn()}
        fRes="all" onFRes={vi.fn()}
        fFrom="" onFFrom={vi.fn()}
        fTo="" onFTo={vi.fn()}
        onOpenRecord={vi.fn()}
        isAdmin={true}
        onBulkDone={vi.fn()}
      />
    );

    // Enter selection mode
    fireEvent.click(screen.getByText('Select'));

    // Select the record via its checkbox
    const cb = screen.getByRole('checkbox');
    fireEvent.click(cb);

    // Click archive
    const archiveBtn = screen.getByText(/^Archive/);
    fireEvent.click(archiveBtn);

    expect(window.confirm).toHaveBeenCalled();
    expect(mockBulkArchive).not.toHaveBeenCalled();
  });

  it('calls bulk API when confirm is accepted', async () => {
    window.confirm.mockReturnValue(true);
    mockBulkArchive.mockResolvedValue({
      results: [{ qcNumber: 'FQ-1001', result: 'changed' }],
      changed: 1,
    });
    const recs = [makeRecord()];

    render(
      <RecordsList
        recs={recs}
        q="" onQ={vi.fn()}
        fRes="all" onFRes={vi.fn()}
        fFrom="" onFFrom={vi.fn()}
        fTo="" onFTo={vi.fn()}
        onOpenRecord={vi.fn()}
        isAdmin={true}
        onBulkDone={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText('Select'));
    const cb = screen.getByRole('checkbox');
    fireEvent.click(cb);

    const archiveBtn = screen.getByText(/^Archive/);
    fireEvent.click(archiveBtn);

    await waitFor(() => {
      expect(mockBulkArchive).toHaveBeenCalledWith(['FQ-1001'], true);
    });
  });

  it('shows Select button only for admins', () => {
    render(
      <RecordsList
        recs={[]}
        q="" onQ={vi.fn()}
        fRes="all" onFRes={vi.fn()}
        fFrom="" onFFrom={vi.fn()}
        fTo="" onFTo={vi.fn()}
        onOpenRecord={vi.fn()}
        isAdmin={false}
      />
    );
    expect(screen.queryByText('Select')).toBeNull();
  });
});
