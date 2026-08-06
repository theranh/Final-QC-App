// Google Sheets export — when an inspection PASSES final QC (either outright,
// or after a re-check clears every failed item), fills the next empty
// pre-formatted vehicle row on the matching monthly tab (e.g. "Jul 2026") of
// the VPC Production Tracker. Uses a Google service account (secret:
// GOOGLE_SERVICE_ACCOUNT_JSON) that the spreadsheet is shared with, plus
// GOOGLE_SHEETS_SPREADSHEET_ID.
//
// Tracker layout (row 20 is the table header):
//   A: VIN                B: RO Open Date       C: Completed Date
//   D: Picture Received   E: Retail Plan $      F: Closed RO $
//   G–J: sheet formulas   K: Mechanic           L: Paint & Body
//   M: Detail             N: Undercoat          O: Bedliner
//   P: QC Result (sheet formula)                Q: Notes
// The app only fills A, C, D, K–O, and Q. It NEVER writes G–J or P (those hold
// the sheet's own formulas) and never inserts rows — it updates the next
// pre-formatted empty row in place, so every formula stays intact.
//
// Design rules:
// - Failed QCs are NOT exported. They go to the sheet only after a re-check
//   clears every open item (status "cleared").
// - Never blocks or fails an inspection: all failures are logged and swallowed.
// - No-op (with a single startup log) when not configured.
import { JWT } from "google-auth-library";
import type { Inspection } from "@shared/schema";

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const TABLE_HEADER_ROW = 20;
const FIRST_DATA_ROW = TABLE_HEADER_ROW + 1;
// Safety cap when scanning for the next empty row.
const MAX_SCAN_ROWS = 2000;

// App category key → tracker column, in sheet order K..O.
const CATEGORY_COLUMNS: { key: string; label: string }[] = [
  { key: "mech", label: "Mechanic" },
  { key: "cosm", label: "Paint & Body" },
  { key: "detail", label: "Detail" },
  { key: "under", label: "Undercoat" },
  { key: "bed", label: "Bedliner" },
];

let warned = false;
function config(): { creds: { client_email: string; private_key: string }; spreadsheetId: string } | null {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  if (!raw || !spreadsheetId) {
    if (!warned) {
      warned = true;
      console.log("Google Sheets export not configured (missing service account or spreadsheet id) — skipping.");
    }
    return null;
  }
  try {
    return { creds: JSON.parse(raw), spreadsheetId };
  } catch {
    if (!warned) {
      warned = true;
      console.error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON — Google Sheets export disabled.");
    }
    return null;
  }
}

async function accessToken(creds: { client_email: string; private_key: string }): Promise<string> {
  const client = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const { token } = await client.getAccessToken();
  if (!token) throw new Error("No access token from Google");
  return token;
}

const MONTH_TAB = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "short", year: "numeric" });
const DATE_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** "Jul 2026" for the tracker's monthly tab names (Central time). */
function monthTabName(d: Date): string {
  const parts = MONTH_TAB.formatToParts(d);
  const month = parts.find((p) => p.type === "month")?.value;
  const year = parts.find((p) => p.type === "year")?.value;
  return `${month} ${year}`;
}

/** True once the unit has passed QC overall (outright, or cleared via re-check). */
export function isExportable(record: Inspection): boolean {
  return record.status === "pass" || record.status === "cleared";
}

function categoryOutcome(record: Inspection, key: string): string {
  const data = (record.data as any) || {};
  if (data?.optOut?.[key]) return "N/A";
  const items: any[] = (data?.items?.[key] as any[]) || [];
  if (!items.length) return "N/A";
  // Only ever exported once the unit has passed overall, so any originally
  // failed item has since been repaired and cleared — the final state is Pass.
  return "Pass";
}

/**
 * Cell values for A..Q — null cells are skipped by the Sheets API and stay
 * untouched (B, E–F manual; G–J and P are the sheet's own formulas).
 */
export function buildRow(record: Inspection, finalized: Date): (string | null)[] {
  const row: (string | null)[] = new Array(17).fill(null);
  row[0] = record.vin; // A: VIN
  row[2] = DATE_FMT.format(finalized); // C: Completed Date
  row[3] = DATE_FMT.format(finalized); // D: Picture Received — same date QC passed
  CATEGORY_COLUMNS.forEach((cat, i) => {
    row[10 + i] = categoryOutcome(record, cat.key); // K..O
  });
  // P (QC Result) intentionally left null — the sheet computes it from K..O.

  const notes: string[] = [`${record.qcNumber}`];
  if (record.status === "cleared") notes.push("Passed after re-check");
  row[16] = notes.join(" — "); // Q: Notes
  return row;
}

