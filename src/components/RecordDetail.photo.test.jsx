import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CATS } from '../lib/constants';
import RecordDetail from './RecordDetail';

vi.mock('./ActivityTimeline', () => ({ default: () => null }));

afterEach(cleanup);

describe('RecordDetail desktop photo access', () => {
  it('exposes VIN, failure, and re-check photos as keyboard-accessible buttons', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
    const items = Object.fromEntries(CATS.map((category) => [category.k, []]));
    items[CATS[0].k] = [{
      item: 'Panel fit',
      mark: 'f',
      note: 'Needs adjustment',
      photos: ['/failure.jpg'],
    }];
    const onOpenLightbox = vi.fn();
    render(
      <RecordDetail
        record={{
          id: 'FQ-1200',
          stock: 'T-1200',
          vehicle: '2025 Truck',
          vin: '1GTUUCED3RZ336835',
          vinPhoto: '/vin.jpg',
          status: 'cleared',
          inspector: 'Inspector',
          title: 'QC',
          checked: 1,
          ts: Date.now(),
          items,
          rechecks: [{
            ts: Date.now(),
            inspector: 'Inspector',
            title: 'QC',
            sig: null,
            items: [{
              cat: CATS[0].k,
              item: 'Panel fit',
              outcome: 'fail',
              note: 'Still open',
              photos: ['/recheck.jpg'],
            }],
          }],
        }}
        onBack={() => {}}
        onStartRecheck={() => {}}
        onOpenLightbox={onOpenLightbox}
      />,
    );

    const vin = screen.getByRole('button', { name: 'Enlarge VIN label photo' });
    const failure = screen.getByRole('button', { name: 'Enlarge failure photo 1' });
    const recheck = screen.getByRole('button', { name: 'Enlarge re-check photo 1' });
    expect(vin).toHaveAttribute('type', 'button');
    expect(failure).toHaveAttribute('type', 'button');
    expect(recheck).toHaveAttribute('type', 'button');
    fireEvent.click(vin);
    fireEvent.click(failure);
    fireEvent.click(recheck);
    expect(onOpenLightbox.mock.calls.map(([src]) => src)).toEqual(['/vin.jpg', '/failure.jpg', '/recheck.jpg']);
  });
});