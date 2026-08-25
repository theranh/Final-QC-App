import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

vi.mock('../lib/api', () => ({
  api: {
    putQuotePhoto: vi.fn(),
    deleteQuotePhoto: vi.fn(),
    quotePhotos: vi.fn(),
    intakePhotos: vi.fn(),
  },
}));

import { api } from '../lib/api';
import {
  captureReceipts,
  clearPhotoReceipts,
  pendingJobs,
  persistJob,
  removeJobsForPhoto,
  setCameraOpen,
} from '../lib/photoQueue';
import PhotoQueueIndicator from './PhotoQueueIndicator';

const capture = {
  key: 'Q-REOPEN_ext_front:before-close',
  id: 'Q-REOPEN_ext_front',
  quoteId: 'Q-REOPEN',
  slotKey: 'ext_front',
  role: 'walk',
  dataUrl: 'data:image/jpeg;base64,AAA',
  captureTs: 1_800_000_000_100,
};

beforeEach(async () => {
  vi.clearAllMocks();
  setCameraOpen(false);
  for (const queued of await pendingJobs()) await removeJobsForPhoto(queued.id, '__none__');
  const quoteIds = [...new Set((await captureReceipts()).map((receipt) => receipt.quoteId))];
  for (const quoteId of quoteIds) await clearPhotoReceipts(quoteId);
});

afterEach(cleanup);

describe('PhotoQueueIndicator app-start recovery', () => {
  it('resumes a durable upload from the previous session and confirms the server manifest', async () => {
    await persistJob(capture);
    api.putQuotePhoto.mockResolvedValue({});
    api.quotePhotos.mockResolvedValue({
      quoteId: capture.quoteId,
      photos: [{
        id: capture.id,
        slot: capture.slotKey,
        role: capture.role,
        ts: capture.captureTs,
      }],
    });

    render(<PhotoQueueIndicator />);

    expect(await screen.findByText('All queued photos are on the server ✓')).toBeInTheDocument();
    await waitFor(async () => expect(await pendingJobs(capture.quoteId)).toEqual([]));
    expect(await captureReceipts(capture.quoteId)).toEqual([
      expect.objectContaining({ id: capture.id, confirmedAt: expect.any(Number) }),
    ]);
  });
});