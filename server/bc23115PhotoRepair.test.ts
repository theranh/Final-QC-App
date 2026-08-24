import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  BC23115_ORIENTATION_REPAIR,
  decodeBc23115Replacement,
  getBc23115RepairPhoto,
} from "./bc23115PhotoRepair";

async function jpegDataUrl(width: number, height: number): Promise<string> {
  const bytes = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 30, g: 60, b: 90 },
    },
  }).jpeg({ quality: 80 }).toBuffer();
  return `data:image/jpeg;base64,${bytes.toString("base64")}`;
}

function fakeJpegDataUrl(width: number, height: number): string {
  const bytes = Buffer.alloc(100_100);
  bytes.set([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
  ]);
  bytes[bytes.length - 2] = 0xff;
  bytes[bytes.length - 1] = 0xd9;
  return `data:image/jpeg;base64,${bytes.toString("base64")}`;
}

describe("BC23115 photo repair guard", () => {
  it("allowlists exactly the 26 inspected sideways captures", () => {
    expect(Object.keys(BC23115_ORIENTATION_REPAIR.photos)).toHaveLength(26);
    expect(getBc23115RepairPhoto("q1787579713855bpsg_ext_driver")).toMatchObject({
      slot: "ext_driver",
      expectedTs: 1787579737673,
    });
    for (const uprightId of [
      "w17875807274091clk",
      "w17875807274091clk_w",
      "q1787579713855bpsg_ext_fd_corner",
      "q1787579713855bpsg_x1787580771581sswz",
      "q1787579713855bpsg_x1787580799516w9es",
      "q1787579713855bpsg_x1787580812740fsno",
    ]) {
      expect(getBc23115RepairPhoto(uprightId)).toBeNull();
    }
  });

  it("accepts only a decodable JPEG with the inspected post-turn dimensions", async () => {
    const decoded = await decodeBc23115Replacement(await jpegDataUrl(1600, 1201));
    expect(decoded.width).toBe(1600);
    expect(decoded.height).toBe(1201);
  });

  it("rejects an unturned source frame", async () => {
    await expect(decodeBc23115Replacement(await jpegDataUrl(1201, 1600))).rejects.toThrow(
      "1600×1201",
    );
  });

  it("rejects non-JPEG and incomplete payloads", async () => {
    await expect(decodeBc23115Replacement("data:image/png;base64,AAAA")).rejects.toThrow(
      "JPEG data URL",
    );
    const incomplete = Buffer.alloc(100_100);
    incomplete.set([0xff, 0xd8]);
    await expect(decodeBc23115Replacement(
      `data:image/jpeg;base64,${incomplete.toString("base64")}`,
    )).rejects.toThrow("incomplete");
  });

  it("rejects a SOF/EOI-shaped buffer that is not a decodable JPEG", async () => {
    await expect(
      decodeBc23115Replacement(fakeJpegDataUrl(1600, 1201)),
    ).rejects.toThrow("cannot be decoded");
  });

  it("rejects PNG bytes falsely labeled as JPEG", async () => {
    const png = await sharp({
      create: {
        width: 1600,
        height: 1201,
        channels: 3,
        background: { r: 30, g: 60, b: 90 },
      },
    }).png().toBuffer();
    const mislabeled = Buffer.concat([png, Buffer.from([0xff, 0xd9])]);
    await expect(
      decodeBc23115Replacement(
        `data:image/jpeg;base64,${mislabeled.toString("base64")}`,
      ),
    ).rejects.toThrow("not a JPEG");
  });
});