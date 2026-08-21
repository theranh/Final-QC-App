import { describe, expect, it } from 'vitest';
import {
  INTAKE_CARD_COVER_SLOT,
  inferPhotoRole,
  photoRoleOf,
  photoUrl,
  validPhotoRoleForSlot,
  walkCoverRank,
} from '../../shared/photoRoles';

describe('photo role metadata', () => {
  it('classifies legacy slot conventions case-insensitively without mixing unknown rows', () => {
    expect(inferPhotoRole('EXT_FRONT')).toBe('walk');
    expect(inferPhotoRole('xtra_171234abc')).toBe('walk');
    expect(inferPhotoRole('DMG171234')).toBe('damage');
    expect(inferPhotoRole('dmg_wide_closeup-1')).toBe('damage_wide');
    expect(inferPhotoRole('ext_driver_dmg')).toBe('damage');
    expect(inferPhotoRole('wa1785157071621_0001')).toBe('walk');
    expect(inferPhotoRole('mystery_slot')).toBe('unclassified');
    expect(inferPhotoRole('ext_front_unknown')).toBe('unclassified');
    expect(inferPhotoRole('xtra_')).toBe('unclassified');
  });

  it('prefers a persisted server role over slot inference', () => {
    expect(photoRoleOf({ role: 'damage', slot: 'ext_front' })).toBe('damage');
  });

  it('requires incoming role and slot to agree', () => {
    expect(validPhotoRoleForSlot('walk', 'ext_front')).toBe(true);
    expect(validPhotoRoleForSlot('damage', 'dmg_door')).toBe(true);
    expect(validPhotoRoleForSlot('damage_wide', 'dmg_wide_closeup-1')).toBe(true);
    expect(validPhotoRoleForSlot('walk', 'dmg_door')).toBe(false);
    expect(validPhotoRoleForSlot('unclassified', 'mystery')).toBe(true);
    expect(validPhotoRoleForSlot('walk', 'ext_front_unknown')).toBe(false);
  });

  it('versions image URLs from manifest timestamps', () => {
    expect(photoUrl({ id: 'p 1', ts: 123 })).toBe('/api/quoter/photo?id=p%201&v=123');
  });

  it('always ranks Front · driver corner as the intake vehicle-card cover', () => {
    expect(INTAKE_CARD_COVER_SLOT).toBe('ext_fd_corner');
    expect(walkCoverRank('ext_fd_corner')).toBe(0);
    expect(walkCoverRank('ext_driver')).toBeGreaterThan(0);
    expect(walkCoverRank('dmg')).toBe(-1);
    expect(walkCoverRank('xtra_123')).toBe(-1);
  });
});