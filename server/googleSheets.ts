// Google Sheets export — when an inspection is finalized, appends a vehicle row
// to the matching monthly tab (e.g. "Jul 2026") of the VPC Production Tracker.
// Uses a Google service account (secret: GOOGLE_SERVICE_ACCOUNT_JSON) that the
// spreadsheet is shared with, plus GOOGLE_SHEETS_SPREADSHEET_ID.
//
// Tracker layout (row 20 is the table header):
//   A: VIN                B: RO Open Date       C: Completed Date
//   D: Picture Received   E: Retail Plan $      F: Closed RO $
//   G–J: computed/manual  K: Mechanic           L: Paint & Body
//   M: Detail             N: Undercoat          O: Bedliner
//   P: QC Result          Q: Notes
// The app only fills A, C, K–P (and Q for ceramic-coating fails). Everything
// else is left as null so the sheet's own formulas and manual entries are
// never touched.
//
// Design rules:
// - Never blocks or fails an inspection: all failures are logged and swallowed.
// - No-op (with a single startup log) when not configured.
import { JWT } from "google-auth-library";
import type { Inspection } from "@shared/schema";

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const TABLE_HEADER_ROW = 20;

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

function categoryOutcome(data: any, key: string): string {
  if (data?.optOut?.[key]) return "N/A";
  const items: any[] = (data?.items?.[key] as any[]) || [];
  if (!items.length) return "N/A";
  return items.some((it) => it?.mark === "f") ? "Fail" : "Pass";
}

/** Row A..Q — null cells are skipped by the Sheets API and stay untouched. */
export function buildRow(record: Inspection, finalized: Date): (string | null)[] {
  const data = (record.data as any) || {};
  const row: (string | null)[] = new Array(17).fill(null);
  row[0] = record.vin; // A: VIN
  row[2] = DATE_FMT.format(finalized); // C: Completed Date
  CATEGORY_COLUMNS.forEach((cat, i) => {
    row[10 + i] = categoryOutcome(data, cat.key); // K..O
  });
  row[15] = record.result === "fail" ? "Fail" : "Pass"; // P: QC Result

  // Ceramic coating has no tracker column — surface a fail in the notes cell.
  const ceramic = categoryOutcome(data, "ceramic");
  const notes: string[] = [`${record.qcNumber}`];
  if (ceramic === "Fail") notes.push("Ceramic Coating: Fail");
  row[16] = notes.join(" — "); // Q: Notes
  return row;
}

/**
 * Append this finalized inspection as a vehicle row on the matching monthly
 * tab. Fire-and-forget: call without awaiting from route handlers; never throws.
 */
export async function exportInspectionToSheet(record: Inspection): Promise<void> {
  try {
    const cfg = config();
    if (!cfg) return;
    const data = (record.data as any) || {};
    const finalized = data.ts ? new Date(Number(data.ts)) : new Date(record.createdAt);
    const tab = monthTabName(finalized);
    const token = await accessToken(cfg.creds);
    const range = encodeURIComponent(`'${tab}'!A${TABLE_HEADER_ROW}:Q`);
    const res = await fetch(
      `${SHEETS_API}/${cfg.spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ values: [buildRow(record, finalized)] }),
      }
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Append to tab "${tab}" failed (${res.status}): ${text.slice(0, 300)}`);
    }
    console.log(`Google Sheets: exported ${record.qcNumber} to "${tab}"`);
  } catch (err: any) {
    // Sheet export must never affect the inspection itself.
    console.error(`Google Sheets export failed for ${record.qcNumber}:`, err?.message || err);
  }
}
