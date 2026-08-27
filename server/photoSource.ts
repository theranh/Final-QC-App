import type { Readable } from "node:stream";
import {
  isInlinePhotoDataUrl,
  isInspectionPhotoReference,
  isStoragePhotoReference,
  type PhotoSource,
  type StoragePhotoReference,
} from "@shared/photoSource";
import { objectStorage, type AppObjectStorage } from "./objectStorage";

export type StoredPhoto = {
  objectKey?: string | null;
  mime: string;
  data?: Buffer | Uint8Array | null;
  sha256?: string | null;
};

export type PhotoStorage = Pick<AppObjectStorage, "readBytes" | "openReadStream">;

/** Prefer the immutable private object, retaining bytea as an indefinite legacy fallback. */
export async function readStoredPhotoBytes(
  photo: StoredPhoto,
  storage: Pick<PhotoStorage, "readBytes"> = objectStorage,
): Promise<Buffer> {
  if (photo.objectKey) return storage.readBytes(photo.objectKey);
  if (photo.data == null) throw new Error("Photo has no readable source");
  return Buffer.isBuffer(photo.data) ? photo.data : Buffer.from(photo.data);
}

export function openStoredPhotoStream(
  photo: StoredPhoto,
  storage: Pick<PhotoStorage, "openReadStream"> = objectStorage,
): Readable | null {
  return photo.objectKey ? storage.openReadStream(photo.objectKey) : null;
}

/** Reads every supported persisted shape, with strict data-URL validation. */
export async function readPhotoSourceBytes(
  source: PhotoSource | StoredPhoto,
  storage: Pick<PhotoStorage, "readBytes"> = objectStorage,
): Promise<Buffer> {
  if (typeof source === "string") {
    if (!isInlinePhotoDataUrl(source)) throw new Error("Invalid inline photo data URL");
    const encoded = source.slice(source.indexOf(",") + 1);
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) {
      throw new Error("Invalid inline photo base64");
    }
    return bytes;
  }
  if (isStoragePhotoReference(source)) return storage.readBytes(source.ref);
  return readStoredPhotoBytes(source, storage);
}

export function inspectionReferenceFromEncoded(value: string): StoragePhotoReference | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return isInspectionPhotoReference(parsed) ? parsed : null;
  } catch {
    return null;
  }
}