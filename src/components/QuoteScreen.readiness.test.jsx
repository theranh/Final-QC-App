import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const QUOTE_ID = 'FQ-readiness';

vi.mock('../lib/api', () => ({
  api: {
    quoterSync: vi.fn().mockResolvedValue({
      quotes: [{
        id: 'FQ-readiness',
        vin: '1HGCM82633A004352',
        stock: 'T-1234',
        estimator: 'Test Estimator',
        miles: '42000',
        lines: [],
      }],
      rates: {},
      corrections: [],
    }),
    quotePhotos: vi.fn().mockResolvedValue({ photos: [] }),
    putQuote: vi.fn().mockResolvedValue({}),
    putQuotePhoto: vi.fn().mockResolvedValue({}),
    deleteQuotePhoto: vi.fn().mockResolvedValue({}),
    postCorrection: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../lib/photoQueue', () => ({
  persistJob: vi.fn().mockResolvedValue(undefined),
  removeJob: vi.fn(),
  removeJobsForPhoto: vi.fn().mockResolvedValue(undefined),
  newJobKey: vi.fn((id) => `job:${id}`),
  addDeletionTombstone: vi.fn().mockResolvedValue(undefined),
  getDeletionTombstones: vi.fn().mockResolvedValue([]),
  removeDeletionTombstone: vi.fn().mockResolvedValue(undefined),
  markPhotoDeleted: vi.fn(),
  queueServerDelete: vi.fn().mockResolvedValue(undefined),
  removeServerDelete: vi.fn().mockResolvedValue(undefined),
  subscribePending: vi.fn((listener) => {
    listener(0);
    return () => {};
  }),
  subscribePersistence: vi.fn((listener) => {
    listener(true);
    return () => {};
  }),
}));

vi.mock('../lib/zxingDecode', () => ({
  prefetchZxing: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./VinScanner', () => ({
  default: () => <div data-testid="mock-scanner" />,
}));

vi.mock('./PinDialog', () => ({
  SignatureBadge: () => <span />,
}));

vi.mock('./FieldReadiness', () => ({
  default: ({ onContinue, onCancel }) => (
    <div data-testid="readiness-dialog">
      <button onClick={onContinue}>Continue readiness</button>
      <button onClick={onCancel}>Cancel readiness</button>
    </div>
  ),
}));

vi.mock('./WalkAroundCamera', () => ({
  default: ({ initialMode, onClose }) => (
    <div data-testid="walk-camera" data-mode={initialMode}>
      <button onClick={onClose}>Close camera</button>
    </div>
  ),
}));

import QuoteScreen from './QuoteScreen';

afterEach(cleanup);

describe('QuoteScreen photo readiness navigation', () => {
  it('shows readiness before both guided and damage camera launches', async () => {
    render(
      <QuoteScreen
        prefill={{
          quoteId: QUOTE_ID,
          vin: '1HGCM82633A004352',
          stock: 'T-1234',
          estimator: 'Test Estimator',
        }}
        onClose={() => {}}
        showToast={() => {}}
      />,
    );

    const next = await screen.findByRole('button', { name: /Photograph damage/i });
    fireEvent.click(next);

    const guided = await screen.findByRole('button', { name: /TAKE PHOTOS/i });
    fireEvent.click(guided);
    expect(screen.getByTestId('readiness-dialog')).toBeInTheDocument();
    expect(screen.queryByTestId('walk-camera')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Continue readiness/i }));
    const guidedCamera = await screen.findByTestId('walk-camera');
    expect(guidedCamera).toHaveAttribute('data-mode', 'guided');
    fireEvent.click(screen.getByRole('button', { name: /Close camera/i }));
    await waitFor(() => expect(screen.queryByTestId('walk-camera')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /ADD DAMAGE CLOSE-UP/i }));
    expect(screen.getByTestId('readiness-dialog')).toBeInTheDocument();
    expect(screen.queryByTestId('walk-camera')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Continue readiness/i }));
    const damageCamera = await screen.findByTestId('walk-camera');
    expect(damageCamera).toHaveAttribute('data-mode', 'damage');
  });
});