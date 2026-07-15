// Category and checklist definitions — must match the Truck Ranch Final QC design exactly.

export const CATS = [
  { k: 'mech', label: 'Mechanical', seg: 'MECH', color: '#6E6253' },
  { k: 'cosm', label: 'Cosmetic (P&B)', seg: 'COSM', color: '#9E3B2E' },
  { k: 'detail', label: 'Detail', seg: 'DETL', color: '#2F7D4F' },
  { k: 'bed', label: 'Bed Liner', seg: 'BEDL', color: '#8A6A3B' },
  { k: 'ceramic', label: 'Ceramic Coating', seg: 'CERM', color: '#B07A1E' },
  { k: 'under', label: 'Undercoating', seg: 'UNDR', color: '#4A4540' },
];

export const CHECKLIST = {
  mech: ['Cold start & idle', 'Brakes — pads & rotors', '4×4 engagement Hi/Lo', 'Fluid leaks', 'Dash warning lights', 'Tires & TPMS', 'HVAC heat & A/C', 'All exterior lights'],
  cosm: ['Panel paint match', 'Dents / PDR spots', 'Bumper condition', 'Wheel finish', 'Windshield chips'],
  detail: ['Interior surfaces', 'Glass & mirrors inside', 'Engine bay', 'Odor check', 'Carpets & mats'],
  bed: ['Coverage & thickness', 'Tailgate coverage', 'Overspray check'],
  ceramic: ['Water bead test', 'Gloss uniformity', 'High spots / streaks'],
  under: ['Frame coverage', 'Overspray on exhaust', 'Cured & dry'],
};

export const OPTIONAL_CATS = ['bed', 'ceramic', 'under'];

export const REQUIRE_PHOTO_ON_FAIL = true;
export const WEEK_STARTS_ON = 'Monday';

export const catByKey = (k) => CATS.find((c) => c.k === k);

export function chipStyle(k) {
  const c = catByKey(k) || { color: '#6E6253' };
  return {
    fontSize: '8px',
    fontWeight: 700,
    letterSpacing: '0.4px',
    color: '#fff',
    background: c.color,
    padding: '2px 6px',
    borderRadius: '4px',
    whiteSpace: 'nowrap',
    flex: '0 0 auto',
  };
}
