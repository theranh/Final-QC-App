/** A persisted inspection photo is either a legacy data URL or a private object reference. */
export type StoragePhotoReference = { ref: string; mime: string; sha256: string };
export type PhotoSource = string | StoragePhotoReference;

const SHA256 = /^[a-f0-9]{64}$/i;
const MIME = /^image\/[a-z0-9.+-]+$/i;
const DATA_URL = /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]*={0,2}$/i;

export function isStoragePhotoReference(value: unknown): value is StoragePhotoReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  return (
    Object.keys(object).length === 3 &&
    typeof object.ref === "string" &&
    object.ref.length > 0 &&
    !object.ref.startsWith("/") &&
    !object.ref.includes("..") &&
    typeof object.mime === "string" &&
    MIME.test(object.mime) &&
    typeof object.sha256 === "string" &&
    SHA256.test(object.sha256)
  );
}

export function isPhotoSource(value: unknown): value is PhotoSource {
  return (typeof value === "string" && isInlinePhotoDataUrl(value)) || isStoragePhotoReference(value);
}

export function isInspectionPhotoReference(value: unknown): value is StoragePhotoReference {
  return isStoragePhotoReference(value) && value.ref.startsWith("inspections/");
}

export function isInlinePhotoDataUrl(value: unknown): value is string {
  return typeof value === "string" && DATA_URL.test(value);
}