import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => {
  const record = {
    id: 'FQ-1001',
    stock: 'T-1001',
    vehicle: '2021 Ford F-150',
    vin: '1FTFW1E55MFA00001',
    status: 'open',
    result: 'fail',
    openItems: [{ cat: 'body', item: 'Door', note: 'Dent', photos: ['p'] }],
  };
  const api = {
    bootstrap: vi.fn(),
    dashboard: vi.fn(),
    createInspection: vi.fn(),
    commitRecheck: vi.fn(),
    managerAnalytics: vi.fn(),
    backupStatus: vi.fn(),
  };
  const authRefresh = vi.fn();
  return { api, record, authRefresh };
});

vi.mock('./lib/api', () => ({ api: H.api }));
vi.mock('./hooks/useAuth', () => ({
  useAuth: () => ({
    status: 'active',
    employee: { name: 'Alex Smith', title: 'Inspector', email: 'alex@truckranch.com', isAdmin: false },
    refresh: H.authRefresh,
  }),
}));
vi.mock('./hooks/useAppUpdate', () => ({ default: () => ({ updateReady: false, applyUpdate: vi.fn() }) }));
vi.mock('./hooks/useVinAutofill', () => ({ useVinAutofill: () => {} }));
vi.mock('./lib/zxingDecode', () => ({ prefetchZxing: () => Promise.resolve() }));

vi.mock('./components/Header', () => ({ default: () => <div data-testid="header" /> }));
vi.mock('./components/BottomNav', () => ({
  default: ({ onChange }) => (
    <nav>
      {['dash', 'vehicles', 'intake', 'inspect', 'reports'].map((tab) => (
        <button key={tab} onClick={() => onChange(tab)}>nav-{tab}</button>
      ))}
    </nav>
  ),
}));
vi.mock('./components/DashScreen', () => ({
  default: ({ dash, loadState, loadError, onRetry, onOpenVehicle }) => (
    <div data-testid="dash-screen">
      <span>dash-state:{loadState}</span>
      <span>dash-data:{dash ? dash.vehicles.length : 'none'}</span>
      {loadError && <span>dash-error:{loadError}</span>}
      <button onClick={onRetry}>retry-dashboard</button>
      <button onClick={() => onOpenVehicle(H.record.vin, H.record.id)}>open-dashboard-vehicle</button>
    </div>
  ),
}));
vi.mock('./components/VehiclesScreen', () => ({
  default: ({ onOpenQuote, onOpenRecord, onOpenIntake }) => (
    <div data-testid="vehicles-screen">
      <button onClick={() => onOpenQuote({ quoteId: 'q-only', vin: 'QUOTEONLYVIN00001' })}>open-quote-only</button>
      <button onClick={() => onOpenRecord(H.record.id)}>open-list-record</button>
      <button onClick={() => onOpenIntake({ vin: H.record.vin })}>open-list-intake</button>
    </div>
  ),
}));
vi.mock('./components/VehicleCard', () => ({
  default: ({ onOpenRecord }) => (
    <div data-testid="vehicle-card">
      <button onClick={() => onOpenRecord(H.record.id)}>open-vehicle-record</button>
    </div>
  ),
}));
vi.mock('./components/IntakeScreen', () => ({
  default: ({ openVin, openQuote }) => (
    <div data-testid="intake-screen">
      vin:{openVin || 'none'} quote:{openQuote?.quoteId || 'none'}
    </div>
  ),
}));
vi.mock('./components/HomeScreen', () => ({ default: () => <div data-testid="home-screen" /> }));
vi.mock('./components/NewInspectionForm', () => ({ default: () => <div data-testid="new-inspection" /> }));
vi.mock('./components/ChecklistSheet', () => ({ default: () => <div data-testid="checklist" /> }));
vi.mock('./components/ResultScreen', () => ({ default: () => <div data-testid="result" /> }));
vi.mock('./components/RecheckSheet', () => ({ default: () => <div data-testid="recheck" /> }));
vi.mock('./components/RecordsList', () => ({ default: () => <div data-testid="records-list" /> }));
vi.mock('./components/RecordDetail', () => ({
  default: ({ record }) => <div data-testid="record-detail">record:{record.id}</div>,
}));
vi.mock('./components/ReportsScreen', () => ({ default: () => <div data-testid="reports-screen" /> }));
vi.mock('./components/PrintReport', () => ({ default: () => <div /> }));
vi.mock('./components/SettingsScreen', () => ({ default: () => <div data-testid="settings-screen" /> }));
vi.mock('./components/AuthScreens', () => ({
  LoadingScreen: () => <div>loading</div>,
  LoginScreen: () => <div>login</div>,
  AccessScreen: () => <div>access</div>,
  ErrorScreen: ({ onRetry, detail }) => <div>error:{detail}<button onClick={onRetry}>retry-bootstrap</button></div>,
}));
vi.mock('./components/UpdateBanner', () => ({ default: () => null }));
vi.mock('./components/PhotoQueueIndicator', () => ({ default: () => null }));
vi.mock('./components/Lightbox', () => ({ default: () => null }));
vi.mock('./components/VinScanner', () => ({ default: () => null }));
vi.mock('./components/Toast', () => ({ default: ({ message }) => message ? <div role="status">{message}</div> : null }));

