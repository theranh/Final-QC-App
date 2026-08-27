import { sha256 } from "./objectStorage";

export type DataUrlAsset = {
  key: string;
  mime: string;
  bytes: Buffer;
  sha256: string;
};

export type StorageReference = { ref: string; mime: string; sha256: string };

const DATA_URL = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/;

function decodeDataUrl(value: string): { mime: string; bytes: Buffer } | null {
  const match = DATA_URL.exec(value);
  if (!match) return null;
  const bytes = Buffer.from(match[2], "base64");
  // Buffer's base64 decoder is permissive. Re-encoding prevents malformed
  // input from silently turning into different bytes.
  if (bytes.toString("base64").replace(/=+$/, "") !== match[2].replace(/=+$/, "")) {
    throw new Error("Invalid base64 data URL");
  }
  return { mime: match[1], bytes };
}

/**
 * Clones an inspection document and replaces vinPhoto and values in every
 * nested property named `photos` when those values are image data URLs.
 * Document-order enumeration makes zero-based object keys deterministic while
 * the clone preserves array order and every sibling field.
 */
export function planInspectionAssets(
  qcNumber: string,
  source: unknown,
): { data: unknown; assets: DataUrlAsset[] } {
  const assets: DataUrlAsset[] = [];
  let index = 0;

  const visit = (value: unknown, path: (string | number)[]): unknown => {
    if (Array.isArray(value)) return value.map((item, index) => visit(item, [...path, index]));
    if (!value || typeof value !== "object") return value;

    const output: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = [...path, name];
      if (name === "vinPhoto" && typeof child === "string") {
        output[name] = replace(child, childPath);
      } else if (name === "photos" && Array.isArray(child)) {
        output[name] = child.map((item, index) =>
          typeof item === "string" ? replace(item, [...childPath, index]) : visit(item, [...childPath, index]),
        );
      } else {
        output[name] = visit(child, childPath);
      }
    }
    return output;
  };

  const replace = (value: string, _path: (string | number)[]): string | StorageReference => {
    const decoded = decodeDataUrl(value);
    if (!decoded) return value;
    // The counter is intentionally document-global. Traversal follows stored
    // object property order and array order, so sibling arrays retain their
    // exact photo ordering while each asset gets one stable zero-based key.
    const key = `inspections/${qcNumber}/${index++}`;
    const digest = sha256(decoded.bytes);
    assets.push({ key, mime: decoded.mime, bytes: decoded.bytes, sha256: digest });
    return { ref: key, mime: decoded.mime, sha256: digest };
  };

  return { data: visit(source, []), assets };
}

export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => sameJson(value, b[index]))
    );
  }
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord).sort();
  const bKeys = Object.keys(bRecord).sort();
  return (
    aKeys.length === bKeys.length &&
    aKeys.every((key, index) => key === bKeys[index] && sameJson(aRecord[key], bRecord[key]))
  );
}