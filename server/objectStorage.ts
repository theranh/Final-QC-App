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
  private readonly readTimeoutMs: number;

  constructor(client: Client = new Client(), readTimeoutMs = 60_000) {
    this.client = client;
    this.readTimeoutMs = readTimeoutMs;
  }

  openReadStream(key: string): Readable {
    const stream = this.client.downloadAsStream(key, { decompress: false });
    // The SDK can emit asynchronously after returning the stream. Consumers
    // still receive the error through iteration, while this listener ensures a
    // stream can never terminate the process as an unhandled EventEmitter error.
    stream.on("error", () => {});
    return stream;
  }

  async readBytes(key: string): Promise<Buffer> {
    const stream = this.openReadStream(key);
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stream.off("data", onData);
        stream.off("end", onEnd);
        stream.off("error", onError);
        if (error) reject(error);
        else resolve(Buffer.concat(chunks));
      };
      const onData = (chunk: Buffer | Uint8Array | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      };
      const onEnd = () => finish();
      const onError = (error: Error) => finish(error);
      const timer = setTimeout(() => {
        const error = new Error(`Object Storage download timed out for ${key}`);
        stream.destroy(error);
        finish(error);
      }, this.readTimeoutMs);
      stream.on("data", onData);
      stream.once("end", onEnd);
      stream.once("error", onError);
    });
  }

  async digest(key: string): Promise<ObjectDigest> {
    const contents = await this.readBytes(key);
    return { bytes: contents.length, sha256: sha256(contents) };
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