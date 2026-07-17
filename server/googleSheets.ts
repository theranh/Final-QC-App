// Google Sheets export — appends a row whenever an inspection is finalized or
// a re-check closes it out. Uses a Google service account (secret:
// GOOGLE_SERVICE_ACCOUNT_JSON) that the spreadsheet is shared with, plus
// GOOGLE_SHEETS_SPREADSHEET_ID pointing at the target sheet.
//
// Design rules:
// - Never blocks or fails an inspection: all failures are logged and swallowed.
// - No-op (with a single startup log) when not configured.
import { JWT } from "google-auth-library";
import type { Inspection } from "@shared/schema";

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

const HEADER = [
  "Event",
  "QC Number",
  "Date",
  "Stock",
  "Vehicle",
  "VIN",
  "Result",
  "Status",
  "Inspector",
  "Failed Items",
  "Open Items",
  "Cleared Date",
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

let headerEnsured = false;
async function ensureHeader(token: string, spreadsheetId: string): Promise<void> {
  if (headerEnsured) return;
  const res = await fetch(`${SHEETS_API}/${spreadsheetId}/values/A1:L1`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Header check failed (${res.status})`);
  const data = (await res.json()) as { values?: string[][] };
  const firstCell = data.values?.[0]?.[0];
  if (!firstCell) {
    const put = await fetch(`${SHEETS_API}/${spreadsheetId}/values/A1?valueInputOption=USER_ENTERED`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [HEADER] }),
    });
    if (!put.ok) throw new Error(`Header write failed (${put.status})`);
  }
  headerEnsured = true;
}

const CENTRAL_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
});

function fmt(ts: number | Date | null | undefined): string {
  if (!ts) return "";
  return CENTRAL_TIME.format(typeof ts === "number" ? new Date(ts) : ts);
}

function buildRow(record: Inspection, event: "Finalized" | "Re-check"): string[] {
  const data = (record.data as any) || {};
  const failItems: string[] = [];
  for (const [cat, arr] of Object.entries((data.items as Record<string, any[]>) || {})) {
    for (const it of arr || []) {
      if (it?.mark === "f") failItems.push(`${cat}: ${it.item}`);
    }
  }
  const openItems = ((data.openItems as any[]) || []).map((x) => `${x.cat}: ${x.item}`);
  return [
    event,
    record.qcNumber,
    fmt(data.ts || record.createdAt),
    record.stock,
    record.vehicle,
    record.vin,
    record.result.toUpperCase(),
    record.status.toUpperCase(),
    record.updatedByName || record.createdByName,
    failItems.join("; "),
    openItems.join("; "),
    fmt(data.clearedTs),
  ];
}

/**
 * Append one row for this inspection event. Fire-and-forget: call without
 * awaiting from route handlers; never throws.
 */
export async function exportInspectionToSheet(record: Inspection, event: "Finalized" | "Re-check"): Promise<void> {
  try {
    const cfg = config();
    if (!cfg) return;
    const token = await accessToken(cfg.creds);
    await ensureHeader(token, cfg.spreadsheetId);
    const res = await fetch(
      `${SHEETS_API}/${cfg.spreadsheetId}/values/A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ values: [buildRow(record, event)] }),
      }
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Append failed (${res.status}): ${text.slice(0, 300)}`);
    }
    console.log(`Google Sheets: exported ${record.qcNumber} (${event})`);
  } catch (err: any) {
    // Sheet export must never affect the inspection itself.
    console.error(`Google Sheets export failed for ${record.qcNumber}:`, err?.message || err);
  }
}
