import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api } from '../lib/api';

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

vi.mock('./WalkAroundCamera', () => ({
  default: ({ initialMode, onClose }) => (
    <div data-testid="walk-camera" data-mode={initialMode}>
      <button onClick={onClose}>Close camera</button>
    </div>
  ),
}));

import QuoteScreen from './QuoteScreen';

afterEach(cleanup);

describe('QuoteScreen camera navigation', () => {
  it('opens both guided and damage camera modes immediately', async () => {
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
    const guidedCamera = await screen.findByTestId('walk-camera');
    expect(guidedCamera).toHaveAttribute('data-mode', 'guided');
    fireEvent.click(screen.getByRole('button', { name: /Close camera/i }));
    await waitFor(() => expect(screen.queryByTestId('walk-camera')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /ADD DAMAGE CLOSE-UP/i }));
    const damageCamera = await screen.findByTestId('walk-camera');
    expect(damageCamera).toHaveAttribute('data-mode', 'damage');
  });

  it('makes every stored photo reachable from a reopened saved quote', async () => {
    api.quoterSync.mockResolvedValueOnce({
      quotes: [{
        id: 'FQ-with-saved-photos',
        vin: '1GTUUCED3RZ336835',
        stock: 'A22944',
        estimator: 'Brandon',
        miles: '100',
        lines: [{
          id: 'damage-1',
          status: 'done',
          review: false,
          cls: {
            panel: 'hood',
            damage_type: 'dent',
            severity: 'minor',
            paint_damaged: false,
            ri_parts_needed: [],
          },
        }],
      }],
      rates: {},
      corrections: [],
    });
    api.quotePhotos.mockResolvedValueOnce({
      photos: [
        { id: 'walk-1', slot: 'ext_front', ts: 1 },
        { id: 'walk-2', slot: 'int_dash', ts: 2 },
        { id: 'damage-1', slot: 'dmg', ts: 3 },
      ],
    });

    render(
      <QuoteScreen
        prefill={{
          quoteId: 'FQ-with-saved-photos',
          vin: '1GTUUCED3RZ336835',
          stock: 'A22944',
          estimator: 'Brandon',
        }}
        onClose={() => {}}
        showToast={() => {}}
      />,
    );

    const viewPhotos = await screen.findByRole('button', {
      name: /VIEW ALL SAVED PHOTOS · 3 \(2 WALK-AROUND\)/i,
    });
    fireEvent.click(viewPhotos);

    expect(await screen.findByText('WALK-AROUND PHOTOS · 2')).toBeInTheDocument();
    expect(screen.getByText('DAMAGE PHOTOS · 1')).toBeInTheDocument();
    expect(screen.getByAltText('ext_front')).toHaveAttribute(
      'src',
      '/api/quoter/photo?id=walk-1',
    );
  });
});