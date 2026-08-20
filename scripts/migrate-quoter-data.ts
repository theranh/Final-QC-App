/**
 * One-time Body Quoter data migration.
 *
 *   Usage:  npx tsx scripts/migrate-quoter-data.ts            (migrate then verify)
 *           npx tsx scripts/migrate-quoter-data.ts --verify   (verify only, no writes)
 *
 * SOURCE  = old Quoter Postgres, connection string in env QUOTER_DATABASE_URL.
 * DEST    = this app's Postgres, connection string in env DATABASE_URL.
 *
 * The source is treated strictly READ-ONLY: this script only ever issues
 * SELECT statements against QUOTER_DATABASE_URL. All writes go to DATABASE_URL.
 *
 * Idempotent: safe to re-run. settings/quotes/intakes upsert by PK, photos
 * insert ON CONFLICT DO NOTHING, and corrections are skipped once the
 * destination already holds at least as many rows as the source (see below).
 *
 * Copy order (respects the quote_id references from photos/intakes):
 *   settings -> quotes -> corrections -> photos -> intakes
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { LEGACY_PHOTO_INSERT_SQL, legacyPhotoInsertParams } from "./migrate-quoter-photo";

const { Pool } = pg;

const __dirname = dirname(fileURLToPath(import.meta.url));
const CURSOR_FILE = join(__dirname, ".quoter-photo-cursor");
const PHOTO_BATCH = 25;

const VERIFY_ONLY = process.argv.includes("--verify");

// ---------------------------------------------------------------------------
// small logging helpers
// ---------------------------------------------------------------------------
function log(...args: unknown[]) {
  console.log(...args);
}
function step(title: string) {
  log(`\n=== ${title} ===`);
}
function die(msg: string): never {
  console.error(`\nFATAL: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// env / connection setup — fail fast on a missing source or dest
// ---------------------------------------------------------------------------
const SRC_URL = process.env.QUOTER_DATABASE_URL;
const DEST_URL = process.env.DATABASE_URL;

if (!SRC_URL) {
  die(
    "QUOTER_DATABASE_URL is not set. Point it at the OLD Quoter Postgres " +
      "(read-only source) before running this migration.",
  );
}
if (!DEST_URL) {
  die("DATABASE_URL is not set. This is the destination (this app's) database.");
}

const src = new Pool({ connectionString: SRC_URL, max: 4, connectionTimeoutMillis: 15_000 });
const dest = new Pool({ connectionString: DEST_URL, max: 6, connectionTimeoutMillis: 15_000 });

// ---------------------------------------------------------------------------
// generic helpers
// ---------------------------------------------------------------------------
async function count(pool: pg.Pool, table: string): Promise<number> {
  const r = await pool.query(`SELECT COUNT(*)::bigint AS n FROM ${table}`);
  return Number(r.rows[0].n);
}

/**
 * committed_by is derived from the estimator name stored inside the quote/intake
 * `data` JSONB. Confirmed against the Quoter source (autosave()'s `entry`
 * object, index.html ~line 2812): the JSON has a top-level string `estimator`.
 * Non-empty -> use it; empty/missing -> NULL. We never guess a name.
 */
