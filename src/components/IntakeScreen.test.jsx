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
const linkIntakeQuote = vi.fn(() => Promise.resolve({}));
// Per-test data for the landing lists — the duplicate-VIN guard matches the
// entered VIN against these rows.
let serverIntakes = [];
let serverQuotes = [];
vi.mock('../lib/api', () => ({
  api: {
    listIntakes: () => Promise.resolve({ intakes: serverIntakes }),
    quoterSync: () => Promise.resolve({ quotes: serverQuotes }),
    signers: () => Promise.resolve({ signers: [] }),
    getIntake: () => Promise.resolve({ found: false }),
    quotePhotos: () => Promise.resolve({ photos: [] }),
    putIntake: (...args) => putIntake(...args),
    linkIntakeQuote: (...args) => linkIntakeQuote(...args),
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
vi.mock('./WalkAroundCamera', () => ({ default: ({ quoteId }) => <div data-testid="mock-walk" data-quote-id={quoteId} /> }));
vi.mock('./PinDialog', () => ({
  default: () => <div data-testid="mock-pin" />,
  SignatureBadge: () => <span />,
}));

import IntakeScreen from './IntakeScreen';

beforeEach(() => {
  localStorage.clear();
  putIntake.mockClear();
  linkIntakeQuote.mockReset();
  linkIntakeQuote.mockResolvedValue({});
  serverIntakes = [];
  serverQuotes = [];
});
afterEach(cleanup);

const openScanner = async () => {
  render(<IntakeScreen showToast={() => {}} />);
  // The SCAN VIN button is gated: stock, miles, estimator, and the MDD tags
  // checkbox must all be filled in before scanning is allowed.
  fireEvent.change(screen.getByPlaceholderText('T-0000'), { target: { value: 'T-1234' } });
  fireEvent.change(screen.getByPlaceholderText('e.g. 45000'), { target: { value: '45000' } });
  const estSelect = screen.getByDisplayValue('Select name…');
  fireEvent.change(estSelect, { target: { value: '__custom' } });
  fireEvent.change(screen.getByPlaceholderText('Estimator name'), { target: { value: 'Test Estimator' } });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: /scan vin/i }));
  return screen.findByTestId('mock-scanner');
};

describe('IntakeScreen scan wiring', () => {
  it('keeps the Stock # entry field usable without a scanner control', () => {
    render(<IntakeScreen showToast={() => {}} />);
    const stock = screen.getByPlaceholderText('T-0000');

    expect(stock).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Scan stock label' })).not.toBeInTheDocument();
    fireEvent.change(stock, { target: { value: 'bc23126' } });
    expect(stock).toHaveValue('BC23126');
  });

  it('blocks scanning until stock, miles, estimator, and MDD checkbox are filled', () => {
    render(<IntakeScreen showToast={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /scan vin/i }));
    expect(screen.queryByTestId('mock-scanner')).not.toBeInTheDocument();
    // Required fields are marked with a red asterisk instead of a hint line.
    expect(screen.getAllByText('*').length).toBeGreaterThanOrEqual(4);
  });


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
    expect(screen.queryByText('TRUCK')).not.toBeInTheDocument();
    expect(putIntake).not.toHaveBeenCalled();
  });

  it('seeds an intake from a valid scanned VIN', async () => {
    await openScanner();
    fireEvent.click(screen.getByText('emit-valid-scan'));

    // Landing screen is replaced by the intake checklist for this VIN.
    expect(await screen.findByText('TRUCK')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('VIN…')).toHaveValue(VALID_VIN);
    expect(screen.getByRole('button', { name: 'SAVE' })).toBeInTheDocument();
  });

  it('opens walk-around capture with the newly linked quote after scanning a VIN', async () => {
    linkIntakeQuote.mockResolvedValue({ quoteId: 'q-newly-linked' });
    await openScanner();
    fireEvent.click(screen.getByText('emit-valid-scan'));

    const walkButton = await screen.findByRole('button', { name: /take walk-around photos/i });
    fireEvent.click(walkButton);

    await waitFor(() => expect(screen.getByTestId('mock-walk')).toHaveAttribute('data-quote-id', 'q-newly-linked'));
  });

  it('cancelling the scanner returns to the landing screen untouched', async () => {
    await openScanner();
    fireEvent.click(screen.getByText('emit-cancel'));
    expect(screen.queryByTestId('mock-scanner')).not.toBeInTheDocument();
    expect(screen.queryByText('TRUCK')).not.toBeInTheDocument();
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
    expect(screen.queryByText('TRUCK')).not.toBeInTheDocument();
    expect(putIntake).not.toHaveBeenCalled();

    // The override button is enabled for the invalid VIN; clicking it is the
    // explicit user choice that starts the intake.
    const override = screen.getByRole('button', { name: /use check digit override/i });
    expect(override).toBeEnabled();
    fireEvent.click(override);
    expect(await screen.findByText('TRUCK')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByPlaceholderText('VIN…')).toHaveValue(INVALID_VIN));
  });
});

