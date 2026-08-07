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
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
    committedBy: text("committed_by"),
    overriddenBy: text("overridden_by"), // supervisor countersign; null on normal sign-off
  },
  (t) => [index("intakes_vin_idx").on(t.vin)],
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
    snapshotAt: timestamp("snapshot_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.vin, t.month] })],
);

export type Quote = typeof quotes.$inferSelect;
export type Intake = typeof intakes.$inferSelect;

export type Employee = typeof employees.$inferSelect;
export type Inspection = typeof inspections.$inferSelect;
