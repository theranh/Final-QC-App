// One-off: freeze one or more closed months of the VPC Production Tracker into
// production_tracker, using the same internal logic as POST /api/tracker/snapshot.
//
//   npx tsx scripts/snapshot-month.ts 'Jul 2026' 'Aug 2026'
//
// Reads via googleSheets.ts (GOOGLE_SERVICE_ACCOUNT_JSON + GOOGLE_SHEETS_SPREADSHEET_ID).
// Writes an audit_log 'tracker_snapshot' row per month, actor = "script".
import { pool } from "../server/db";
import { db } from "../server/db";
import { auditLog } from "../shared/schema";
import { snapshotMonth } from "../server/tracker";

async function main() {
  const months = process.argv.slice(2).map((m) => m.trim()).filter(Boolean);
  if (!months.length) {
    console.error("Usage: tsx scripts/snapshot-month.ts 'Jul 2026' ['Aug 2026' ...]");
    process.exit(1);
  }
  for (const month of months) {
    try {
      const r = await snapshotMonth(month);
      await db.insert(auditLog).values({
        action: "tracker_snapshot",
        actorId: "script",
        actorEmail: "script@truckranch.com",
        actorName: "snapshot-month script",
        details: { month: r.month, rows: r.rows },
      });
      console.log(`✔ ${r.month}: froze ${r.rows} rows (snapshot_at ${r.snapshotAt})`);
    } catch (err: any) {
      console.error(`x ${month}: ${err?.message || err}`);
      process.exitCode = 1;
    }
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
