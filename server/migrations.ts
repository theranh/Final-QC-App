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
  {
    // Cycle-time foundations:
    // - intakes.created_at: set ONCE at first insert (arrival at intake),
    //   never overwritten by later edits. Historical rows are left NULL —
    //   there is no defensible arrival timestamp for them (updated_at is
    //   last-edit, completed_at is commit), and a fabricated backfill would
    //   poison future arrival-to-frontline reporting. NULL means "unknown".
    // - production_tracker(.archive).ro_open: RO Open Date exactly as typed
    //   in sheet column B, preserved so future reporting can use it. Never
    //   parsed/recomputed, consistent with the other tracker columns.
    id: "0005_cycle_time_columns",
    statements: [
      sql`ALTER TABLE intakes ADD COLUMN IF NOT EXISTS created_at timestamptz`,
      sql`ALTER TABLE production_tracker ADD COLUMN IF NOT EXISTS ro_open text`,
      sql`ALTER TABLE production_tracker_archive ADD COLUMN IF NOT EXISTS ro_open text`,
    ],
  },
  {
    // Operations Handoff Workspace (task #106):
    // - vehicle_activity_events: append-only event log per vehicle
    // - vehicle_handoff_flags: soft-clearable flags per vehicle
    // - employee_preferences: per-employee UI preferences
    // No historical backfill — rows from before this migration are left as-is.
    id: "0006_handoff_workspace",
    statements: [
      sql`CREATE TABLE IF NOT EXISTS vehicle_activity_events (
        id bigserial PRIMARY KEY,
        vin varchar NOT NULL,
        qc_number varchar,
        event_type varchar NOT NULL,
        actor_id varchar NOT NULL,
        actor_email varchar NOT NULL,
        actor_name varchar NOT NULL,
        occurred_at timestamptz NOT NULL DEFAULT now(),
        details jsonb
      )`,
      sql`CREATE INDEX IF NOT EXISTS vehicle_activity_events_vin_idx
          ON vehicle_activity_events (vin)`,
      sql`CREATE INDEX IF NOT EXISTS vehicle_activity_events_qc_idx
          ON vehicle_activity_events (qc_number)`,
      sql`CREATE INDEX IF NOT EXISTS vehicle_activity_events_occurred_idx
          ON vehicle_activity_events (occurred_at)`,
      sql`CREATE TABLE IF NOT EXISTS vehicle_handoff_flags (
        id bigserial PRIMARY KEY,
        vin varchar NOT NULL,
        qc_number varchar,
        kind varchar NOT NULL,
        note varchar(300),
        active boolean NOT NULL DEFAULT true,
        creator_id varchar NOT NULL,
        creator_email varchar NOT NULL,
        creator_name varchar NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        clearer_id varchar,
        clearer_email varchar,
        clearer_name varchar,
        cleared_at timestamptz
      )`,
      sql`CREATE INDEX IF NOT EXISTS vehicle_handoff_flags_vin_idx
          ON vehicle_handoff_flags (vin)`,
      sql`CREATE INDEX IF NOT EXISTS vehicle_handoff_flags_active_idx
          ON vehicle_handoff_flags (active, vin)`,
      sql`CREATE TABLE IF NOT EXISTS employee_preferences (
        employee_id integer PRIMARY KEY,
        data jsonb NOT NULL DEFAULT '{}'::jsonb,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`,
    ],
  },
  {
    // Collaboration read paths poll frequently and merge records by normalized
    // VIN. These indexes keep those bounded queries from degrading into table
    // scans as operational history grows. Separate migration because 0006 may
    // already be applied before these access patterns are enabled.
    id: "0007_handoff_query_indexes",
    statements: [
      sql`CREATE INDEX IF NOT EXISTS collab_inspections_vin_norm_idx
          ON inspections ((upper(trim(vin))))`,
      sql`CREATE INDEX IF NOT EXISTS collab_inspections_open_idx
          ON inspections (created_at)
          WHERE status = 'open' AND archived = false`,
      sql`CREATE INDEX IF NOT EXISTS collab_intakes_vin_norm_idx
          ON intakes ((upper(trim(vin))))`,
      sql`CREATE INDEX IF NOT EXISTS collab_intakes_stale_idx
          ON intakes (updated_at)
          WHERE completed_at IS NULL`,
      sql`CREATE INDEX IF NOT EXISTS collab_intakes_completed_vin_idx
          ON intakes ((upper(trim(vin))), completed_at DESC)
          WHERE completed_at IS NOT NULL`,
      sql`CREATE INDEX IF NOT EXISTS collab_quotes_vin_norm_idx
          ON quotes ((upper(data->>'vin')))`,
      sql`CREATE INDEX IF NOT EXISTS collab_quote_snapshots_vin_norm_idx
          ON quote_snapshots ((upper(trim(vin))))`,
      sql`CREATE INDEX IF NOT EXISTS collab_audit_qc_at_idx
          ON audit_log (qc_number, at DESC)`,
      sql`CREATE INDEX IF NOT EXISTS collab_export_failed_idx
          ON sheet_export_jobs (updated_at, inspection_id)
          WHERE status = 'failed'`,
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