import App from './App';

const dashboard = {
  vehicles: [{
    vin: H.record.vin,
    qcNumber: H.record.id,
    stock: H.record.stock,
    vehicle: H.record.vehicle,
  }],
  awaiting: [],
};

async function renderReadyApp() {
  render(<App />);
  await screen.findByTestId('dash-screen');
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  H.api.bootstrap.mockResolvedValue({ inspections: [H.record], nextQc: 1002 });
  H.api.dashboard.mockResolvedValue(dashboard);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('App navigation state', () => {
  it('does not reopen a stale quote intent after leaving Intake', async () => {
    await renderReadyApp();
    fireEvent.click(screen.getByText('nav-vehicles'));
    fireEvent.click(await screen.findByText('open-quote-only'));
    expect(await screen.findByTestId('intake-screen')).toHaveTextContent('quote:q-only');

    fireEvent.click(screen.getByText('nav-dash'));
    fireEvent.click(screen.getByText('nav-intake'));

    expect(await screen.findByTestId('intake-screen')).toHaveTextContent('quote:none');
  });

  it('clears a vehicle selection when opening a QC record', async () => {
    await renderReadyApp();
    fireEvent.click(screen.getByText('open-dashboard-vehicle'));
    fireEvent.click(await screen.findByText('open-vehicle-record'));
    expect(await screen.findByTestId('record-detail')).toHaveTextContent('FQ-1001');

    fireEvent.click(screen.getByText('nav-vehicles'));

    expect(await screen.findByTestId('vehicles-screen')).toBeInTheDocument();
    expect(screen.queryByTestId('vehicle-card')).not.toBeInTheDocument();
  });
});

describe('startup and dashboard recovery', () => {
  it('uses bounded backoff while bootstrap catches a publish/resume race', async () => {
    vi.useFakeTimers();
    H.api.bootstrap
      .mockRejectedValueOnce(new Error('starting'))
      .mockRejectedValueOnce(new Error('still starting'))
      .mockResolvedValue({ inspections: [H.record], nextQc: 1002 });

    render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });

    expect(H.api.bootstrap).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId('dash-screen')).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('resets the startup error screen when the user retries', async () => {
    vi.useFakeTimers();
    H.api.bootstrap.mockRejectedValue(new Error('offline'));
    render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(7000); });
    expect(screen.getByText(/error:offline/)).toBeInTheDocument();

    H.api.bootstrap.mockResolvedValue({ inspections: [H.record], nextQc: 1002 });
    fireEvent.click(screen.getByText('retry-bootstrap'));
    expect(screen.getByText('loading')).toBeInTheDocument();
    await act(async () => {});
    expect(screen.getByTestId('dash-screen')).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('hands a bootstrap 401 directly back to auth without retrying', async () => {
    H.api.bootstrap.mockRejectedValue(Object.assign(new Error('signed out'), { status: 401 }));
    render(<App />);
    await waitFor(() => expect(H.authRefresh).toHaveBeenCalledTimes(1));
    expect(H.api.bootstrap).toHaveBeenCalledTimes(1);
  });

  it('reports dashboard failure without discarding its last good payload', async () => {
    vi.useFakeTimers();
    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('dash-data:1')).toBeInTheDocument();

    H.api.dashboard.mockRejectedValue(new Error('dashboard offline'));
    fireEvent.click(screen.getByText('retry-dashboard'));
    await act(async () => { await vi.advanceTimersByTimeAsync(5250); });

    expect(H.api.dashboard).toHaveBeenCalledTimes(5);
    expect(screen.getByText('dash-data:1')).toBeInTheDocument();
    expect(screen.getByText('dash-state:error')).toBeInTheDocument();
    expect(screen.getByText('dash-error:dashboard offline')).toBeInTheDocument();
    vi.useRealTimers();
  });
});