function committedByFromData(data: unknown): string | null {
  if (data && typeof data === "object") {
    const est = (data as Record<string, unknown>).estimator;
    if (typeof est === "string" && est.trim() !== "") return est.trim();
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1. settings
// ---------------------------------------------------------------------------
async function migrateSettings() {
  step("settings");
  // Skip server-local keys so we never clobber this app's own secrets/flags.
  const SKIP = new Set(["_secret", "_import_v1"]);
  const rows = (
    await src.query<{ key: string; value: unknown; updated_at: Date | null }>(
      `SELECT key, value, updated_at FROM settings`,
    )
  ).rows;

  let copied = 0;
  let skipped = 0;
  for (const row of rows) {
    if (SKIP.has(row.key)) {
      skipped++;
      continue;
    }
    await dest.query(
      `INSERT INTO settings (key, value, updated_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [row.key, JSON.stringify(row.value), row.updated_at],
    );
    copied++;
  }
  log(`settings: ${copied} upserted, ${skipped} skipped (server-local keys).`);
}

// ---------------------------------------------------------------------------
// 2. quotes
// ---------------------------------------------------------------------------
async function migrateQuotes() {
  step("quotes");
  const rows = (
    await src.query<{ id: string; data: unknown; updated_at: Date | null }>(
      `SELECT id, data, updated_at FROM quotes`,
    )
  ).rows;

  let copied = 0;
  for (const row of rows) {
    const committedBy = committedByFromData(row.data);
    await dest.query(
      `INSERT INTO quotes (id, data, updated_at, committed_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE
         SET data = EXCLUDED.data,
             updated_at = EXCLUDED.updated_at,
             committed_by = EXCLUDED.committed_by`,
      [row.id, JSON.stringify(row.data), row.updated_at, committedBy],
    );
    copied++;
  }
  log(`quotes: ${copied} upserted.`);
}

// ---------------------------------------------------------------------------
// 3. corrections
// ---------------------------------------------------------------------------
async function migrateCorrections() {
  step("corrections");
  // corrections uses a BIGSERIAL id, so we cannot upsert by PK across databases.
  // The rows are append-only shop-calibration diffs; the only thing that matters
  // is that each (ts, diffs) pair lands exactly once. Simplest safe idempotent
  // rule: if the destination already has >= as many correction rows as the
  // source, assume a prior run finished and skip. Otherwise copy every source
  // row that has no (ts, diffs) twin in the destination.
  const srcCount = await count(src, "corrections");
  const destCount = await count(dest, "corrections");
  if (destCount >= srcCount && srcCount > 0) {
    log(
      `corrections: destination already has ${destCount} >= source ${srcCount} — skipping (already migrated).`,
    );
    return;
  }

  const rows = (
    await src.query<{ ts: number; diffs: unknown }>(
      `SELECT ts, diffs FROM corrections ORDER BY id`,
    )
  ).rows;

  let copied = 0;
  let dup = 0;
  for (const row of rows) {
    // Insert only when no identical (ts, diffs) row exists in the destination.
    const res = await dest.query(
      `INSERT INTO corrections (ts, diffs)
       SELECT $1::bigint, $2::jsonb
       WHERE NOT EXISTS (
         SELECT 1 FROM corrections c
         WHERE c.ts = $1::bigint AND c.diffs = $2::jsonb
       )`,
      [row.ts, JSON.stringify(row.diffs)],
    );
    if (res.rowCount && res.rowCount > 0) copied++;
    else dup++;
  }
  log(`corrections: ${copied} inserted, ${dup} already present.`);
}

// ---------------------------------------------------------------------------
// 4. photos — resumable, keyset-paginated, one transaction per batch
// ---------------------------------------------------------------------------
function readCursor(): string {
  try {
    if (existsSync(CURSOR_FILE)) {
      return readFileSync(CURSOR_FILE, "utf8").trim();
    }
  } catch {
    /* fall through to empty cursor */
  }
  return "";
}
function writeCursor(lastId: string) {
  writeFileSync(CURSOR_FILE, lastId, "utf8");
}

async function migratePhotos() {
  step("photos");
  const srcTotal = await count(src, "photos");
  log(`photos: ${srcTotal} rows in source.`);

  let lastId = readCursor();
  if (lastId) log(`photos: resuming after cursor id="${lastId}".`);

  let running = 0;
  let batchNo = 0;

  // Keyset pagination: WHERE id > $lastId ORDER BY id LIMIT N. Photo `data`
  // (BYTEA) is streamed one small batch at a time — never all in memory.
  for (;;) {
    const batch = (
      await src.query<{
        id: string;
        quote_id: string;
        slot: string | null;
        mime: string;
        data: Buffer;
        ts: number;
      }>(
        `SELECT id, quote_id, slot, mime, data, ts
           FROM photos
          WHERE id > $1
          ORDER BY id
          LIMIT $2`,
        [lastId, PHOTO_BATCH],
      )
    ).rows;

    if (batch.length === 0) break;
    batchNo++;

    const client = await dest.connect();
    let inserted = 0;
    try {
      await client.query("BEGIN");
      for (const p of batch) {
        const res = await client.query(
          LEGACY_PHOTO_INSERT_SQL,
          legacyPhotoInsertParams(p),
        );
        if (res.rowCount && res.rowCount > 0) inserted++;
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      client.release();
      throw e;
    }
    client.release();

    // Advance & persist the cursor only after the batch commits, so a crash
    // resumes from the last durably-copied id.
    lastId = batch[batch.length - 1].id;
    writeCursor(lastId);
    running += batch.length;
    log(
      `photos: batch #${batchNo} — ${batch.length} read, ${inserted} new` +
        ` (${batch.length - inserted} already present); running total ${running}/${srcTotal}.`,
    );
  }

  log(`photos: done. Processed ${running} source rows.`);
  // Clean up the cursor file once the whole table drained.
  try {
    if (existsSync(CURSOR_FILE)) unlinkSync(CURSOR_FILE);
  } catch {
    /* non-fatal */
  }
}

// ---------------------------------------------------------------------------
// 5. intakes
// ---------------------------------------------------------------------------
async function migrateIntakes() {
  step("intakes");
  const rows = (
    await src.query<{
      id: string;
      vin: string;
      stock: string | null;
      vehicle: string | null;
      miles: string | null;
      estimator: string | null;
      quote_id: string | null;
      data: unknown;
      completed_at: Date | null;
      updated_at: Date | null;
    }>(
      `SELECT id, vin, stock, vehicle, miles, estimator, quote_id, data, completed_at, updated_at
         FROM intakes`,
    )
  ).rows;

  let copied = 0;
  for (const row of rows) {
    // committed_by for intakes mirrors quotes: use the intake's own estimator
    // column when present & non-empty (this IS the estimator name), else NULL.
    const committedBy =
      row.estimator && row.estimator.trim() !== "" ? row.estimator.trim() : null;
    await dest.query(
      `INSERT INTO intakes
         (id, vin, stock, vehicle, miles, estimator, quote_id, data, completed_at, updated_at, committed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO UPDATE
         SET vin = EXCLUDED.vin,
             stock = EXCLUDED.stock,
             vehicle = EXCLUDED.vehicle,
             miles = EXCLUDED.miles,
             estimator = EXCLUDED.estimator,
             quote_id = EXCLUDED.quote_id,
             data = EXCLUDED.data,
             completed_at = EXCLUDED.completed_at,
             updated_at = EXCLUDED.updated_at,
             committed_by = EXCLUDED.committed_by`,
      [
        row.id,
        row.vin,
        row.stock ?? "",
        row.vehicle ?? "",
        row.miles ?? "",
        row.estimator ?? "",
        row.quote_id,
        JSON.stringify(row.data),
        row.completed_at,
        row.updated_at,
        committedBy,
      ],
    );
    copied++;
  }
  log(`intakes: ${copied} upserted.`);
}

// ---------------------------------------------------------------------------
// 6. verification
// ---------------------------------------------------------------------------
async function verify() {
  step("VERIFICATION");
  const tables = ["settings", "quotes", "corrections", "photos", "intakes"];

  // --- row counts, source vs dest -----------------------------------------
  log("\nRow counts (source vs dest):");
  log(`  ${"table".padEnd(14)}${"source".padStart(10)}${"dest".padStart(10)}${"delta".padStart(10)}`);
  for (const t of tables) {
    const s = await count(src, t);
    const d = await count(dest, t);
    const delta = d - s;
    log(`  ${t.padEnd(14)}${String(s).padStart(10)}${String(d).padStart(10)}${String(delta).padStart(10)}`);
  }

  // --- orphaned photos (dest) ----------------------------------------------
  const orphans = Number(
    (
      await dest.query(
        `SELECT COUNT(*)::bigint AS n
           FROM photos p
      LEFT JOIN quotes q ON q.id = p.quote_id
          WHERE q.id IS NULL`,
      )
    ).rows[0].n,
  );
  log(
    `\nOrphaned dest photos (quote_id with no matching quotes.id): ${orphans}` +
      (orphans === 0 ? "  ✓" : "  ✗ (investigate before go-live)"),
  );

  // --- total photo bytes, source vs dest -----------------------------------
  const srcBytes = Number(
    (await src.query(`SELECT COALESCE(SUM(octet_length(data)),0)::bigint AS n FROM photos`)).rows[0].n,
  );
  const destBytes = Number(
    (await dest.query(`SELECT COALESCE(SUM(octet_length(data)),0)::bigint AS n FROM photos`)).rows[0].n,
  );
  log(
    `\nPhoto bytes: source=${srcBytes.toLocaleString()} dest=${destBytes.toLocaleString()}` +
      (srcBytes === destBytes ? "  ✓ match" : "  ✗ MISMATCH"),
  );

  // --- spot-check 5 most recent source quotes ------------------------------
  log("\nSpot-check: 5 most recent source quotes vs dest:");
  const recent = (
    await src.query<{ id: string; data: Record<string, unknown> }>(
      `SELECT id, data FROM quotes ORDER BY updated_at DESC NULLS LAST LIMIT 5`,
    )
  ).rows;

  if (recent.length === 0) {
    log("  (no quotes in source)");
  }

  for (const q of recent) {
    const destRow = (
      await dest.query<{ data: Record<string, unknown> }>(
        `SELECT data FROM quotes WHERE id = $1`,
        [q.id],
      )
    ).rows[0];

    const sData = q.data ?? {};
    const vin = typeof sData.vin === "string" ? sData.vin : "—";
    const lineCount = Array.isArray(sData.lines) ? sData.lines.length : 0;
    const totals = (sData.totals as Record<string, unknown> | undefined) ?? {};
    const usd = totals.usd ?? "—";
    const hrs = totals.hrs ?? "—";

    let match = "MISSING in dest ✗";
    if (destRow) {
      const equal = JSON.stringify(destRow.data) === JSON.stringify(sData);
      match = equal ? "data equal ✓" : "DATA DIFFERS ✗";
    }
    log(
      `  ${q.id}  VIN=${vin}  lines=${lineCount}  total=$${usd} / ${hrs}h  — ${match}`,
    );
  }
}

// ---------------------------------------------------------------------------
// driver
// ---------------------------------------------------------------------------
async function main() {
  log(VERIFY_ONLY ? "Body Quoter migration — VERIFY ONLY (read-only)." : "Body Quoter migration — starting.");

  // Sanity: confirm both databases are reachable up front.
  await src.query("SELECT 1");
  await dest.query("SELECT 1");

  if (!VERIFY_ONLY) {
    await migrateSettings();
    await migrateQuotes();
    await migrateCorrections();
    await migratePhotos();
    await migrateIntakes();
  }

  await verify();
  log("\nDone.");
}

main()
  .then(async () => {
    await src.end();
    await dest.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("\nMigration failed:", err instanceof Error ? err.stack || err.message : err);
    try {
      await src.end();
    } catch {
      /* ignore */
    }
    try {
      await dest.end();
    } catch {
      /* ignore */
    }
    process.exit(1);
  });
