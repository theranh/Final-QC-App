import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import useAppUpdate from './useAppUpdate';

function serviceWorkerContainer(controller) {
  const listeners = new Map();
  return {
    controller,
    addEventListener: vi.fn((event, listener) => listeners.set(event, listener)),
    removeEventListener: vi.fn((event, listener) => {
      if (listeners.get(event) === listener) listeners.delete(event);
    }),
    dispatchControllerChange() {
      listeners.get('controllerchange')?.();
    },
  };
}

describe('useAppUpdate', () => {
  let serviceWorker;
  let updateSW;
  let registerOptions;

  beforeEach(() => {
    vi.useFakeTimers();
    updateSW = vi.fn();
    registerOptions = null;
    globalThis.__pwaRegisterSWMock = vi.fn((options) => {
      registerOptions = options;
      return updateSW;
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    delete globalThis.__pwaRegisterSWMock;
    document.body.innerHTML = '';
  });

  function mountWithController(controller) {
    serviceWorker = serviceWorkerContainer(controller);
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: serviceWorker,
    });
    return renderHook(() => useAppUpdate());
  }

  it('preserves first-install behavior when the first worker takes control', () => {
    const { result } = mountWithController(null);

    act(() => serviceWorker.dispatchControllerChange());

    expect(result.current.updateReady).toBe(false);
    expect(updateSW).not.toHaveBeenCalled();
  });

  it('offers refresh without reloading when a worker replaces an idle Vehicles-like page', () => {
    const { result } = mountWithController({});
    document.body.innerHTML = '<main data-screen="vehicles">Vehicles</main>';

    act(() => serviceWorker.dispatchControllerChange());

    expect(result.current.updateReady).toBe(true);
  });

  it.each([
    ['an active form', '<form><input autofocus /></form>'],
    ['a dialog', '<dialog open>Editing</dialog>'],
    ['a camera', '<video autoplay></video>'],
  ])('offers refresh without reloading during %s', (_label, markup) => {
    const { result } = mountWithController({});
    document.body.innerHTML = markup;
    document.querySelector('input')?.focus();

    act(() => serviceWorker.dispatchControllerChange());

    expect(result.current.updateReady).toBe(true);
  });

  it('applies an update only after the user invokes the refresh action', () => {
    const { result } = mountWithController({});

    act(() => registerOptions.onNeedRefresh());
    expect(result.current.updateReady).toBe(true);
    expect(updateSW).not.toHaveBeenCalled();

    act(() => result.current.applyUpdate());
    expect(updateSW).toHaveBeenCalledWith(true);
  });
});