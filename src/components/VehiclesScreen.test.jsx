import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./IntakeScreen', () => ({
  RecentQuoteCard: ({ quote, onClick }) => <button onClick={onClick}>{quote.vehicle}</button>,
}));
vi.mock('./GlobalSearch', () => ({ default: () => null }));
vi.mock('./SavedViews', () => ({ default: () => null }));
vi.mock('../lib/api', () => ({
  api: { retireVehicle: vi.fn().mockResolvedValue({ ok: true }) },
}));
vi.mock('./PinDialog', () => ({
  default: ({ adminOnly, onCommit, subtitle }) => (
    <div>
      <span>{adminOnly ? 'admin-only' : 'not-admin'}</span>
      <span>{subtitle}</span>
      <button onClick={() => onCommit({ signerId: 7, pin: '1234' })}>Confirm delete</button>
    </div>
  ),
}));

import VehiclesScreen from './VehiclesScreen';
import { api } from '../lib/api';

afterEach(cleanup);

describe('VehiclesScreen completed vehicle navigation', () => {
  it('opens the intake overview instead of the damage-oriented vehicle detail', () => {
    const onOpenIntake = vi.fn();
    const onOpenVehicle = vi.fn();
    const vehicle = {
      vin: '1HGCM82633A004352',
      stock: 'T-1234',
      vehicle: '2021 Honda Accord',
      qcNumber: 'FQ-1001',
      statusKey: 'frontlineReady',
      inspector: 'alex smith',
      itemCount: 2,
      intake: { id: 'in-1', quoteId: 'q-1', estimator: 'jamie lee', completedAt: 90, inProgress: false },
      quote: { hrs: 3.5, usd: 525, lineCount: 2 },
      tracker: null,
      createdTs: 100,
    };

    render(
      <VehiclesScreen
        dash={{ vehicles: [vehicle], awaiting: [] }}
        filter="completed"
        onFilter={() => {}}
        q=""
        onQ={() => {}}
        onOpenVehicle={onOpenVehicle}
        onOpenIntake={onOpenIntake}
        onOpenRecord={() => {}}
        onOpenQuote={() => {}}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /2021 Honda Accord/i }));

    expect(onOpenIntake).toHaveBeenCalledWith(vehicle);
    expect(onOpenVehicle).not.toHaveBeenCalled();
    expect(screen.getByText(vehicle.vin)).toBeInTheDocument();
    expect(screen.getByText(/Inspector: Alex Smith/i)).toBeInTheDocument();
    expect(screen.getByText(/Estimator: Jamie Lee/i)).toBeInTheDocument();
    expect(screen.getByText(/3.5 hrs.*\$525.*2 lines/i)).toBeInTheDocument();
  });

  it('preserves tap navigation when no swipe occurs', () => {
    const onOpenIntake = vi.fn();
    const intake = {
      intakeId: 'intake-exact-1',
      vin: 'SAMEVIN1234567890',
      stock: 'A-1',
      vehicle: 'Awaiting truck',
      completedAt: 10,
    };
    render(
      <VehiclesScreen
        dash={{ vehicles: [], awaiting: [intake] }}
        filter="awaitingFinalQc"
        onFilter={() => {}}
        q=""
        onQ={() => {}}
        onOpenIntake={onOpenIntake}
        onOpenRecord={() => {}}
        onOpenQuote={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Awaiting truck' }));
    expect(onOpenIntake).toHaveBeenCalledWith(intake);
  });

  it('swipes an awaiting row, requires the admin PIN dialog, and retires by exact intake id', async () => {
    const onDeleted = vi.fn();
    const intake = {
      intakeId: 'intake-exact-42',
      vin: 'DUPLICATEVIN12345',
      stock: 'S-42',
      vehicle: 'Swipe truck',
      completedAt: 10,
    };
    render(
      <VehiclesScreen
        dash={{ vehicles: [], awaiting: [intake] }}
        filter="awaitingFinalQc"
        onFilter={() => {}}
        q=""
        onQ={() => {}}
        onOpenIntake={() => {}}
        onOpenRecord={() => {}}
        onOpenQuote={() => {}}
        onDeleted={onDeleted}
      />,
    );

    const row = screen.getByTestId('swipe-vehicle-row');
    fireEvent.pointerDown(row, { pointerId: 1, clientX: 180, clientY: 20, button: 0 });
    fireEvent.pointerMove(row, { pointerId: 1, clientX: 90, clientY: 22 });
    fireEvent.pointerUp(row, { pointerId: 1, clientX: 90, clientY: 22 });
    expect(row.style.transform).toBe('translateX(-82px)');

    fireEvent.click(screen.getByRole('button', { name: 'Delete S-42' }));
    expect(screen.getByText('admin-only')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));

    await waitFor(() => expect(api.retireVehicle).toHaveBeenCalledWith({
      kind: 'intake',
      recordId: 'intake-exact-42',
      signerId: 7,
      pin: '1234',
    }));
    expect(onDeleted).toHaveBeenCalled();
  });

  it('retires a completed row by QC number rather than VIN', async () => {
    const vehicle = {
      vin: 'VIN-SHARED-BY-HISTORY',
      stock: 'QC-UNIT',
      vehicle: 'Completed truck',
      qcNumber: 'FQ-4242',
      statusKey: 'frontlineReady',
      itemCount: 0,
      intake: null,
      quote: null,
      tracker: null,
      createdTs: 100,
    };
    render(
      <VehiclesScreen
        dash={{ vehicles: [vehicle], awaiting: [] }}
        filter="completed"
        onFilter={() => {}}
        q=""
        onQ={() => {}}
        onOpenIntake={() => {}}
        onOpenRecord={() => {}}
        onOpenQuote={() => {}}
      />,
    );

    const row = screen.getByTestId('swipe-vehicle-row');
    fireEvent.pointerDown(row, { pointerId: 2, clientX: 180, clientY: 20, button: 0 });
    fireEvent.pointerMove(row, { pointerId: 2, clientX: 80, clientY: 20 });
    fireEvent.pointerUp(row, { pointerId: 2, clientX: 80, clientY: 20 });
    fireEvent.click(screen.getByRole('button', { name: 'Delete QC-UNIT' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));

    await waitFor(() => expect(api.retireVehicle).toHaveBeenCalledWith({
      kind: 'inspection',
      recordId: 'FQ-4242',
      signerId: 7,
      pin: '1234',
    }));
  });

  it('opens the full QC record for a legacy vehicle that has no digital intake', () => {
    const onOpenIntake = vi.fn();
    const onOpenRecord = vi.fn();
    const vehicle = {
      vin: '1FTFW1E55MFA00001',
      stock: 'T-OLD',
      vehicle: 'Legacy Ford F-150',
      qcNumber: 'FQ-0999',
      statusKey: 'released',
      inspector: 'alex smith',
      itemCount: 0,
      intake: null,
      quote: null,
      tracker: null,
      createdTs: 50,
    };

    render(
      <VehiclesScreen
        dash={{ vehicles: [vehicle], awaiting: [] }}
        filter="completed"
        onFilter={() => {}}
        q=""
        onQ={() => {}}
        onOpenIntake={onOpenIntake}
        onOpenRecord={onOpenRecord}
        onOpenQuote={() => {}}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Legacy Ford F-150/i }));

    expect(onOpenRecord).toHaveBeenCalledWith('FQ-0999');
    expect(onOpenIntake).not.toHaveBeenCalled();
    expect(screen.getByText(/Digital intake unavailable/i)).toBeInTheDocument();
  });
});