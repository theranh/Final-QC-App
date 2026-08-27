import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { Client } from "@replit/object-storage";
import { AppObjectStorage } from "./objectStorage";

function clientReturning(stream: PassThrough): Client {
  return {
    downloadAsStream: vi.fn(() => stream),
  } as unknown as Client;
}

describe("AppObjectStorage buffered reads", () => {
  it("rejects an asynchronous stream error without leaving it unhandled", async () => {
    const stream = new PassThrough();
    const storage = new AppObjectStorage(clientReturning(stream), 1_000);
    const read = storage.readBytes("photos/missing");
    queueMicrotask(() => stream.destroy(new Error("network disconnected")));

    await expect(read).rejects.toThrow("network disconnected");
    expect(stream.destroyed).toBe(true);
    expect(stream.listenerCount("error")).toBeGreaterThan(0);
  });

  it("destroys a stalled stream when the bounded read times out", async () => {
    const stream = new PassThrough();
    const storage = new AppObjectStorage(clientReturning(stream), 5);

    await expect(storage.readBytes("photos/stalled")).rejects.toThrow(
      "Object Storage download timed out for photos/stalled",
    );
    expect(stream.destroyed).toBe(true);
    expect(stream.listenerCount("error")).toBeGreaterThan(0);
  });
});