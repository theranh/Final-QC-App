import {
  isInlinePhotoDataUrl,
  isInspectionPhotoReference,
  isStoragePhotoReference,
  type PhotoSource,
  type StoragePhotoReference,
} from "@shared/photoSource";
import { objectStorage, sha256, type AppObjectStorage } from "./objectStorage";

export type StoredPhoto = {
  id?: string | number | null;
  objectKey?: string | null;
  mime: string;
  data?: Buffer | Uint8Array | null;
  sha256?: string | null;
};

export type PhotoStorage = Pick<AppObjectStorage, "readBytes">;
export type PhotoReadFallback = Buffer | Uint8Array | (() => Buffer | Uint8Array | Promise<Buffer | Uint8Array>);
export type PhotoReadOptions = {
  photoId?: string | number | null;
  fallback?: PhotoReadFallback;
};

function asBuffer(value: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

async function resolveFallback(fallback: PhotoReadFallback): Promise<Buffer> {
  return asBuffer(typeof fallback === "function" ? await fallback() : fallback);
}

async function readObjectWithFallback(
  objectKey: string,
  expectedSha256: string | null | undefined,
  fallback: PhotoReadFallback | null | undefined,
  photoId: string | number | null | undefined,
  storage: PhotoStorage,
): Promise<Buffer> {
  try {
    const bytes = await storage.readBytes(objectKey);
    const authoritativeSha256 =
      expectedSha256 || (fallback && typeof fallback !== "function" ? sha256(asBuffer(fallback)) : null);
    if (authoritativeSha256 && sha256(bytes) !== authoritativeSha256) {
      throw new Error(`downloaded SHA-256 does not match ${authoritativeSha256}`);
    }
    return bytes;
  } catch (error) {
    console.error("Object Storage photo read failed; falling back to PostgreSQL", {
      objectKey,
      photoId: photoId == null ? "unknown" : String(photoId),
      error: error instanceof Error ? error.message : String(error),
    });
    if (!fallback) throw error;
    return resolveFallback(fallback);
  }
}

/** Prefer the immutable private object, retaining bytea as an indefinite fallback. */
export async function readStoredPhotoBytes(
  photo: StoredPhoto,
  storage: PhotoStorage = objectStorage,
): Promise<Buffer> {
  if (photo.objectKey) {
    return readObjectWithFallback(
      photo.objectKey,
      photo.sha256,
      photo.data == null ? null : photo.data,
      photo.id,
      storage,
    );
  }
  if (photo.data == null) throw new Error("Photo has no readable source");
  return asBuffer(photo.data);
}

/** Reads every supported persisted shape, with strict data-URL validation. */
export async function readPhotoSourceBytes(
  source: PhotoSource | StoredPhoto,
  storage: PhotoStorage = objectStorage,
  options: PhotoReadOptions = {},
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
  if (isStoragePhotoReference(source)) {
    return readObjectWithFallback(
      source.ref,
      source.sha256,
      options.fallback,
      options.photoId,
      storage,
    );
  }
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