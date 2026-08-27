import { describe, expect, it } from "vitest";
import { readPhotoSourceBytes, readStoredPhotoBytes } from "./photoSource";

const storage = {
  readBytes: async (key: string) => Buffer.from(`object:${key}`),
};

describe("server photo source compatibility", () => {
  it("reads legacy data URLs without modifying their bytes", async () => {
    await expect(readPhotoSourceBytes("data:image/jpeg;base64,AAEC", storage)).resolves.toEqual(Buffer.from([0, 1, 2]));
  });

  it("reads object references through injected storage", async () => {
    await expect(readPhotoSourceBytes(
      { ref: "inspections/FQ-1/0", mime: "image/jpeg", sha256: "a".repeat(64) },
      storage,
    )).resolves.toEqual(Buffer.from("object:inspections/FQ-1/0"));
  });

  it("falls back to legacy bytea when no object key exists", async () => {
    await expect(readStoredPhotoBytes(
      { mime: "image/jpeg", data: Buffer.from([3, 4]) },
      storage,
    )).resolves.toEqual(Buffer.from([3, 4]));
  });
});