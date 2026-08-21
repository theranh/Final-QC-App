export const WALK_SLOTS = [
  ['ext_fd_corner', 'Exterior', 'Front · driver corner'], ['ext_driver', 'Exterior', 'Driver side'],
  ['ext_rd_corner', 'Exterior', 'Rear · driver corner'], ['ext_rear', 'Exterior', 'Rear'],
  ['ext_bed', 'Exterior', 'Bed'], ['ext_rp_corner', 'Exterior', 'Rear · passenger corner'],
  ['ext_passenger', 'Exterior', 'Passenger side'], ['ext_fp_corner', 'Exterior', 'Front · passenger corner'],
  ['ext_front', 'Exterior', 'Front'], ['ext_roof', 'Exterior', 'Roof'],
  ['whl_lf', 'Wheels / tires', 'Left front wheel'], ['trd_lf', 'Wheels / tires', 'Left front tire'],
  ['whl_lr', 'Wheels / tires', 'Left rear wheel'], ['trd_lr', 'Wheels / tires', 'Left rear tire'],
  ['whl_rr', 'Wheels / tires', 'Right rear wheel'], ['trd_rr', 'Wheels / tires', 'Right rear tire'],
  ['whl_rf', 'Wheels / tires', 'Right front wheel'], ['trd_rf', 'Wheels / tires', 'Right front tire'],
  ['int_driver', 'Interior', 'Driver seat'], ['int_dash', 'Interior', 'Dash'],
  ['int_console', 'Interior', 'Center console'], ['int_rear_d', 'Interior', 'Rear seat · driver side'],
  ['int_rear_p', 'Interior', 'Rear seat · passenger side'], ['int_passenger', 'Interior', 'Passenger seat'],
].map(([key, group, label]) => ({ key, group, label }));

export function nextUntakenSlot(slots, taken, from = 0) {
  for (let i = Math.max(0, from); i < slots.length; i += 1) if (!taken[slots[i].key]) return i;
  for (let i = 0; i < Math.max(0, from); i += 1) if (!taken[slots[i].key]) return i;
  return -1;
}
export function walkProgress(slots, taken, skipped = {}) {
  const captured = slots.filter((s) => !!taken[s.key]).length;
  const skippedCount = slots.filter((s) => !taken[s.key] && !!skipped[s.key]).length;
  return { captured, skipped: skippedCount, total: slots.length, complete: captured + skippedCount === slots.length };
}
export function putSlotPhoto(photos, slot, photo) {
  return { ...photos, [slot]: photo };
}