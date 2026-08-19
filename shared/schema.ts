import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

// Postgres BYTEA (drizzle-orm has no built-in helper for it).
const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export * from "./models/auth";

// Approved-employee allowlist. A valid @truckranch.com email alone is not
// enough — the employee must also be "active" here before they can use the app.
export const employees = pgTable("employees", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").unique(), // Replit Auth user id, linked on first sign-in
  email: varchar("email").unique().notNull(), // lowercased, @truckranch.com
  name: varchar("name").notNull().default(""),
  title: varchar("title").notNull().default("Inspector"),
  isAdmin: boolean("is_admin").notNull().default(false),
  status: varchar("status").notNull().default("pending"), // pending | active | inactive
  // PIN sign-off (quotes/intakes commit): hashed 4-digit PIN, never plaintext.
  pinHash: text("pin_hash"),
  canOverride: boolean("can_override").notNull().default(false),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Single-row counter used to hand out unique FQ-#### numbers transactionally.
export const qcCounter = pgTable("qc_counter", {
  id: integer("id").primaryKey(),
  value: integer("value").notNull(),
});

export const inspections = pgTable("inspections", {
  id: serial("id").primaryKey(),
  qcNumber: varchar("qc_number").unique().notNull(), // FQ-1001, FQ-1002, ...
  stock: varchar("stock").notNull(),
  vehicle: varchar("vehicle").notNull(),
  vin: varchar("vin").notNull().default(""),
  result: varchar("result").notNull(), // pass | fail (first inspection)
  status: varchar("status").notNull(), // pass | open | cleared
  data: jsonb("data").notNull(), // full inspection payload (items, openItems, rechecks, photos, sig, ...)
  imported: boolean("imported").notNull().default(false),
  // Archived records stay fully viewable but are excluded from every
  // dashboard/report aggregation (KPIs, blocked list, throughput, etc).
  archived: boolean("archived").notNull().default(false),
  createdById: varchar("created_by_id").notNull(),
  createdByEmail: varchar("created_by_email").notNull(),
  createdByName: varchar("created_by_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedById: varchar("updated_by_id").notNull(),
  updatedByEmail: varchar("updated_by_email").notNull(),
  updatedByName: varchar("updated_by_name").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// Append-only activity history. No API route edits or deletes rows here.
export const auditLog = pgTable("audit_log", {
  id: serial("id").primaryKey(),
  inspectionId: integer("inspection_id"),
  qcNumber: varchar("qc_number"),
  action: varchar("action").notNull(), // created | recheck_committed | status_change | imported | import_summary | exported | employee_updated | delete_attempt | tracker_snapshot
  actorId: varchar("actor_id").notNull(),
  actorEmail: varchar("actor_email").notNull(),
  actorName: varchar("actor_name").notNull(),
  at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
  details: jsonb("details"),
});

// ---------------------------------------------------------------------------
// Body Quoter tables, copied identically from the Quoter app (no renames).
// Only addition: committed_by on quotes and intakes, per the migration plan.
// ---------------------------------------------------------------------------

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const quotes = pgTable("quotes", {
  id: text("id").primaryKey(),
  data: jsonb("data").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  committedBy: text("committed_by"),
  overriddenBy: text("overridden_by"), // supervisor countersign; null on normal sign-off
});

export const corrections = pgTable("corrections", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  ts: bigint("ts", { mode: "number" }).notNull(),
  diffs: jsonb("diffs").notNull(),
  // Nullable: rows created before analysis tracking was added will have NULL.
  // When set, joins to ai_analyses.analysis_id to link this correction to the
  // specific AI call it corrected (enabling accurate per-analysis correction rates).
  analysisId: text("analysis_id"),
});

// One row per successful AI classify call — lightweight accuracy telemetry.
// ts is a JS Date.now() millisecond timestamp (matches corrections.ts convention).
// analysis_id is a client-generated UUID shared across the initial and any
// second-look call for the same photo line; ON CONFLICT DO NOTHING on the
// server ensures only one row is kept per unique analysis, so second-look
// calls do not inflate the denominator.
// corrected is flipped to TRUE by the corrections endpoint when the estimator
// overrides the AI result.  Storing it here — rather than deriving it via a
// JOIN to the corrections table — means the flag survives the 500-row cleanup
// that prunes the corrections learning-cache.
export const aiAnalyses = pgTable("ai_analyses", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  ts: bigint("ts", { mode: "number" }).notNull(),
  analysisId: text("analysis_id").unique(),
  corrected: boolean("corrected").notNull().default(false),
});

export const photos = pgTable(
  "photos",
  {
    id: text("id").primaryKey(),
    quoteId: text("quote_id").notNull(),
    slot: text("slot"),
    mime: text("mime").notNull(),
    data: bytea("data").notNull(),
    ts: bigint("ts", { mode: "number" }).notNull(),
  },
  (t) => [index("photos_quote_idx").on(t.quoteId)],
);

export const intakes = pgTable(
  "intakes",
  {
    id: text("id").primaryKey(),
    vin: text("vin").notNull(),
    stock: text("stock").notNull().default(""),
    vehicle: text("vehicle").notNull().default(""),
    miles: text("miles").notNull().default(""),
    estimator: text("estimator").notNull().default(""),
    quoteId: text("quote_id"),
    data: jsonb("data").notNull(),
    // Arrival at intake: set once on first insert, NEVER updated afterwards
    // (the upsert's ON CONFLICT branch does not touch it). NULL on rows that
    // predate this column — unknown, not backfilled (no defensible source).
    createdAt: timestamp("created_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
    committedBy: text("committed_by"),
    overriddenBy: text("overridden_by"), // supervisor countersign; null on normal sign-off
  },
  (t) => [index("intakes_vin_idx").on(t.vin)],
);

// ---------------------------------------------------------------------------
// Phase 1A — pricing feedback capture (observation only, no pricing changes).
// ---------------------------------------------------------------------------

// Immutable snapshot of a damage quote exactly as approved at PIN commit.
// One row per committed version; content_hash makes retries idempotent and
// lets a future re-commit of changed content create a NEW version instead of
// overwriting history. No API route updates or deletes rows here.
export const quoteSnapshots = pgTable(
  "quote_snapshots",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    quoteId: text("quote_id").notNull(),
    intakeId: text("intake_id"), // null when committed via the legacy quote path
    vin: text("vin").notNull().default(""),
    stock: text("stock").notNull().default(""),
    vehicle: text("vehicle").notNull().default(""), // display string
    veh: jsonb("veh"), // decoded {year,make,model,trim,body} when available
    estimator: text("estimator").notNull().default(""),
    committedBy: text("committed_by").notNull(),
    overriddenBy: text("overridden_by"),
    // Exact quote document as approved (lines + cls + overrides + totals).
    doc: jsonb("doc").notNull(),
    // Rate tables in force at commit time (merged defaults + saved settings).
    rates: jsonb("rates").notNull(),
    ratesSource: text("rates_source").notNull().default("default"), // default | settings
    // Server-recomputed engine breakdown: per-line calculated vs approved
    // hours/dollars plus quote-level totals for both.
    engine: jsonb("engine").notNull(),
    linesTotal: integer("lines_total").notNull().default(0), // billable lines
    linesOverridden: integer("lines_overridden").notNull().default(0),
    calcUsd: numeric("calc_usd").notNull().default("0"), // engine (no overrides)
    finalUsd: numeric("final_usd").notNull().default("0"), // approved
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("quote_snapshots_version_idx").on(t.quoteId, t.contentHash),
    index("quote_snapshots_vin_idx").on(t.vin),
  ],
);

// One row per committed line whose estimator-approved pricing differs from
// the deterministic engine's calculation. Ground truth for future rate tuning.
export const pricingCorrections = pgTable(
  "pricing_corrections",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    snapshotId: bigint("snapshot_id", { mode: "number" }).notNull(),
    quoteId: text("quote_id").notNull(),
    intakeId: text("intake_id"),
    lineId: text("line_id").notNull(),
    vin: text("vin").notNull().default(""),
    estimator: text("estimator").notNull().default(""),
    committedBy: text("committed_by").notNull().default(""),
    veh: jsonb("veh"),
    panel: text("panel").notNull().default("unknown"),
    damageType: text("damage_type").notNull().default(""),
    severity: text("severity").notNull().default(""),
    aiCls: jsonb("ai_cls"), // full classification incl. overrides as committed
    overrideReason: text("override_reason"), // none captured yet; reserved
    calcB: numeric("calc_b").notNull().default("0"),
    calcP: numeric("calc_p").notNull().default("0"),
    calcRi: numeric("calc_ri").notNull().default("0"),
    calcUsd: numeric("calc_usd").notNull().default("0"),
    finalB: numeric("final_b").notNull().default("0"),
    finalP: numeric("final_p").notNull().default("0"),
    finalRi: numeric("final_ri").notNull().default("0"),
    finalUsd: numeric("final_usd").notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("pricing_corrections_line_idx").on(t.snapshotId, t.lineId),
    index("pricing_corrections_panel_idx").on(t.panel),
  ],
);

// Actual repair outcomes, linked to a committed snapshot. Populated later
// from the recon/repair workflow — nothing in normal estimating writes here.
export const repairActuals = pgTable(
  "repair_actuals",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    snapshotId: bigint("snapshot_id", { mode: "number" }),
    quoteId: text("quote_id"),
    vin: text("vin").notNull().default(""),
    actualBodyHours: numeric("actual_body_hours"),
    actualPaintHours: numeric("actual_paint_hours"),
    actualRiHours: numeric("actual_ri_hours"),
    actualPartsUsd: numeric("actual_parts_usd"),
    actualTotalUsd: numeric("actual_total_usd"),
    supplementUsd: numeric("supplement_usd"),
    hiddenDamageNotes: text("hidden_damage_notes"),
    completedOn: timestamp("completed_on", { withTimezone: true }),
    source: text("source").notNull().default("manual"), // manual | tracker | api
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("repair_actuals_vin_idx").on(t.vin)],
);

