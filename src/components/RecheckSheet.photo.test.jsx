import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CATS } from '../lib/constants';
import RecheckSheet from './RecheckSheet';

vi.mock('./SignaturePad', () => ({ default: () => <div /> }));
vi.mock('./VoiceNoteButton', () => ({ default: () => null }));

afterEach(cleanup);

describe('RecheckSheet photo enlargement', () => {
  it('enlarges a newly captured re-check photo instead of removing it', () => {
    const onOpenLightbox = vi.fn();
    const onRemovePhoto = vi.fn();
    render(
      <RecheckSheet
        record={{
          id: 'FQ-1',
          stock: 'T-1',
          vehicle: 'Truck',
          ts: Date.now(),
          inspector: 'Inspector',
          openItems: [{
            cat: CATS[0].k,
            item: 'Panel fit',
            note: 'Original failure',
            photos: [],
          }],
        }}
        users={[{ id: 1, name: 'Inspector', title: 'QC' }]}
        rcUid={1}
        onSetRcUid={() => {}}
        marks={{ 'rc|0': 'f' }}
        notes={{ 'rc|0': 'Still failed' }}
        photosMap={{ 'rc|0': ['/new-recheck-photo.jpg'] }}
        repairs={{}}
        onMark={() => {}}
        onNote={() => {}}
        onRepair={() => {}}
        onTakePhoto={() => {}}
        onRemovePhoto={onRemovePhoto}
        sigRef={{ current: null }}
        sigSigned={false}
        onSigChange={() => {}}
        onClearSig={() => {}}
        onClose={() => {}}
        onCommit={() => {}}
        onOpenLightbox={onOpenLightbox}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Enlarge photo 1' }));
    expect(onOpenLightbox).toHaveBeenCalledWith('/new-recheck-photo.jpg');
    expect(onRemovePhoto).not.toHaveBeenCalled();
  });
});