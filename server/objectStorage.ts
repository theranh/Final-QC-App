import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import { Client, type RequestError, type Result } from "@replit/object-storage";

export type ObjectDigest = { bytes: number; sha256: string };

function storageError(operation: string, key: string, error: RequestError): Error {
  const status = error.statusCode == null ? "" : ` (HTTP ${error.statusCode})`;
  return new Error(`Object Storage ${operation} failed for ${key}${status}: ${error.message}`);
}

function unwrap<T>(result: Result<T, RequestError>, operation: string, key: string): T {
  if (!result.ok) throw storageError(operation, key, result.error);
  return result.value;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Adapter for the Replit app's default attached private bucket. The SDK does
 * not expose object metadata/checksums, so successful writes are not trusted:
 * every write is streamed back in full and checked for both length and SHA-256.
 */
export class AppObjectStorage {
  private readonly client: Client;

  constructor(client: Client = new Client()) {
    this.client = client;
  }

  openReadStream(key: string): Readable {
    return this.client.downloadAsStream(key, { decompress: false });
  }

  async readBytes(key: string): Promise<Buffer> {
    const value = unwrap(
      await this.client.downloadAsBytes(key, { decompress: false }),
      "download",
      key,
    );
    return value[0];
  }

  async digest(key: string): Promise<ObjectDigest> {
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of this.openReadStream(key)) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      hash.update(buffer);
    }
    return { bytes, sha256: hash.digest("hex") };
  }

  async verify(key: string, expected: ObjectDigest): Promise<ObjectDigest> {
    const actual = await this.digest(key);
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
      throw new Error(
        `Object Storage verification failed for ${key}: expected ${expected.bytes}/${expected.sha256}, got ${actual.bytes}/${actual.sha256}`,
      );
    }
    return actual;
  }

  async uploadVerified(key: string, contents: Buffer): Promise<ObjectDigest> {
    const expected = { bytes: contents.length, sha256: sha256(contents) };
    unwrap(
      await this.client.uploadFromBytes(key, contents, { compress: false }),
      "upload",
      key,
    );
    await this.verify(key, expected);
    return expected;
  }

  async delete(key: string): Promise<void> {
    unwrap(await this.client.delete(key, { ignoreNotFound: true }), "delete", key);
  }
}

export const objectStorage = new AppObjectStorage();