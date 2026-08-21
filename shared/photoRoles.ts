// The persisted role is authoritative. Slot-based inference exists solely to
// classify legacy rows and payloads from a PWA that has not updated yet.
export const PHOTO_ROLES = ["walk", "damage", "damage_wide", "unclassified"] as const;
export type PhotoRole = (typeof PHOTO_ROLES)[number];

const WALK_SLOT_KEY_LIST = [
  "ext_fd_corner", "ext_driver", "ext_rd_corner", "ext_rear", "ext_bed",
  "ext_rp_corner", "ext_passenger", "ext_fp_corner", "ext_front", "ext_roof",
  "int_driver", "int_dash", "int_console", "int_rear_d", "int_rear_p", "int_passenger",
  "whl_lf", "trd_lf", "whl_lr", "trd_lr", "whl_rr", "trd_rr", "whl_rf", "trd_rf",
];
const WALK_SLOT_KEYS = new Set(WALK_SLOT_KEY_LIST);
// Vehicle-list cards always prefer the front driver-corner intake photo.
// Remaining guided angles are fallback-only when that required shot is absent.
export const INTAKE_CARD_COVER_SLOT = "ext_fd_corner";

export function walkCoverRank(slot: unknown): number {
  const normalized = typeof slot === "string" ? slot.trim().toLowerCase() : "";
  if (normalized === INTAKE_CARD_COVER_SLOT) return 0;
  const fallbackIndex = WALK_SLOT_KEY_LIST.indexOf(normalized);
  return fallbackIndex < 0 ? -1 : fallbackIndex + 1;
}
const LEGACY_PANEL_DAMAGE_RE = new RegExp(
  `^(?:${WALK_SLOT_KEY_LIST.filter((key) => key.startsWith("ext_")).join("|")})_dmg$`,
);

export function isPhotoRole(value: unknown): value is PhotoRole {
  return typeof value === "string" && (PHOTO_ROLES as readonly string[]).includes(value);
}

export function inferPhotoRole(slot: unknown): PhotoRole {
  const normalized = typeof slot === "string" ? slot.trim().toLowerCase() : "";
  if (/^dmg_wide_[a-z0-9_-]+$/.test(normalized)) return "damage_wide";
  if (/^dmg(?:$|[_-]|\d)/.test(normalized) || LEGACY_PANEL_DAMAGE_RE.test(normalized)) return "damage";
  if (
    WALK_SLOT_KEYS.has(normalized) ||
    /^xtra_[a-z0-9]+$/.test(normalized) ||
    /^wa[0-9]+_[0-9]+$/.test(normalized)
  ) return "walk";
  return "unclassified";
}

export function photoRoleOf(photo: { role?: unknown; slot?: unknown }): PhotoRole {
  return isPhotoRole(photo?.role) ? photo.role : inferPhotoRole(photo?.slot);
}

// The declaration must agree with the canonical inference. Unknown legacy
// slots are accepted only as "unclassified", which preserves the image without
// allowing it into a meaningful gallery.
export function validPhotoRoleForSlot(role: unknown, slot: unknown): role is PhotoRole {
  return isPhotoRole(role) && inferPhotoRole(slot) === role;
}

export function photoUrl(photo: { id: unknown; ts?: unknown }): string {
  const id = encodeURIComponent(String(photo?.id || ""));
  const version = Number(photo?.ts);
  return `/api/quoter/photo?id=${id}${Number.isFinite(version) && version > 0 ? `&v=${version}` : ""}`;
}