/** When the unit finished QC: cleared timestamp if re-checked, else original ts. */
function finalizedDate(record: Inspection): Date {
  const data = (record.data as any) || {};
  if (record.status === "cleared" && data.clearedTs) return new Date(Number(data.clearedTs));
  if (data.ts) return new Date(Number(data.ts));
  return new Date(record.createdAt);
}

/**
 * Target row for this inspection, scanning VINs (column A) and notes (column
 * Q, which carries the FQ number):
 * 1. A row whose notes reference this exact QC number (re-export of the same
 *    inspection updates its own row — safe even with repeat VINs in a month).
 * 2. Else a row already holding this VIN (a unit that failed earlier and was
 *    hand-entered updates in place instead of duplicating).
 * 3. Else the first row with an empty VIN cell.
 */
async function targetRow(
  spreadsheetId: string,
  token: string,
  tab: string,
  vin: string,
  qcNumber: string
): Promise<number> {
  const range = encodeURIComponent(`'${tab}'!A${FIRST_DATA_ROW}:Q${FIRST_DATA_ROW + MAX_SCAN_ROWS}`);
  const res = await fetch(`${SHEETS_API}/${spreadsheetId}/values/${range}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Reading tab "${tab}" failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const values: string[][] = (await res.json()).values || [];
  const wantVin = vin.trim().toUpperCase();
  const wantQc = qcNumber.trim().toUpperCase();
  let vinRow = 0;
  let firstEmpty = FIRST_DATA_ROW + values.length;
  let emptyFound = false;
  for (let i = 0; i < values.length; i++) {
    const vinCell = String(values[i]?.[0] ?? "").trim().toUpperCase();
    const noteCell = String(values[i]?.[16] ?? "").trim().toUpperCase();
    // Notes are "FQ-#### — ..." — match the exact token, not a substring
    // (so FQ-100 never matches FQ-1004).
    if (wantQc && (noteCell === wantQc || noteCell.startsWith(`${wantQc} `))) return FIRST_DATA_ROW + i;
    if (wantVin && !vinRow && vinCell === wantVin) vinRow = FIRST_DATA_ROW + i;
    if (!vinCell && !emptyFound) {
      emptyFound = true;
      firstEmpty = FIRST_DATA_ROW + i;
    }
  }
  return vinRow || firstEmpty;
}

/**
 * Read-only helper for the live dashboard: fetch a range from the tracker
 * spreadsheet. Returns null when Sheets isn't configured; throws on API errors
 * (callers decide how to degrade).
 */
export async function readTrackerRange(tab: string, rangeA1: string): Promise<string[][] | null> {
  const cfg = config();
  if (!cfg) return null;
  const token = await accessToken(cfg.creds);
  const range = encodeURIComponent(`'${tab}'!${rangeA1}`);
  const res = await fetch(`${SHEETS_API}/${cfg.spreadsheetId}/values/${range}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Reading tab "${tab}" failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).values || [];
}

/** Exported for the dashboard: monthly tab name for a date, e.g. "Aug 2026". */
export { monthTabName };

/**
 * Export a passed/cleared inspection as a vehicle row on the matching monthly
 * tab, updating the next empty pre-formatted row in place (no row insertion).
 * Fire-and-forget: call without awaiting from route handlers; never throws.
 */
// Exports run one at a time per server instance so two simultaneous QCs can't
// both grab the same empty row (read-target-then-write is not atomic).
let exportQueue: Promise<void> = Promise.resolve();

export function exportInspectionToSheet(record: Inspection): Promise<void> {
  exportQueue = exportQueue.then(() => doExport(record));
  return exportQueue;
}

async function doExport(record: Inspection): Promise<void> {
  try {
    if (!isExportable(record)) return; // failed/open units wait for a clearing re-check
    const cfg = config();
    if (!cfg) return;
    const finalized = finalizedDate(record);
    const tab = monthTabName(finalized);
    const token = await accessToken(cfg.creds);
    const rowNum = await targetRow(cfg.spreadsheetId, token, tab, record.vin || "", record.qcNumber || "");
    const range = encodeURIComponent(`'${tab}'!A${rowNum}:Q${rowNum}`);
    const res = await fetch(`${SHEETS_API}/${cfg.spreadsheetId}/values/${range}?valueInputOption=USER_ENTERED`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [buildRow(record, finalized)] }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Update of tab "${tab}" row ${rowNum} failed (${res.status}): ${text.slice(0, 300)}`);
    }
    console.log(`Google Sheets: exported ${record.qcNumber} to "${tab}" row ${rowNum}`);
  } catch (err: any) {
    // Sheet export must never affect the inspection itself.
    console.error(`Google Sheets export failed for ${record.qcNumber}:`, err?.message || err);
  }
}
