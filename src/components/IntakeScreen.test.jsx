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
const getIntake = vi.fn(() => Promise.resolve({ found: false }));
const quotePhotos = vi.fn(() => Promise.resolve({ photos: [] }));
const commitIntake = vi.fn(() => Promise.resolve({}));
// Per-test data for the landing lists — the duplicate-VIN guard matches the
// entered VIN against these rows.
let serverIntakes = [];
let serverQuotes = [];
vi.mock('../lib/api', () => ({
  api: {
    listIntakes: () => Promise.resolve({ intakes: serverIntakes }),
    quoterSync: () => Promise.resolve({ quotes: serverQuotes }),
    signers: () => Promise.resolve({ signers: [] }),
    getIntake: (...args) => getIntake(...args),
    quotePhotos: (...args) => quotePhotos(...args),
    putIntake: (...args) => putIntake(...args),
    linkIntakeQuote: (...args) => linkIntakeQuote(...args),
    commitIntake: (...args) => commitIntake(...args),
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
import { decodeVinInfo } from '../lib/vin';

beforeEach(() => {
  localStorage.clear();
  putIntake.mockClear();
  linkIntakeQuote.mockReset();
  linkIntakeQuote.mockResolvedValue({});
  getIntake.mockReset();
  getIntake.mockResolvedValue({ found: false });
  quotePhotos.mockReset();
  quotePhotos.mockResolvedValue({ photos: [] });
  commitIntake.mockReset();
  commitIntake.mockResolvedValue({});
  decodeVinInfo.mockReset();
  decodeVinInfo.mockResolvedValue(null);
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
    expect(putIntake).toHaveBeenCalledWith(expect.objectContaining({ vin: VALID_VIN }));
    expect(putIntake.mock.invocationCallOrder[0]).toBeLessThan(linkIntakeQuote.mock.invocationCallOrder[0]);
  });

  it('opens a completed intake overview instead of its damage quoter', async () => {
    serverIntakes = [{
      id: 'in-completed',
      vin: VALID_VIN,
      stock: 'T-1234',
      vehicle: '2021 Honda Accord',
      quoteId: 'q-completed',
      completedAt: 1700000000000,
    }];
    serverQuotes = [{
      id: 'q-completed',
      vin: VALID_VIN,
      stock: 'T-1234',
      vehicle: '2021 Honda Accord',
      estimator: 'Test Estimator',
      miles: '42000',
      ts: 1700000000000,
    }];
    const completedRow = {
      found: true,
      id: 'in-completed',
      vin: VALID_VIN,
      stock: 'T-1234',
      vehicle: '2021 Honda Accord',
      quoteId: 'q-completed',
      completedAt: 1700000000000,
      committedBy: 'Test Estimator',
      data: {},
      updatedAt: 1700000000000,
    };
    getIntake.mockResolvedValue(completedRow);
    // Simulate a different device having left a newer-looking local draft
    // without the server-owned quote link.
    localStorage.setItem('trqc.intake.cache.v2', JSON.stringify({
      [VALID_VIN]: {
        id: 'local-stale',
        vin: VALID_VIN,
        stock: 'LOCAL',
        vehicle: 'Stale local draft',
        miles: '',
        estimator: '',
        steps: { 1: [], 2: [], 3: [], 4: [] },
        roReady: [],
        notes: '',
        ts: 1800000000000,
        completedAt: null,
        committedBy: null,
        overriddenBy: null,
        quoteId: null,
        mddTags: false,
      },
    }));

    render(<IntakeScreen showToast={() => {}} />);
    fireEvent.click(await screen.findByText(/2021 Honda Accord/i));

    expect(await screen.findByText('WALK-AROUND PHOTOS · 0')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-quote')).not.toBeInTheDocument();
    expect(getIntake).toHaveBeenCalledWith(VALID_VIN);
    await waitFor(() => expect(quotePhotos).toHaveBeenCalledWith('q-completed'));
  });

  it('hydrates a Vehicles-tab VIN with all saved details and separates walk-around from damage photos', async () => {
    serverQuotes = [{
      id: 'q-vehicle-tab',
      vin: VALID_VIN,
      stock: 'T-5678',
      vehicle: '2022 Honda Accord',
      estimator: 'Jamie Lee',
      miles: '38250',
      ts: 1700000000000,
      lines: [{ id: 'line-1', cls: { panel: 'Door' } }],
      totals: { hrs: 2.5, usd: 375 },
    }];
    getIntake.mockResolvedValue({
      found: true,
      id: 'in-vehicle-tab',
      vin: VALID_VIN,
      stock: 'T-5678',
      vehicle: '2022 Honda Accord',
      miles: '38250',
      estimator: 'Jamie Lee',
      quoteId: 'q-vehicle-tab',
      completedAt: 1700000000000,
      committedBy: 'Jamie Lee',
      data: { notes: 'Saved intake note', mddTags: true, roReady: Array(9).fill(true) },
      updatedAt: 1700000000000,
    });
    quotePhotos.mockResolvedValue({
      photos: [
        { id: 'p-front', slot: 'front' },
        { id: 'p-extra', slot: 'xtra_1' },
        { id: 'p-damage', slot: 'dmg_door' },
      ],
    });

    render(<IntakeScreen showToast={() => {}} openVin={VALID_VIN} onOpenVinConsumed={() => {}} />);

    expect(await screen.findByDisplayValue('T-5678')).toBeDisabled();
    expect(screen.getByDisplayValue('2022 Honda Accord')).toBeDisabled();
    expect(screen.getByDisplayValue('38250')).toBeDisabled();
    expect(screen.getByDisplayValue('Jamie Lee')).toBeDisabled();
    expect(await screen.findByText('WALK-AROUND PHOTOS · 2')).toBeInTheDocument();
    expect(screen.getByText('DAMAGE PHOTOS · 1')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-quote')).not.toBeInTheDocument();
    expect(quotePhotos).toHaveBeenCalledWith('q-vehicle-tab');
  });

  it('still opens the damage quoter for a true quote-only record', async () => {
    serverQuotes = [{
      id: 'q-only',
      vin: VALID_VIN,
      stock: 'T-1234',
      vehicle: '2021 Honda Accord',
      estimator: 'Test Estimator',
      miles: '42000',
      ts: 1700000000000,
    }];

    render(<IntakeScreen showToast={() => {}} />);
    fireEvent.click(await screen.findByText(/2021 Honda Accord/i));

    expect(await screen.findByTestId('mock-quote')).toBeInTheDocument();
    expect(screen.queryByText(/WALK-AROUND PHOTOS/i)).not.toBeInTheDocument();
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

describe('IntakeScreen cache and request ordering', () => {
  const VIN_B = '1FTFW1E55MFA00001';
  const serverRow = (vin, stock, updatedAt) => ({
    found: true,
    id: `in-${stock}`,
    vin,
    stock,
    vehicle: `${stock} vehicle`,
    miles: '100',
    estimator: 'Estimator',
    quoteId: null,
    completedAt: null,
    committedBy: null,
    data: {},
    updatedAt,
  });

  it('uses strictly increasing timestamps for edits made in the same millisecond', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    render(<IntakeScreen showToast={() => {}} openVin={VALID_VIN} onOpenVinConsumed={() => {}} />);
    await screen.findByText('TRUCK');
    const stockInput = screen.getByText('STOCK #').parentElement.querySelector('input');

    fireEvent.change(stockInput, { target: { value: 'FIRST' } });
    fireEvent.change(stockInput, { target: { value: 'SECOND' } });

    await waitFor(() => expect(putIntake).toHaveBeenCalledTimes(2));
    const firstTs = putIntake.mock.calls[0][0].ts;
    const secondTs = putIntake.mock.calls[1][0].ts;
    expect(secondTs).toBeGreaterThan(firstTs);
    now.mockRestore();
  });

  it('ignores an older response from a previous A→B→A visit', async () => {
    const requests = [];
    getIntake.mockImplementation((vin) => new Promise((resolve) => requests.push({ vin, resolve })));
    const view = render(<IntakeScreen showToast={() => {}} openVin={VALID_VIN} onOpenVinConsumed={() => {}} />);
    await waitFor(() => expect(requests).toHaveLength(1));

    view.rerender(<IntakeScreen showToast={() => {}} openVin={VIN_B} onOpenVinConsumed={() => {}} />);
    await waitFor(() => expect(requests).toHaveLength(2));
    view.rerender(<IntakeScreen showToast={() => {}} openVin={VALID_VIN} onOpenVinConsumed={() => {}} />);
    await waitFor(() => expect(requests).toHaveLength(3));

    requests[2].resolve(serverRow(VALID_VIN, 'NEWEST', 300));
    expect(await screen.findByDisplayValue('NEWEST')).toBeInTheDocument();
    requests[0].resolve(serverRow(VALID_VIN, 'STALE', 100));
    requests[1].resolve({ found: false });

    await waitFor(() => expect(screen.getByDisplayValue('NEWEST')).toBeInTheDocument());
    expect(screen.queryByDisplayValue('STALE')).not.toBeInTheDocument();
  });

  it('does not apply a VIN decode after the inspector has switched trucks', async () => {
    let resolveFirstDecode;
    decodeVinInfo.mockImplementation((vin) => {
      if (vin === VALID_VIN) return new Promise((resolve) => { resolveFirstDecode = resolve; });
      return Promise.resolve(null);
    });
    const view = render(<IntakeScreen showToast={() => {}} openVin={VALID_VIN} onOpenVinConsumed={() => {}} />);
    await waitFor(() => expect(decodeVinInfo).toHaveBeenCalledWith(VALID_VIN));

    view.rerender(<IntakeScreen showToast={() => {}} openVin={VIN_B} onOpenVinConsumed={() => {}} />);
    await waitFor(() => expect(screen.getByPlaceholderText('VIN…')).toHaveValue(VIN_B));
    resolveFirstDecode('WRONG TRUCK DESCRIPTION');

    await waitFor(() => expect(screen.queryByDisplayValue('WRONG TRUCK DESCRIPTION')).not.toBeInTheDocument());
    const vehicleInput = screen.getByText('VEHICLE').parentElement.querySelector('input');
    expect(vehicleInput).toHaveValue('');
  });

  it('ignores a valid-JSON but malformed cache instead of crashing', async () => {
    localStorage.setItem('trqc.intake.cache.v2', JSON.stringify('not-an-intake-map'));

    render(<IntakeScreen showToast={() => {}} openVin={VALID_VIN} onOpenVinConsumed={() => {}} />);

    expect(await screen.findByText('TRUCK')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('VIN…')).toHaveValue(VALID_VIN);
  });

  it('does not attach an in-flight quote link to a different VIN', async () => {
    let resolveLink;
    linkIntakeQuote.mockImplementation(() => new Promise((resolve) => { resolveLink = resolve; }));
    const intakeA = serverRow(VALID_VIN, 'A-STOCK', 100);
    const intakeB = serverRow(VIN_B, 'B-STOCK', 200);
    localStorage.setItem('trqc.intake.cache.v2', JSON.stringify({
      [VALID_VIN]: { ...intakeA, ts: 100 },
      [VIN_B]: { ...intakeB, ts: 200 },
    }));
    const view = render(
      <IntakeScreen
        showToast={() => {}}
        openVin={VALID_VIN}
        onOpenVinConsumed={() => {}}
      />,
    );
    await screen.findByDisplayValue('A-STOCK');
    fireEvent.click(screen.getByRole('button', { name: 'TAKE WALK-AROUND PHOTOS' }));
    await waitFor(() => expect(linkIntakeQuote).toHaveBeenCalledTimes(1));

    view.rerender(
      <IntakeScreen
        showToast={() => {}}
        openVin={VIN_B}
        onOpenVinConsumed={() => {}}
      />,
    );
    expect(await screen.findByDisplayValue('B-STOCK')).toBeInTheDocument();
    resolveLink({ quoteId: 'quote-for-a' });

    await waitFor(() => expect(screen.getByDisplayValue('B-STOCK')).toBeInTheDocument());
    const cache = JSON.parse(localStorage.getItem('trqc.intake.cache.v2'));
    expect(cache[VIN_B].id).toBe(intakeB.id);
    expect(cache[VIN_B].quoteId).toBeNull();
  });

  it('abandons 409 link repair when the open VIN changes', async () => {
    let resolveRepairLookup;
    linkIntakeQuote.mockRejectedValueOnce(Object.assign(new Error('Conflict'), { status: 409 }));
    getIntake
      .mockResolvedValueOnce({ found: false })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRepairLookup = resolve; }));
    const intakeA = serverRow(VALID_VIN, 'A-STOCK', 100);
    const intakeB = serverRow(VIN_B, 'B-STOCK', 200);
    localStorage.setItem('trqc.intake.cache.v2', JSON.stringify({
      [VALID_VIN]: { ...intakeA, ts: 100 },
      [VIN_B]: { ...intakeB, ts: 200 },
    }));
    const view = render(
      <IntakeScreen
        showToast={() => {}}
        openVin={VALID_VIN}
        onOpenVinConsumed={() => {}}
      />,
    );
    await screen.findByDisplayValue('A-STOCK');
    fireEvent.click(screen.getByRole('button', { name: 'TAKE WALK-AROUND PHOTOS' }));
    await waitFor(() => expect(getIntake).toHaveBeenCalledTimes(2));

    view.rerender(
      <IntakeScreen
        showToast={() => {}}
        openVin={VIN_B}
        onOpenVinConsumed={() => {}}
      />,
    );
    expect(await screen.findByDisplayValue('B-STOCK')).toBeInTheDocument();
    resolveRepairLookup({ ...intakeA, found: true, quoteId: null });

    await waitFor(() => expect(screen.getByDisplayValue('B-STOCK')).toBeInTheDocument());
    expect(linkIntakeQuote).toHaveBeenCalledTimes(1);
    const cache = JSON.parse(localStorage.getItem('trqc.intake.cache.v2'));
    expect(cache[VIN_B].id).toBe(intakeB.id);
    expect(cache[VIN_B].quoteId).toBeNull();
  });
});