describe('durable pending commit recovery', () => {
  const seedPending = (entry) => {
    localStorage.setItem('fq_pending_commit_v1', JSON.stringify({ ...entry, ts: 100 }));
  };

  it('keeps a create payload after a 400 instead of silently discarding it', async () => {
    seedPending({ type: 'create', payload: { vin: H.record.vin } });
    H.api.createInspection.mockRejectedValue(Object.assign(new Error('Invalid inspection'), { status: 400 }));
    await renderReadyApp();

    fireEvent.click(screen.getByRole('button', { name: 'RETRY' }));

    expect(await screen.findByText(/Still NOT SAVED — Invalid inspection/i)).toBeInTheDocument();
    expect(screen.getByText(/Final QC inspection is NOT SAVED/i)).toBeInTheDocument();
    expect(localStorage.getItem('fq_pending_commit_v1')).not.toBeNull();
  });

  it('finishes a recovered create and opens the saved record', async () => {
    seedPending({ type: 'create', payload: { vin: H.record.vin } });
    H.api.createInspection.mockResolvedValue({ record: H.record, nextQc: 1002 });
    await renderReadyApp();

    fireEvent.click(screen.getByRole('button', { name: 'RETRY' }));

    expect(await screen.findByTestId('record-detail')).toHaveTextContent('record:FQ-1001');
    expect(screen.queryByText(/Final QC inspection is NOT SAVED/i)).not.toBeInTheDocument();
    expect(localStorage.getItem('fq_pending_commit_v1')).toBeNull();
  });

  it('finishes a recovered re-check and opens the updated record', async () => {
    const cleared = { ...H.record, status: 'cleared', result: 'pass', openItems: [] };
    seedPending({ type: 'recheck', qc: H.record.id, payload: { items: [{ outcome: 'pass' }] } });
    H.api.commitRecheck.mockResolvedValue({ record: cleared });
    await renderReadyApp();

    fireEvent.click(screen.getByRole('button', { name: 'RETRY' }));

    expect(await screen.findByTestId('record-detail')).toHaveTextContent('record:FQ-1001');
    expect(screen.queryByText(/Re-check for FQ-1001 NOT SAVED/i)).not.toBeInTheDocument();
  });

  it('starts only one retry when RETRY is tapped twice in the same tick', async () => {
    seedPending({ type: 'create', payload: { vin: H.record.vin } });
    let resolve;
    H.api.createInspection.mockImplementation(() => new Promise((r) => { resolve = r; }));
    await renderReadyApp();
    const retry = screen.getByRole('button', { name: 'RETRY' });

    act(() => {
      retry.click();
      retry.click();
    });

    expect(H.api.createInspection).toHaveBeenCalledTimes(1);
    resolve({ record: H.record, nextQc: 1002 });
    await waitFor(() => expect(screen.queryByText(/NOT SAVED/i)).not.toBeInTheDocument());
  });

  it('retires a stale create draft when the server confirms that VIN is already saved', async () => {
    seedPending({ type: 'create', payload: { vin: H.record.vin } });
    localStorage.setItem('fqc_draft', JSON.stringify({
      draft: { stock: H.record.stock, vehicle: H.record.vehicle, vin: H.record.vin, uid: 'me' },
      marks: {}, notes: {}, photos: {}, optOut: {}, stage: 'form',
    }));
    H.api.createInspection.mockRejectedValue(Object.assign(new Error('Already saved'), {
      status: 409,
      data: { qcNumber: H.record.id },
    }));
    render(<App />);
    await screen.findByTestId('new-inspection');

    fireEvent.click(screen.getByRole('button', { name: 'RETRY' }));

    expect(await screen.findByTestId('record-detail')).toHaveTextContent('record:FQ-1001');
    expect(localStorage.getItem('fq_pending_commit_v1')).toBeNull();
  });
});