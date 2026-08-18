// Versioned startup migrations.
//
// Replaces the old ad-hoc "ensure*" startup fixups (ensureAccuracySchema,
// seedQcCounter). Every migration is:
//   - reviewed and listed here in order, with a stable id,
//   - idempotent (safe to re-run),
//   - recorded in schema_migrations so it normally runs exactly once,
//   - executed under a Postgres advisory lock so two instances can't race.
//
// Migrations run after listen() (the port must open immediately for the
// deployment health check) but BEFORE the request gate opens, so no traffic
// is served against a half-migrated schema.
import { sql } from "drizzle-orm";
import { db } from "./db";

// A fixed app-wide advisory lock key for the migration critical section.
const MIGRATION_LOCK_KEY = 727_431_001;

export type Migration = { id: string; statements: ReturnType<typeof sql>[] };

export const MIGRATIONS: Migration[] = [
  {
    // Seed the FQ-number counter (first number handed out: FQ-1001).
    id: "0001_seed_qc_counter",
    statements: [sql`INSERT INTO qc_counter (id, value) VALUES (1, 1000) ON CONFLICT (id) DO NOTHING`],
  },
  {
    // AI accuracy schema for installs that pre-date the drizzle tables.
    id: "0002_accuracy_schema",
    statements: [
      sql`CREATE TABLE IF NOT EXISTS ai_analyses (
        id bigserial PRIMARY KEY,
        ts bigint NOT NULL,
        analysis_id text
      )`,
      sql`ALTER TABLE ai_analyses ADD COLUMN IF NOT EXISTS analysis_id text`,
      sql`ALTER TABLE ai_analyses ADD COLUMN IF NOT EXISTS corrected boolean NOT NULL DEFAULT false`,
      // Non-partial unique index: required for ON CONFLICT (analysis_id);
      // NULLs stay distinct so multiple NULL rows are allowed.
      sql`CREATE UNIQUE INDEX IF NOT EXISTS ai_analyses_analysis_id_key ON ai_analyses (analysis_id)`,
      sql`ALTER TABLE corrections ADD COLUMN IF NOT EXISTS analysis_id text`,
    ],
  },
  {
    // Idempotent corrections: dedupe pre-constraint rows once, then enforce.
    id: "0003_corrections_dedupe",
    statements: [
      sql`DELETE FROM corrections a USING corrections b
          WHERE a.id > b.id AND a.analysis_id IS NOT NULL
            AND a.analysis_id = b.analysis_id
            AND md5(a.diffs::text) = md5(b.diffs::text)`,
      sql`CREATE UNIQUE INDEX IF NOT EXISTS corrections_analysis_diffs_key
          ON corrections (analysis_id, md5(diffs::text))
          WHERE analysis_id IS NOT NULL`,
    ],
  },
  {
    // Reliability tables: tracker snapshot archive, durable sheet-export
    // queue, deleted-quote tombstones.
    id: "0004_reliability_tables",
    statements: [
      sql`CREATE TABLE IF NOT EXISTS production_tracker_archive (
        id bigserial PRIMARY KEY,
        vin text NOT NULL,
        month text NOT NULL,
        retail_plan_usd numeric,
        closed_ro_usd numeric,
        days_to_close integer,
        snapshot_at timestamptz,
        archived_at timestamptz NOT NULL DEFAULT now()
      )`,
      sql`CREATE INDEX IF NOT EXISTS production_tracker_archive_month_idx
          ON production_tracker_archive (month, archived_at)`,
      sql`CREATE TABLE IF NOT EXISTS sheet_export_jobs (
        id bigserial PRIMARY KEY,
        inspection_id integer NOT NULL,
        qc_number text NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        attempts integer NOT NULL DEFAULT 0,
        last_error text,
        next_attempt_at timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`,
      sql`CREATE INDEX IF NOT EXISTS sheet_export_jobs_due_idx
          ON sheet_export_jobs (status, next_attempt_at)`,
      sql`CREATE TABLE IF NOT EXISTS deleted_quotes (
        id text PRIMARY KEY,
        deleted_at timestamptz NOT NULL DEFAULT now()
      )`,
    ],
  },
];

/**
 * Run all pending migrations. Returns true when every migration is applied.
 * Bounded retries (a transient DB blip must not brick a publish); on final
 * failure logs loudly and returns false so the caller can decide.
 */
export async function runMigrations(): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS schema_migrations (
        id text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
      // One transaction = one pooled connection, so the advisory lock is
      // guaranteed to be taken and released on the same session
      // (pg_advisory_xact_lock auto-releases at commit/rollback — it can
      // never be stranded on an idle pooled connection).
      const appliedIds = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`);
        const done = await tx.execute(sql`SELECT id FROM schema_migrations`);
        const applied = new Set(((done as any).rows ?? []).map((r: any) => String(r.id)));
        const ran: string[] = [];
        for (const m of MIGRATIONS) {
          if (applied.has(m.id)) continue;
          for (const stmt of m.statements) await tx.execute(stmt);
          await tx.execute(sql`INSERT INTO schema_migrations (id) VALUES (${m.id}) ON CONFLICT (id) DO NOTHING`);
          ran.push(m.id);
        }
        return ran;
      });
      for (const id of appliedIds) console.log(`Migration applied: ${id}`);
      return true;
    } catch (err) {
      console.error(`Migration attempt ${attempt} failed:`, err);
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  console.error("STARTUP ERROR: migrations did not complete — schema may be incomplete.");
  return false;
}