// Frozen monthly snapshots of the VPC Production Tracker sheet. Closed months
// are read from here; the current month stays live from the sheet. Values are
// stored exactly as typed in the sheet — never recomputed.
export const productionTracker = pgTable(
  "production_tracker",
  {
    vin: text("vin").notNull(),
    month: text("month").notNull(), // 'Jul 2026'
    retailPlanUsd: numeric("retail_plan_usd"),
    closedRoUsd: numeric("closed_ro_usd"),
    daysToClose: integer("days_to_close"),
    // RO Open Date, sheet column B, stored exactly as typed (never parsed).
    roOpen: text("ro_open"),
    snapshotAt: timestamp("snapshot_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.vin, t.month] })],
);

// Prior versions of frozen tracker months. Every re-snapshot archives the
// rows it replaces so a bad overwrite (empty/shrunken sheet read) is always
// reversible. Append-only.
export const productionTrackerArchive = pgTable("production_tracker_archive", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  vin: text("vin").notNull(),
  month: text("month").notNull(),
  retailPlanUsd: numeric("retail_plan_usd"),
  closedRoUsd: numeric("closed_ro_usd"),
  daysToClose: integer("days_to_close"),
  roOpen: text("ro_open"),
  snapshotAt: timestamp("snapshot_at", { withTimezone: true }),
  archivedAt: timestamp("archived_at", { withTimezone: true }).defaultNow().notNull(),
});

// Durable Google Sheets export queue. One row per export attempt request;
// survives restarts, retried with bounded backoff, visible to admins.
export const sheetExportJobs = pgTable("sheet_export_jobs", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  inspectionId: integer("inspection_id").notNull(),
  qcNumber: text("qc_number").notNull(),
  status: text("status").notNull().default("pending"), // pending | done | failed
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// Tombstones for deleted quotes: a queued photo upload from an offline device
// must never resurrect data under a quote id that was deliberately deleted.
export const deletedQuotes = pgTable("deleted_quotes", {
  id: text("id").primaryKey(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }).defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// Operations Handoff Workspace — collaboration tables (task #106)
// ---------------------------------------------------------------------------

// Append-only activity event log per vehicle. No updates or deletes ever.
export const vehicleActivityEvents = pgTable(
  "vehicle_activity_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    vin: varchar("vin").notNull(), // normalized UPPERCASE
    qcNumber: varchar("qc_number"), // optional
    eventType: varchar("event_type").notNull(),
    actorId: varchar("actor_id").notNull(),
    actorEmail: varchar("actor_email").notNull(),
    actorName: varchar("actor_name").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
    details: jsonb("details"),
  },
  (t) => [
    index("vehicle_activity_events_vin_idx").on(t.vin),
    index("vehicle_activity_events_qc_idx").on(t.qcNumber),
    index("vehicle_activity_events_occurred_idx").on(t.occurredAt),
  ],
);

// Soft-clearable flags per vehicle. Allowed kinds are enforced in route logic.
export const vehicleHandoffFlags = pgTable(
  "vehicle_handoff_flags",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    vin: varchar("vin").notNull(), // normalized UPPERCASE
    qcNumber: varchar("qc_number"),
    kind: varchar("kind").notNull(), // needs_wash | waiting_parts | manager_review | customer_vehicle | other
    note: varchar("note", { length: 300 }),
    active: boolean("active").notNull().default(true),
    creatorId: varchar("creator_id").notNull(),
    creatorEmail: varchar("creator_email").notNull(),
    creatorName: varchar("creator_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    clearerId: varchar("clearer_id"),
    clearerEmail: varchar("clearer_email"),
    clearerName: varchar("clearer_name"),
    clearedAt: timestamp("cleared_at", { withTimezone: true }),
  },
  (t) => [
    index("vehicle_handoff_flags_vin_idx").on(t.vin),
    index("vehicle_handoff_flags_active_idx").on(t.active, t.vin),
  ],
);

// Per-employee UI preferences (saved views, etc.). One row per employee.
export const employeePreferences = pgTable("employee_preferences", {
  employeeId: integer("employee_id").primaryKey(),
  data: jsonb("data").notNull().default(sql`'{}'::jsonb`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type Quote = typeof quotes.$inferSelect;
export type Intake = typeof intakes.$inferSelect;

export type Employee = typeof employees.$inferSelect;
export type Inspection = typeof inspections.$inferSelect;

export type VehicleActivityEvent = typeof vehicleActivityEvents.$inferSelect;
export type VehicleHandoffFlag = typeof vehicleHandoffFlags.$inferSelect;
export type EmployeePreferences = typeof employeePreferences.$inferSelect;
