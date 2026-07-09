import { sql } from "drizzle-orm";
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  serial,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

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
  action: varchar("action").notNull(), // created | recheck_committed | status_change | imported | employee_updated | delete_attempt
  actorId: varchar("actor_id").notNull(),
  actorEmail: varchar("actor_email").notNull(),
  actorName: varchar("actor_name").notNull(),
  at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
  details: jsonb("details"),
});

export type Employee = typeof employees.$inferSelect;
export type Inspection = typeof inspections.$inferSelect;
