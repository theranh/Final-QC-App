import sharp from "sharp";

export const BC23115_ORIENTATION_REPAIR = {
  repairKey: "bc23115-sideways-walkaround-v1",
  stock: "BC23115",
  intakeId: "in1787579708919w0kg",
  quoteId: "q1787579713855bpsg",
  direction: "left",
  photos: {
    q1787579713855bpsg_ext_driver: { slot: "ext_driver", expectedTs: 1787579737673 },
    q1787579713855bpsg_ext_rd_corner: { slot: "ext_rd_corner", expectedTs: 1787579747283 },
    q1787579713855bpsg_ext_rear: { slot: "ext_rear", expectedTs: 1787579756852 },
    q1787579713855bpsg_ext_bed: { slot: "ext_bed", expectedTs: 1787579766040 },
    q1787579713855bpsg_ext_rp_corner: { slot: "ext_rp_corner", expectedTs: 1787579776061 },
    q1787579713855bpsg_ext_passenger: { slot: "ext_passenger", expectedTs: 1787579788120 },
    q1787579713855bpsg_ext_fp_corner: { slot: "ext_fp_corner", expectedTs: 1787579796959 },
    q1787579713855bpsg_ext_front: { slot: "ext_front", expectedTs: 1787579806360 },
    q1787579713855bpsg_ext_roof: { slot: "ext_roof", expectedTs: 1787579811129 },
    q1787579713855bpsg_whl_lf: { slot: "whl_lf", expectedTs: 1787579826317 },
    q1787579713855bpsg_trd_lf: { slot: "trd_lf", expectedTs: 1787579849492 },
    q1787579713855bpsg_whl_lr: { slot: "whl_lr", expectedTs: 1787579852897 },
    q1787579713855bpsg_trd_lr: { slot: "trd_lr", expectedTs: 1787579859337 },
    q1787579713855bpsg_whl_rr: { slot: "whl_rr", expectedTs: 1787579862136 },
    q1787579713855bpsg_trd_rr: { slot: "trd_rr", expectedTs: 1787579869825 },
    q1787579713855bpsg_whl_rf: { slot: "whl_rf", expectedTs: 1787579872642 },
    q1787579713855bpsg_trd_rf: { slot: "trd_rf", expectedTs: 1787579880366 },
    q1787579713855bpsg_int_driver: { slot: "int_driver", expectedTs: 1787579883726 },
    q1787579713855bpsg_int_dash: { slot: "int_dash", expectedTs: 1787579904378 },
    q1787579713855bpsg_int_console: { slot: "int_console", expectedTs: 1787579910692 },
    q1787579713855bpsg_int_rear_d: { slot: "int_rear_d", expectedTs: 1787579920425 },
    q1787579713855bpsg_int_rear_p: { slot: "int_rear_p", expectedTs: 1787579929465 },
    q1787579713855bpsg_int_passenger: { slot: "int_passenger", expectedTs: 1787579942350 },
    q1787579713855bpsg_x1787579959657isur: {
      slot: "xtra_1787579959657isur",
      expectedTs: 1787579959657,
    },
    q1787579713855bpsg_x17875799786918vbe: {
      slot: "xtra_17875799786918vbe",
      expectedTs: 1787579978691,
    },
    q1787579713855bpsg_x17875799907127wwy: {
      slot: "xtra_17875799907127wwy",
      expectedTs: 1787579990712,
    },
  },
} as const;

export type Bc23115RepairPhoto = {
  id: keyof typeof BC23115_ORIENTATION_REPAIR.photos;
  slot: string;
  expectedTs: number;
};

export function getBc23115RepairPhoto(id: string): Bc23115RepairPhoto | null {
  const photos = BC23115_ORIENTATION_REPAIR.photos;
  if (!Object.prototype.hasOwnProperty.call(photos, id)) return null;
  const photo = photos[id as keyof typeof photos];
  return { id: id as keyof typeof photos, ...photo };
}

export async function decodeJpegDataUrl(dataUrl: unknown): Promise<{
  bytes: Buffer;
  width: number;
  height: number;
}> {
  if (typeof dataUrl !== "string") throw new Error("Replacement JPEG is required");
  const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) throw new Error("Replacement must be a JPEG data URL");
  const bytes = Buffer.from(match[1], "base64");
  if (bytes.length < 1_000 || bytes.length > 2_000_000) {
    throw new Error("Replacement JPEG size is outside the repair bounds");
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error("Replacement bytes are not a JPEG");
  }
  if (bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
    throw new Error("Replacement JPEG is incomplete");
  }
  let decoded: { info: { width: number; height: number } };
  try {
    const image = sharp(bytes, { failOn: "error" });
    const metadata = await image.metadata();
    if (metadata.format !== "jpeg") throw new Error("not jpeg");
    decoded = await image
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new Error("Replacement JPEG cannot be decoded");
  }
  const { width, height } = decoded.info;
  return { bytes, width, height };
}

export async function decodeBc23115Replacement(dataUrl: unknown): Promise<{
  bytes: Buffer;
  width: number;
  height: number;
}> {
  const decoded = await decodeJpegDataUrl(dataUrl);
  const { width, height } = decoded;
  if (width !== 1600 || height !== 1201) {
    throw new Error("Replacement JPEG must be the inspected 1600×1201 left-turned frame");
  }
  return decoded;
}

export type PhotoTurn = "left" | "right" | "180";

export async function rotateStoredJpeg(
  bytes: Buffer,
  direction: PhotoTurn,
): Promise<{ bytes: Buffer; width: number; height: number; sourceWidth: number; sourceHeight: number }> {
  if (bytes.length < 1_000 || bytes.length > 2_000_000) {
    throw new Error("Stored JPEG size is outside the repair bounds");
  }
  const image = sharp(bytes, {
    failOn: "error",
    limitInputPixels: 40_000_000,
  });
  const metadata = await image.metadata();
  if (
    metadata.format !== "jpeg"
    || !metadata.width
    || !metadata.height
    || metadata.width > 8_000
    || metadata.height > 8_000
    || metadata.width * metadata.height > 40_000_000
  ) {
    throw new Error("Stored photo is not a bounded JPEG");
  }

  const angle = direction === "left" ? -90 : direction === "right" ? 90 : 180;
  const output = await image
    .autoOrient()
    .rotate(angle)
    .jpeg({ quality: 80 })
    .toBuffer({ resolveWithObject: true });
  if (output.info.format !== "jpeg") throw new Error("Rotated output is not a JPEG");
  return {
    bytes: output.data,
    width: output.info.width,
    height: output.info.height,
    sourceWidth: metadata.autoOrient.width,
    sourceHeight: metadata.autoOrient.height,
  };
}