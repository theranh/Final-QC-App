// UI-wiring tests for the Intake landing screen: scan → seed decision plumbing
// and the manual check-digit override. Complements the pure-function tests in
// src/lib/vin.test.js by verifying the actual on-screen behavior.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const VALID_VIN = '1HGCM82633A004352'; // passes the check digit
const INVALID_VIN = '1HGCM82633A004353'; // same VIN, broken check digit

// ---- mocks --------------------------------------------------------------
const putIntake = vi.fn(() => Promise.resolve({}));
vi.mock('../lib/api', () => ({
  api: {
    listIntakes: () => Promise.resolve({ intakes: [] }),
    quoterSync: () => Promise.resolve({ quotes: [] }),
    signers: () => Promise.resolve({ signers: [] }),
    getIntake: () => Promise.resolve({ found: false }),
    quotePhotos: () => Promise.resolve({ photos: [] }),
    putIntake: (...args) => putIntake(...args),
    linkIntakeQuote: () => Promise.resolve({}),
    commitIntake: () => Promise.resolve({}),
  },
}));

vi.mock('../lib/zxingDecode', () => ({
  prefetchZxing: () => Promise.resolve(),
  zxingDecodeImageData: () => null,
}));

// Keep the real vinValid / scannedVinDecision logic; stub only the network decode.
vi.mock('../lib/vin', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, decodeVinInfo: vi.fn(() => Promise.resolve(null)) };
});

// Replace the camera scanner with buttons that emit a scan result, exactly
// as VinScanner does: onDetected(vin, vinValid(vin)).
vi.mock('./VinScanner', async () => {
  const { vinValid } = await vi.importActual('../lib/vin');
  return {
    default: ({ onDetected, onCancel }) => (
      <div data-testid="mock-scanner">
        <button onClick={() => onDetected(VALID_VIN, vinValid(VALID_VIN))}>emit-valid-scan</button>
        <button onClick={() => onDetected(INVALID_VIN, vinValid(INVALID_VIN))}>emit-invalid-scan</button>
        <button onClick={onCancel}>emit-cancel</button>
      </div>
    ),
  };
});

vi.mock('./QuoteScreen', () => ({ default: () => <div data-testid="mock-quote" /> }));
vi.mock('./WalkAroundCamera', () => ({ default: () => <div data-testid="mock-walk" /> }));
vi.mock('./PinDialog', () => ({
  default: () => <div data-testid="mock-pin" />,
  SignatureBadge: () => <span />,
}));

import IntakeScreen from './IntakeScreen';

beforeEach(() => {
  localStorage.clear();
  putIntake.mockClear();
});
afterEach(cleanup);

const openScanner = async () => {
  render(<IntakeScreen showToast={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: /scan vin/i }));
  return screen.findByTestId('mock-scanner');
};

describe('IntakeScreen scan wiring', () => {
  it('blocks an invalid scanned VIN: opens manual entry with the warning, no intake seeded', async () => {
    await openScanner();
    fireEvent.click(screen.getByText('emit-invalid-scan'));

    // Manual-entry card opens pre-filled with the scanned VIN + warning.
    const input = await screen.findByPlaceholderText('17-character VIN');
    expect(input).toHaveValue(INVALID_VIN);
    expect(
      screen.getByText(/Scanned VIN failed its check digit/i)
    ).toBeInTheDocument();

    // Still on the landing screen — no intake was seeded, nothing persisted.
    expect(screen.queryByText('INTAKE PROGRESS')).not.toBeInTheDocument();
    expect(putIntake).not.toHaveBeenCalled();
  });

  it('seeds an intake from a valid scanned VIN', async () => {
    await openScanner();
    fireEvent.click(screen.getByText('emit-valid-scan'));

    // Landing screen is replaced by the intake checklist for this VIN.
    expect(await screen.findByText('INTAKE PROGRESS')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('VIN…')).toHaveValue(VALID_VIN);
  });

  it('cancelling the scanner returns to the landing screen untouched', async () => {
    await openScanner();
    fireEvent.click(screen.getByText('emit-cancel'));
    expect(screen.queryByTestId('mock-scanner')).not.toBeInTheDocument();
    expect(screen.queryByText('INTAKE PROGRESS')).not.toBeInTheDocument();
  });
});

describe('IntakeScreen manual check-digit override', () => {
  const openManualEntry = async (vin) => {
    render(<IntakeScreen showToast={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /enter vin manually/i }));
    const input = await screen.findByPlaceholderText('17-character VIN');
    await userEvent.type(input, vin);
    return input;
  };

  it('keeps the override button disabled for a valid VIN', async () => {
    await openManualEntry(VALID_VIN);
    expect(screen.getByRole('button', { name: /use check digit override/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /start \/ resume/i })).toBeEnabled();
  });

  it('an invalid VIN does not start an intake without the explicit override click', async () => {
    await openManualEntry(INVALID_VIN);

    // Plain start is rejected with the invalid-check-digit message.
    fireEvent.click(screen.getByRole('button', { name: /start \/ resume/i }));
    expect(await screen.findByText(/Invalid VIN check digit/i)).toBeInTheDocument();
    expect(screen.queryByText('INTAKE PROGRESS')).not.toBeInTheDocument();
    expect(putIntake).not.toHaveBeenCalled();

    // The override button is enabled for the invalid VIN; clicking it is the
    // explicit user choice that starts the intake.
    const override = screen.getByRole('button', { name: /use check digit override/i });
    expect(override).toBeEnabled();
    fireEvent.click(override);
    expect(await screen.findByText('INTAKE PROGRESS')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByPlaceholderText('VIN…')).toHaveValue(INVALID_VIN));
  });
});
