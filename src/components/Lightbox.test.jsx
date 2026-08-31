import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import Lightbox from './Lightbox';
import PhotoButton from './PhotoButton';

function Harness({ actions = false }) {
  const [src, setSrc] = useState(null);
  return (
    <>
      <PhotoButton src="/photo.jpg" alt="VIN label" onOpen={setSrc} imageStyle={{ width: 80 }} />
      <Lightbox src={src} alt="VIN label enlarged" onClose={() => setSrc(null)}>
        {actions && <button type="button">Rotate</button>}
      </Lightbox>
    </>
  );
}

describe('Lightbox', () => {
  afterEach(cleanup);
  it('opens from an accessible photo button and does not close when the image is clicked', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Enlarge VIN label' }));
    const dialog = screen.getByRole('dialog', { name: 'Photo viewer' });
    expect(dialog).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByAltText('VIN label enlarged'));
    expect(dialog).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close photo viewer' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes with Escape and returns focus to the originating thumbnail', () => {
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Enlarge VIN label' });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole('button', { name: 'Close photo viewer' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('closes from the backdrop and traps Tab within viewer actions', () => {
    render(<Harness actions />);
    fireEvent.click(screen.getByRole('button', { name: 'Enlarge VIN label' }));
    const close = screen.getByRole('button', { name: 'Close photo viewer' });
    const rotate = screen.getByRole('button', { name: 'Rotate' });
    rotate.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(close).toHaveFocus();
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});