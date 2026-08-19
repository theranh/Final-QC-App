// Tests for the FieldReadiness preflight component.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';

// Mock photoQueue so we don't need real IndexedDB in these tests.
vi.mock('../lib/photoQueue', () => ({
  probePersistence: vi.fn().mockResolvedValue(true),
  pendingJobs: vi.fn().mockResolvedValue([]),
}));

// Mock fieldCapabilities.getReadiness so each test can control readiness.
vi.mock('../lib/fieldCapabilities', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, getReadiness: vi.fn() };
});

import { getReadiness } from '../lib/fieldCapabilities';
import FieldReadiness from './FieldReadiness';

function okReadiness() {
  return {
    cameraSupported: true,
    nativeBarcode: false,
    speechSupported: false,
    online: true,
    persistenceOk: true,
    storagePersistence: 'persistent',
    queuedUploads: 0,
  };
}

describe('FieldReadiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
  });

  it('renders a loading state before getReadiness resolves', () => {
    getReadiness.mockReturnValue(new Promise(() => {})); // never resolves
    render(<FieldReadiness onContinue={() => {}} onCancel={() => {}} />);
    expect(screen.getByText(/checking/i)).toBeInTheDocument();
  });

  it('shows camera supported when camera API is available', async () => {
    getReadiness.mockResolvedValue(okReadiness());
    render(<FieldReadiness onContinue={() => {}} onCancel={() => {}} />);
    await waitFor(() => expect(screen.getByText(/supported/i)).toBeInTheDocument());
    expect(screen.getByText(/Camera API/i)).toBeInTheDocument();
  });

  it('shows online status', async () => {
    getReadiness.mockResolvedValue(okReadiness());
    render(<FieldReadiness onContinue={() => {}} onCancel={() => {}} />);
    await waitFor(() => expect(screen.getByText(/online/i)).toBeInTheDocument());
  });

  it('shows queue readiness as Ready when persistenceOk=true', async () => {
    getReadiness.mockResolvedValue(okReadiness());
    render(<FieldReadiness onContinue={() => {}} onCancel={() => {}} />);
    // "Ready" appears in the local photo queue row once the readiness resolves.
    await waitFor(() => expect(screen.getAllByText(/\bReady\b/).length).toBeGreaterThan(0));
  });

  it('shows a warning when offline', async () => {
    getReadiness.mockResolvedValue({ ...okReadiness(), online: false });
    render(<FieldReadiness onContinue={() => {}} onCancel={() => {}} />);
    await waitFor(() =>
      expect(screen.getByText(/offline/i)).toBeInTheDocument()
    );
  });

  it('shows a private-mode warning when persistenceOk=false', async () => {
    getReadiness.mockResolvedValue({ ...okReadiness(), persistenceOk: false });
    render(<FieldReadiness onContinue={() => {}} onCancel={() => {}} />);
    await waitFor(() =>
      expect(screen.getByText(/private mode/i)).toBeInTheDocument()
    );
  });

  it('shows pending uploads count when queuedUploads > 0', async () => {
    getReadiness.mockResolvedValue({ ...okReadiness(), queuedUploads: 3 });
    render(<FieldReadiness onContinue={() => {}} onCancel={() => {}} />);
    await waitFor(() => expect(screen.getByText(/3/)).toBeInTheDocument());
    expect(screen.getByText(/uploading/i)).toBeInTheDocument();
  });

  it('Continue is always enabled — degraded readiness does not block it', async () => {
    getReadiness.mockResolvedValue({
      cameraSupported: false,
      online: false,
      persistenceOk: false,
      storagePersistence: 'best-effort',
      queuedUploads: 5,
    });
    const onContinue = vi.fn();
    render(<FieldReadiness onContinue={onContinue} onCancel={() => {}} />);
    const btn = await waitFor(() => screen.getByRole('button', { name: /Continue/i }));
    fireEvent.click(btn);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('Cancel calls onCancel', async () => {
    getReadiness.mockResolvedValue(okReadiness());
    const onCancel = vi.fn();
    render(<FieldReadiness onContinue={() => {}} onCancel={onCancel} />);
    const btn = await waitFor(() => screen.getByRole('button', { name: /^Cancel$/i }));
    fireEvent.click(btn);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Continue fires onContinue on green readiness', async () => {
    getReadiness.mockResolvedValue(okReadiness());
    const onContinue = vi.fn();
    render(<FieldReadiness onContinue={onContinue} onCancel={() => {}} />);
    const btn = await waitFor(() => screen.getByRole('button', { name: /Continue/i }));
    fireEvent.click(btn);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('is a labelled keyboard modal, focuses Continue, and Escape cancels', async () => {
    getReadiness.mockResolvedValue(okReadiness());
    const onCancel = vi.fn();
    render(<FieldReadiness onContinue={() => {}} onCancel={onCancel} />);

    const dialog = screen.getByRole('dialog', { name: /camera readiness check/i });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const continueButton = screen.getByRole('button', { name: /Continue/i });
    await waitFor(() => expect(continueButton).toHaveFocus());

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('wraps Tab focus within the readiness controls', async () => {
    getReadiness.mockResolvedValue(okReadiness());
    render(<FieldReadiness onContinue={() => {}} onCancel={() => {}} />);
    const cancel = screen.getByRole('button', { name: /^Cancel$/i });
    const continueButton = screen.getByRole('button', { name: /Continue/i });
    await waitFor(() => expect(continueButton).toHaveFocus());

    fireEvent.keyDown(document, { key: 'Tab' });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(continueButton).toHaveFocus();
  });

  it('does not throw when getReadiness rejects (graceful degradation)', async () => {
    getReadiness.mockRejectedValue(new Error('network error'));
    // Render must not throw even when the readiness check fails.
    expect(() =>
      render(<FieldReadiness onContinue={() => {}} onCancel={() => {}} />)
    ).not.toThrow();
  });
});
