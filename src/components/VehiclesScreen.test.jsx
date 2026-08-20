import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./IntakeScreen', () => ({
  RecentQuoteCard: ({ quote, onClick }) => <button onClick={onClick}>{quote.vehicle}</button>,
}));
vi.mock('./GlobalSearch', () => ({ default: () => null }));
vi.mock('./SavedViews', () => ({ default: () => null }));

import VehiclesScreen from './VehiclesScreen';

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