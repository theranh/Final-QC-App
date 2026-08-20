import { inferPhotoRole } from "../shared/photoRoles";

export type LegacyQuoterPhoto = {
  id: string;
  quote_id: string;
  slot: string | null;
  mime: string;
  data: Buffer;
  ts: number;
};

// Kept beside the one-time migration so the SQL and parameter order are tested
// together. Every copied row carries an explicit canonical role; it never
// relies on a database default.
export const LEGACY_PHOTO_INSERT_SQL =
  `INSERT INTO photos (id, quote_id, slot, role, mime, data, ts)
   VALUES ($1, $2, $3, $4, $5, $6, $7)
   ON CONFLICT (id) DO NOTHING`;

export function legacyPhotoInsertParams(photo: LegacyQuoterPhoto) {
  return [
    photo.id,
    photo.quote_id,
    photo.slot,
    inferPhotoRole(photo.slot),
    photo.mime,
    photo.data,
    photo.ts,
  ];
}