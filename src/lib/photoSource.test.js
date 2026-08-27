import { describe, expect, it } from 'vitest';
import { isPhotoReference, photoSourceUrl } from './photoSource';
import { isInlinePhotoDataUrl, isPhotoSource } from '../../shared/photoSource';

const ref = { ref: 'inspections/FQ-1001/0', mime: 'image/jpeg', sha256: 'a'.repeat(64) };

describe('photo source client compatibility', () => {
  it('leaves legacy data URLs untouched', () => {
    expect(photoSourceUrl('data:image/jpeg;base64,AA==')).toBe('data:image/jpeg;base64,AA==');
    expect(isInlinePhotoDataUrl('data:image/jpeg;base64,AA==')).toBe(true);
    expect(isPhotoSource('data:image/jpeg;base64,AA==')).toBe(true);
    expect(isPhotoSource('https://untrusted.example/photo.jpg')).toBe(false);
  });

  it('encodes strict private references for the authenticated gateway', () => {
    const url = photoSourceUrl(ref);
    expect(url.startsWith('/api/photos/')).toBe(true);
    expect(decodeURIComponent(url.slice('/api/photos/'.length))).not.toContain('/');
    expect(isPhotoReference(ref)).toBe(true);
    expect(isPhotoReference({ ...ref, extra: true })).toBe(false);
    expect(isPhotoReference({ ...ref, ref: '../private' })).toBe(false);
  });
});