// Duplicate-VIN guard: entering a VIN that already has an intake and/or quote
// must interpose the "Record already exists" dialog instead of silently
// creating a second record for the same truck.
describe('IntakeScreen duplicate-VIN guard', () => {
  const EXISTING_INTAKE = {
    id: 'in-existing',
    vin: VALID_VIN,
    vehicle: '2021 Ford F-150',
    stock: 'S123',
    estimator: 'Sam',
    pct: 40,
    completedAt: null,
    updatedAt: 1700000000000,
  };
  const EXISTING_QUOTE = {
    id: 'q-existing',
    vin: VALID_VIN,
    vehicle: '2021 Ford F-150',
    stock: 'S123',
    estimator: 'Sam',
    ts: 1700000000000,
    lines: [],
    totals: { hrs: 0, usd: 0 },
  };

  // Type the VIN into manual entry and press Start / Resume.
  const submitVin = async () => {
    render(<IntakeScreen showToast={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /enter vin manually/i }));
    const input = await screen.findByPlaceholderText('17-character VIN');
    await userEvent.type(input, VALID_VIN);
    // Wait until the landing lists have loaded, so the guard has rows to match.
    fireEvent.click(screen.getByRole('button', { name: /start \/ resume/i }));
    return screen.findByText(/Record already exists/i);
  };

  it('shows the dialog when the VIN matches an existing intake row', async () => {
    serverIntakes = [EXISTING_INTAKE];
    await submitVin();

    // Intake-exists variant: Resume is offered, Start anyway is NOT (one intake per VIN).
    // (The VIN also appears on the landing card, so match all occurrences.)
    expect(screen.getAllByText(VALID_VIN).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /resume existing intake/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /start intake anyway/i })).not.toBeInTheDocument();

    // Blocked behind the dialog: no intake was opened or persisted.
    expect(screen.queryByText('TRUCK')).not.toBeInTheDocument();
    expect(putIntake).not.toHaveBeenCalled();
  });

  it('Resume opens the existing intake instead of creating a new one', async () => {
    serverIntakes = [EXISTING_INTAKE];
    await submitVin();

    fireEvent.click(screen.getByRole('button', { name: /resume existing intake/i }));
    expect(await screen.findByText('TRUCK')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('VIN…')).toHaveValue(VALID_VIN);
    // Opening an existing intake only reads; nothing new is written.
    expect(putIntake).not.toHaveBeenCalled();
  });

  it('a VIN with only a quote offers Start anyway, which creates a fresh intake', async () => {
    serverQuotes = [EXISTING_QUOTE];
    await submitVin();

    // Quote-only variant of the dialog.
    expect(screen.getByRole('button', { name: /open existing quote/i })).toBeInTheDocument();
    const startAnyway = screen.getByRole('button', { name: /start intake anyway/i });

    fireEvent.click(startAnyway);
    expect(await screen.findByText('TRUCK')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('VIN…')).toHaveValue(VALID_VIN);
    expect(screen.queryByText(/Record already exists/i)).not.toBeInTheDocument();
  });

  it('Cancel closes the dialog and stays on the landing screen', async () => {
    serverIntakes = [EXISTING_INTAKE];
    await submitVin();

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    await waitFor(() =>
      expect(screen.queryByText(/Record already exists/i)).not.toBeInTheDocument()
    );
    // Back on the landing screen, nothing started or persisted.
    expect(screen.queryByText('TRUCK')).not.toBeInTheDocument();
    expect(putIntake).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /scan vin/i })).toBeInTheDocument();
  });
});
