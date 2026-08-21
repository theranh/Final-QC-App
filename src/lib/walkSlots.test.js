import { describe, expect, it } from 'vitest';
import { WALK_SLOTS, nextUntakenSlot, putSlotPhoto, walkProgress } from './walkSlots';
describe('walk slot state', () => {
  it('follows the shop route: exterior, wheels and tires, then interior', () => {
    expect(WALK_SLOTS.slice(0, 10).every((slot) => slot.group === 'Exterior')).toBe(true);
    expect(WALK_SLOTS.slice(10, 18).every((slot) => slot.group === 'Wheels / tires')).toBe(true);
    expect(WALK_SLOTS.slice(18).every((slot) => slot.group === 'Interior')).toBe(true);
    expect(WALK_SLOTS[10].key).toBe('whl_lf');
    expect(WALK_SLOTS[18].key).toBe('int_driver');
  });

  it('advances to the next untaken slot and wraps', () => {
    const taken = { [WALK_SLOTS[0].key]: true, [WALK_SLOTS[1].key]: true };
    expect(nextUntakenSlot(WALK_SLOTS, taken, 0)).toBe(2);
    expect(nextUntakenSlot(WALK_SLOTS, { [WALK_SLOTS[0].key]: true }, 23)).toBe(23);
  });
  it('counts skipped slots as complete without pretending they are captured', () => {
    const skipped = { [WALK_SLOTS[0].key]: true };
    expect(walkProgress(WALK_SLOTS, {}, skipped)).toMatchObject({ captured: 0, skipped: 1, complete: false });
  });
  it('retake replaces the same stable slot key', () => {
    const one = putSlotPhoto({}, 'ext_front', { id: 'q_ext_front', thumb: 'a' });
    expect(putSlotPhoto(one, 'ext_front', { id: 'q_ext_front', thumb: 'b' }).ext_front.thumb).toBe('b');
  });
});