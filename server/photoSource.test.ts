import { describe, expect, it, vi } from "vitest";
import { readPhotoSourceBytes, readStoredPhotoBytes } from "./photoSource";
import { sha256 } from "./objectStorage";

const storage = {
  readBytes: async (key: string) => Buffer.from(`object:${key}`),
};

describe("server photo source compatibility", () => {
  it("reads legacy data URLs without modifying their bytes", async () => {
    await expect(readPhotoSourceBytes("data:image/jpeg;base64,AAEC", storage)).resolves.toEqual(Buffer.from([0, 1, 2]));
  });

  it("reads object references through injected storage", async () => {
    const bytes = Buffer.from("object:inspections/FQ-1/0");
    await expect(readPhotoSourceBytes(
      { ref: "inspections/FQ-1/0", mime: "image/jpeg", sha256: sha256(bytes) },
      storage,
    )).resolves.toEqual(bytes);
  });

  it("falls back to legacy bytea when no object key exists", async () => {
    await expect(readStoredPhotoBytes(
      { mime: "image/jpeg", data: Buffer.from([3, 4]) },
      storage,
    )).resolves.toEqual(Buffer.from([3, 4]));
  });

  it("falls back to PostgreSQL and remains usable after a nonexistent object", async () => {
    const fallback = Buffer.from([3, 4, 5]);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const failingStorage = {
      readBytes: vi.fn().mockRejectedValueOnce(new Error("404: No such object")).mockResolvedValueOnce(fallback),
    };

    await expect(readStoredPhotoBytes(
      {
        id: "photo-404",
        mime: "image/jpeg",
        data: fallback,
        objectKey: "photos/missing",
        sha256: "a".repeat(64),
      },
      failingStorage,
    )).resolves.toEqual(fallback);
    await expect(readStoredPhotoBytes(
      {
        id: "photo-after-failure",
        mime: "image/jpeg",
        data: fallback,
        objectKey: "photos/healthy",
        sha256: "a".repeat(64),
      },
      failingStorage,
    )).resolves.toEqual(fallback);

    expect(consoleError).toHaveBeenCalledWith(
      "Object Storage photo read failed; falling back to PostgreSQL",
      expect.objectContaining({ objectKey: "photos/missing", photoId: "photo-404" }),
    );
    consoleError.mockRestore();
  });

  it("falls back on network errors and truncated or zero-byte objects", async () => {
    const fallback = Buffer.from("postgres-bytes");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const networkFailure = { readBytes: vi.fn().mockRejectedValue(new Error("ECONNRESET")) };
    const zeroByteObject = { readBytes: vi.fn().mockResolvedValue(Buffer.alloc(0)) };
    const photo = {
      id: "photo-network",
      mime: "image/jpeg",
      data: fallback,
      objectKey: "photos/unavailable",
      sha256: "0".repeat(64),
    };

    await expect(readStoredPhotoBytes(photo, networkFailure)).resolves.toEqual(fallback);
    await expect(readStoredPhotoBytes(
      { ...photo, id: "photo-empty", objectKey: "photos/empty" },
      zeroByteObject,
    )).resolves.toEqual(fallback);
    expect(consoleError).toHaveBeenCalledTimes(2);
    consoleError.mockRestore();
  });
});