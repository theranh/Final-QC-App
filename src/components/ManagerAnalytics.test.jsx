import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ManagerAnalytics from './ManagerAnalytics';

const base = {
  generatedAt: '2025-02-20T12:00:00Z', timezone: 'America/Denver',
  range: { from: '2025-02-01', to: '2025-02-20', cohort: 'completed_intakes' },
  filters: { estimator: '', qcResult: '', options: { estimators: ['Mara'], qcResults: ['pass', 'fail'] } },
  cycles: { stages: [{ key: 'qc', label: 'Intake → final QC', eligible: 2, unknown: 1, invalidOrder: 0, coverage: .5, avgHours: 4, medianHours: 3, p90Hours: 7 }], truncated: false, rows: [{ vin: '1ABCDEFGH', stock: 'T-14', vehicle: 'Silverado', estimator: 'Mara', qcNumber: 'QC-4', qcResult: 'pass', durations: { intakeToQc: 3, qcToRo: null, roToRelease: null } }] },
  daily: { qcsPassed: 4, qcsFailed: 1, openRechecks: 2, exportExceptions: { count: 0, trucks: [] }, trackerSource: 'live' },
  calibration: { available: false }
};
const props = (extra = {}) => ({ data: base, loading: false, error: null, filters: { estimator: '', qcResult: '' }, onFilters: vi.fn(), onRetry: vi.fn(), onOpenVehicle: vi.fn(), onPrint: vi.fn(), onShare: vi.fn(), ...extra });

describe('ManagerAnalytics', () => {
  afterEach(() => cleanup());

  it('renders loading and retries errors', () => {
    const retry = vi.fn();
    const { rerender } = render(<ManagerAnalytics {...props({ data: null, loading: true })} />);
    expect(screen.getByLabelText(/loading manager analytics/i)).toBeInTheDocument();
    rerender(<ManagerAnalytics {...props({ data: null, error: 'Network down', onRetry: retry })} />);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(retry).toHaveBeenCalled();
  });
  it('shows coverage and unknown rather than zero', () => {
    render(<ManagerAnalytics {...props()} />);
    expect(screen.getByText(/50% coverage · 1 unknown/i)).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });
  it('passes filters and print/share actions through', () => {
    const onFilters = vi.fn(), onPrint = vi.fn(), onShare = vi.fn();
    render(<ManagerAnalytics {...props({ onFilters, onPrint, onShare })} />);
    fireEvent.change(screen.getByLabelText('Estimator filter'), { target: { value: 'Mara' } });
    fireEvent.click(screen.getByRole('button', { name: 'Print' }));
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    expect(onFilters).toHaveBeenCalledWith({ estimator: 'Mara', qcResult: '' });
    expect(onPrint).toHaveBeenCalled();
    expect(onShare).toHaveBeenCalled();
  });
  it('opens a vehicle from its accessible drilldown button', () => {
    const open = vi.fn();
    render(<ManagerAnalytics {...props({ onOpenVehicle: open })} />);
    fireEvent.click(screen.getByRole('button', { name: /silverado/i }));
    expect(open).toHaveBeenCalledWith('1ABCDEFGH', 'QC-4');
  });
  it('explains unavailable calibration and tracker offline state', () => {
    const { rerender } = render(<ManagerAnalytics {...props()} />);
    expect(screen.getByText(/calibration is unavailable/i)).toBeInTheDocument();
    rerender(<ManagerAnalytics {...props({ data: { ...base, daily: { ...base.daily, trackerSource: 'unavailable' } } })} />);
    expect(screen.getByText(/production tracker is offline/i)).toBeInTheDocument();
  });
});