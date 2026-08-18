import type { Express } from "express";
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "./db";
import {
  auditLog,
  corrections,
  employees,
  inspections,
  intakes,
  photos,
  productionTracker,
  qcCounter,
  quotes,
  type Employee,
  type Inspection,
} from "@shared/schema";
import { isAuthenticated } from "./replit_integrations/auth";
import { requireAdmin, requireEmployee, resolveAccess } from "./access";
import { exportInspectionToSheet } from "./googleSheets";
import { registerIntakeQuoteRoute } from "./localQuote";
import { registerDashboardRoute, invalidateDashboardCache } from "./dashboard";
import { registerQuoterRoutes } from "./quoter";
import { registerQuoterSyncAdminRoute } from "./quoterSyncAdmin";
import { registerPinRoutes, hashPin, isValidPin } from "./pin";
import { registerAccuracyReportRoute } from "./quoteSnapshot";
import { registerTrackerRoutes } from "./tracker";
import { readJpegExifOrientation } from "./photoExif";

// ---------- helpers ----------
import { registerTrackerSyncAdminRoute } from "./trackerSyncAdmin";

function toClientRecord(row: Inspection) {
  const data = (row.data as Record<string, unknown>) || {};
  return {
    ...data,
    id: row.qcNumber,
    stock: row.stock,
    vehicle: row.vehicle,
    vin: row.vin,
    result: row.result,
    status: row.status,
    imported: row.imported,
    archived: row.archived,
    createdBy: { id: row.createdById, email: row.createdByEmail, name: row.createdByName },
    createdAt: row.createdAt.getTime(),
    updatedBy: { id: row.updatedById, email: row.updatedByEmail, name: row.updatedByName },
    updatedAt: row.updatedAt.getTime(),
  };
}

async function nextQcPreview(): Promise<number> {
  const [row] = await db.select().from(qcCounter).where(eq(qcCounter.id, 1));
  return (row?.value ?? 1000) + 1;
}

async function audit(
  tx: typeof db,
  emp: Employee,
  action: string,
  extra: { inspectionId?: number | null; qcNumber?: string | null; details?: unknown } = {}
) {
  await tx.insert(auditLog).values({
    inspectionId: extra.inspectionId ?? null,
    qcNumber: extra.qcNumber ?? null,
    action,
    actorId: emp.userId || String(emp.id),
    actorEmail: emp.email,
    actorName: emp.name,
    details: (extra.details as any) ?? null,
  });
}

// ---------- validation ----------

const checklistItem = z.object({
  item: z.string().max(300),
  mark: z.enum(["p", "f", "n"]),
  note: z.string().max(2000).optional(),
  photos: z.array(z.string().max(2_000_000)).max(12).optional(),
});

const createInspectionSchema = z.object({
  stock: z.string().trim().min(1).max(120),
  vehicle: z.string().trim().min(1).max(200),
  vin: z.string().trim().max(17),
  vinPhoto: z.string().max(2_000_000).nullable().optional(),
  optOut: z.record(z.string(), z.boolean()).optional().default({}),
  items: z.record(z.string(), z.array(checklistItem)),
  checked: z.number().int().min(0).max(1000),
  failCount: z.number().int().min(0).max(1000),
  sig: z.string().max(2_000_000).nullable().optional(),
});

const recheckItem = z.object({
  cat: z.string().max(60),
  item: z.string().max(300),
  origNote: z.string().max(2000).optional().default(""),
  repairedBy: z.string().max(300).optional().default(""),
  outcome: z.enum(["pass", "fail"]),
  note: z.string().max(2000).optional(),
  photos: z.array(z.string().max(2_000_000)).max(12).optional(),
});

const recheckSchema = z.object({
  sig: z.string().max(2_000_000).nullable().optional(),
  items: z.array(recheckItem).min(1).max(200),
});

const backupEmployee = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email()
    .refine((e) => e.endsWith("@truckranch.com"), "Backup employees must be @truckranch.com emails."),
  name: z.string().trim().max(120).optional().default(""),
  title: z.string().trim().max(120).optional().default("Inspector"),
  isAdmin: z.boolean().optional().default(false),
  status: z.enum(["pending", "active", "inactive"]).optional().default("pending"),
});

// Accepts ISO strings or epoch millis; invalid/absent values become null.
const backupDate = z.union([z.string().max(60), z.number()]).nullable().optional();
function toDate(v: string | number | null | undefined): Date | null {
  if (v == null) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

const backupQuote = z.object({
  id: z.string().min(1).max(200),
  data: z.unknown(),
  updatedAt: backupDate,
  committedBy: z.string().max(200).nullable().optional(),
  overriddenBy: z.string().max(200).nullable().optional(),
});

const backupIntake = z.object({
  id: z.string().min(1).max(200),
  vin: z.string().max(40),
  stock: z.string().max(120).optional().default(""),
  vehicle: z.string().max(200).optional().default(""),
  miles: z.string().max(40).optional().default(""),
  estimator: z.string().max(200).optional().default(""),
  quoteId: z.string().max(200).nullable().optional(),
  data: z.unknown(),
  completedAt: backupDate,
  updatedAt: backupDate,
  committedBy: z.string().max(200).nullable().optional(),
  overriddenBy: z.string().max(200).nullable().optional(),
});

const backupCorrection = z.object({
  id: z.number().int().positive().optional(),
  ts: z.number().int().positive(),
  diffs: z.unknown(),
});

const backupTrackerRow = z.object({
  vin: z.string().min(1).max(40),
  month: z.string().min(1).max(20),
  retailPlanUsd: z.union([z.string().max(30), z.number()]).nullable().optional(),
  closedRoUsd: z.union([z.string().max(30), z.number()]).nullable().optional(),
  daysToClose: z.number().int().nullable().optional(),
  snapshotAt: backupDate,
});

const backupQuoterSection = z.object({
  quotes: z.array(backupQuote).max(50_000).optional(),
  intakes: z.array(backupIntake).max(50_000).optional(),
  corrections: z.array(backupCorrection).max(100_000).optional(),
  productionTracker: z.array(backupTrackerRow).max(100_000).optional(),
});

// Full-export photos ride as base64; each row is one photo (bytea in the db).
const backupPhoto = z.object({
  id: z.string().min(1).max(200),
  quoteId: z.string().min(1).max(200),
  slot: z.string().max(100).nullable().optional(),
  mime: z.string().max(100),
  ts: z.number().int().positive(),
  b64: z.string().max(30_000_000),
});

const importSchema = z.object({
  app: z.string().max(120).optional(),
  version: z.number().int().min(1).max(10).optional(),
  exportedAt: z.string().max(60).optional(),
  seq: z.number().int().min(1000).max(1_000_000).optional(),
  employees: z.array(backupEmployee).max(500).optional(),
  quoter: backupQuoterSection.optional(),
  quoterPhotos: z.array(backupPhoto).max(5000).optional(),
  inspections: z
    .array(
      z
        .object({
          // Backups from this app carry their FQ number; converted backups from
          // the old Truck Recon Checklist app omit it and the server assigns one.
          id: z.string().regex(/^FQ-\d{1,7}$/).optional(),
          ts: z.number().int().positive(),
          stock: z.string().max(120).default(""),
          vehicle: z.string().max(200).default(""),
          vin: z.string().max(17).default(""),
          result: z.enum(["pass", "fail"]),
          status: z.enum(["pass", "open", "cleared"]),
        })
        .passthrough()
    )
    .max(2000)
    .optional()
    .default([]),
});

// ---------- shared helpers ----------

// EXIF orientation parsing lives in ./photoExif (imported above) — this file
// previously carried a private duplicate, which risked the two copies drifting
// apart when the parser is hardened. All scan routes now use the shared export.

// ---------- routes ----------

export function registerAppRoutes(app: Express) {
  registerIntakeQuoteRoute(app);
  registerDashboardRoute(app);
  registerQuoterRoutes(app);
  registerQuoterSyncAdminRoute(app);
  registerTrackerSyncAdminRoute(app);
  registerPinRoutes(app);
  registerAccuracyReportRoute(app);
  registerTrackerRoutes(app);

  app.get("/api/health", async (_req, res) => {
    try {
      await db.execute(sql`SELECT 1`);
      res.json({ ok: true });
    } catch {
      res.status(500).json({ ok: false });
    }
  });

  // Who am I + access state (safe for any authenticated user, no app data).
  app.get("/api/me", isAuthenticated, async (req: any, res, next) => {
    try {
      const state = await resolveAccess(req);
      res.json({
        access: state.access,
        email: state.email,
        employee:
          state.employee
            ? {
                id: state.employee.id,
                userId: state.employee.userId,
                email: state.employee.email,
                name: state.employee.name,
                title: state.employee.title,
                isAdmin: state.employee.isAdmin,
                status: state.employee.status,
              }
            : null,
      });
    } catch (err) {
      next(err);
    }
  });

  // Everything the app needs on load, in one round trip.
  app.get("/api/bootstrap", requireEmployee, async (req: any, res, next) => {
    try {
      const rows = await db.select().from(inspections).orderBy(desc(inspections.createdAt));
      const emps = await db
        .select({
          id: employees.id,
          email: employees.email,
          name: employees.name,
          title: employees.title,
          status: employees.status,
        })
        .from(employees)
        .where(eq(employees.status, "active"));
      res.json({
        inspections: rows.map(toClientRecord),
        employees: emps,
        nextQc: await nextQcPreview(),
      });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/inspections", requireEmployee, async (_req, res, next) => {
    try {
      const rows = await db.select().from(inspections).orderBy(desc(inspections.createdAt));
      res.json(rows.map(toClientRecord));
    } catch (err) {
      next(err);
    }
  });

  // Create an inspection. The server assigns the FQ number inside a transaction,
  // and all attribution comes from the authenticated session — never the client.
  app.post("/api/inspections", requireEmployee, async (req: any, res, next) => {
    try {
      const body = createInspectionSchema.parse(req.body);
      const emp: Employee = req.employee;
      const status = body.failCount > 0 ? "open" : "pass";
      const result = body.failCount > 0 ? "fail" : "pass";
      const now = Date.now();

      const failItems: { cat: string; item: string; note: string; photos: string[] }[] = [];
      for (const [cat, arr] of Object.entries(body.items)) {
        for (const it of arr) {
          if (it.mark === "f") failItems.push({ cat, item: it.item, note: it.note || "", photos: it.photos || [] });
        }
      }

      const vinNorm = String(body.vin).trim().toUpperCase();

      const created = await db.transaction(async (tx) => {
        // Guard: one original Final QC per truck. A VIN that already has an
        // inspection must go through the re-check flow, never a second FQ.
        if (vinNorm.length >= 6) {
          // Serialize concurrent commits for the same VIN: without this lock,
          // two simultaneous POSTs could both pass the duplicate check and each
          // insert an original inspection. Released automatically at commit.
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${vinNorm}))`);
          const dup = await tx.execute(
            sql`SELECT qc_number FROM inspections WHERE upper(trim(vin)) = ${vinNorm} LIMIT 1`
          );
          const hit = (dup.rows as any[])[0];
          if (hit) return { error: 409 as const, qcNumber: String(hit.qc_number) };
        }

        const counterRes = await tx.execute(
          sql`UPDATE qc_counter SET value = value + 1 WHERE id = 1 RETURNING value`
        );
        const seq = Number((counterRes.rows[0] as any).value);
        const qcNumber = `FQ-${seq}`;

        const data = {
          ts: now,
          vinPhoto: body.vinPhoto || null,
          inspector: emp.name,
          title: emp.title,
          clearedTs: null,
          rechecks: [],
          optOut: body.optOut,
          items: body.items,
          checked: body.checked,
          failCount: body.failCount,
          sig: body.sig || null,
          committed: true,
          openItems: status === "open" ? failItems : [],
        };

        const [row] = await tx
          .insert(inspections)
          .values({
            qcNumber,
            stock: body.stock,
            vehicle: body.vehicle,
            vin: vinNorm,
            result,
            status,
            data,
            createdById: emp.userId || String(emp.id),
            createdByEmail: emp.email,
            createdByName: emp.name,
            updatedById: emp.userId || String(emp.id),
            updatedByEmail: emp.email,
            updatedByName: emp.name,
          })
          .returning();

        await audit(tx as any, emp, "created", {
          inspectionId: row.id,
          qcNumber,
          details: { result, status, failCount: body.failCount },
        });
        return { row };
      });

      if ("error" in created) {
        return res.status(409).json({
          message: `This VIN already has a Final QC inspection (${created.qcNumber}). Use the re-check flow instead.`,
          qcNumber: created.qcNumber,
        });
      }

      // Fire-and-forget: sheet export never blocks or fails the inspection.
      void exportInspectionToSheet(created.row);
      invalidateDashboardCache(); // the new inspection leaves "awaiting Final QC" immediately
      res.status(201).json({ record: toClientRecord(created.row), nextQc: await nextQcPreview() });
    } catch (err) {
      next(err);
    }
  });

  // Commit a re-check cycle. Inspector attribution and timestamps are server-side.
  app.post("/api/inspections/:qc/recheck", requireEmployee, async (req: any, res, next) => {
    try {
      const qc = String(req.params.qc);
      const body = recheckSchema.parse(req.body);
      const emp: Employee = req.employee;

      for (const it of body.items) {
        if (it.outcome === "fail" && (!it.note?.trim() || !(it.photos || []).length)) {
          return res.status(400).json({ message: "A re-failed item needs a new note and photo." });
        }
      }

      const updated = await db.transaction(async (tx) => {
        const [row] = await tx.select().from(inspections).where(eq(inspections.qcNumber, qc)).for("update");
        if (!row) return { error: 404 as const };
        if (row.status !== "open") return { error: 409 as const };

        const data = (row.data as any) || {};

        // Integrity check: the submitted items must exactly cover the currently
        // open failed items on this inspection — no additions, drops, or renames.
        const keyOf = (x: { cat?: string; item?: string }) =>
          `${String(x.cat || "").trim().toLowerCase()}\u0000${String(x.item || "").trim().toLowerCase()}`;
        const openKeys = ((data.openItems as any[]) || []).map(keyOf).sort();
        const sentKeys = body.items.map(keyOf).sort();
        if (
          openKeys.length !== sentKeys.length ||
          openKeys.some((k, idx) => k !== sentKeys[idx])
        ) {
          return { error: 400 as const };
        }

        const now = Date.now();
        const cycle = {
          ts: now,
          inspector: emp.name,
          title: emp.title,
          sig: body.sig || null,
          items: body.items,
        };
        const still = body.items
          .filter((x) => x.outcome === "fail")
          .map((x) => ({ cat: x.cat, item: x.item, note: x.note || "", photos: x.photos || [] }));
        const newStatus = still.length ? "open" : "cleared";
        const newData = {
          ...data,
          rechecks: [...(data.rechecks || []), cycle],
          openItems: still,
          clearedTs: still.length ? null : now,
        };

        const [saved] = await tx
          .update(inspections)
          .set({
            status: newStatus,
            data: newData,
            updatedById: emp.userId || String(emp.id),
            updatedByEmail: emp.email,
            updatedByName: emp.name,
            updatedAt: new Date(),
          })
          .where(eq(inspections.id, row.id))
          .returning();

        await audit(tx as any, emp, "recheck_committed", {
          inspectionId: row.id,
          qcNumber: qc,
          details: { stillOpen: still.length, outcome: newStatus },
        });
        if (newStatus !== row.status) {
          await audit(tx as any, emp, "status_change", {
            inspectionId: row.id,
            qcNumber: qc,
            details: { from: row.status, to: newStatus },
          });
        }
        return { row: saved };
      });

      if ("error" in updated) {
        const code: number = updated.error ?? 500;
        const message =
          code === 404
            ? "Inspection not found."
            : code === 400
            ? "Re-check items do not match this inspection's open items. Reload and try again."
            : "Inspection is not open for re-check.";
        return res.status(code).json({ message });
      }
      // A clearing re-check means the unit finally passed QC — export it now.
      // Fire-and-forget: sheet export never blocks or fails the re-check.
      if (updated.row!.status === "cleared") void exportInspectionToSheet(updated.row!);
      invalidateDashboardCache(); // re-check outcomes change dash counts right away
      res.json({ record: toClientRecord(updated.row!) });
    } catch (err) {
      next(err);
    }
  });

  // Deletion is not part of the app; log the attempt in the audit history.
  app.delete("/api/inspections/:qc", requireEmployee, async (req: any, res) => {
    const emp: Employee = req.employee;
    await audit(db, emp, "delete_attempt", { qcNumber: String(req.params.qc) });
    res.status(405).json({ message: "Inspections are permanent records and cannot be deleted." });
  });

  app.get("/api/inspections/:qc/history", requireEmployee, async (req, res, next) => {
    try {
      const rows = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.qcNumber, String(req.params.qc)))
        .orderBy(desc(auditLog.at));
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  // When did the team last take an authoritative server backup? Read from the
  // audit log ("exported" actions) so any admin's export counts, on any device.
  app.get("/api/backup-status", requireAdmin, async (_req, res, next) => {
    try {
      const [row] = await db
        .select({ at: auditLog.at })
        .from(auditLog)
        .where(eq(auditLog.action, "exported"))
        .orderBy(desc(auditLog.at))
        .limit(1);
      res.json({ lastExportAt: row ? row.at.toISOString() : null });
    } catch (err) {
      next(err);
    }
  });

  // Authoritative server-side backup: inspections, employee allowlist, and the
  // QC counter, straight from the database — never rebuilt from client state.
  // ?photos=full streams every photo's binary (as base64) into the file —
  // hundreds of MB — one row at a time, never all in memory at once. The
  // default export carries photo metadata only.
  app.get("/api/export", requireAdmin, async (req: any, res, next) => {
    try {
      const emp: Employee = req.employee;
      const includePhotos = String(req.query.photos || "") === "full";

      const rows = await db.select().from(inspections).orderBy(desc(inspections.createdAt));
      const emps = await db.select().from(employees).orderBy(employees.email);
      const [counterRow] = await db.select().from(qcCounter).where(eq(qcCounter.id, 1));
      const seq = counterRow?.value ?? 1000;

      const quoteRows = await db.select().from(quotes);
      const intakeRows = await db.select().from(intakes);
      const correctionRows = await db.select().from(corrections).orderBy(corrections.id);
      const trackerRows = await db.select().from(productionTracker);
      // Metadata only — never pull the bytea column for the whole table.
      const photoMetaRes = await db.execute(
        sql`SELECT id, quote_id, slot, mime, ts, length(data) AS bytes FROM photos ORDER BY ts`
      );
      const photosMeta = (photoMetaRes.rows as any[]).map((p) => ({
        id: String(p.id),
        quoteId: String(p.quote_id),
        slot: p.slot ?? null,
        mime: String(p.mime),
        ts: Number(p.ts),
        bytes: Number(p.bytes),
      }));

      const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

      const backup = {
        app: "TruckRanch Final QC",
        version: 2,
        exportedAt: new Date().toISOString(),
        photosIncluded: includePhotos,
        seq,
        inspections: rows.map(toClientRecord),
        // Never export PIN hashes or internal linkage — only allowlist facts.
        employees: emps.map((e) => ({
          email: e.email,
          name: e.name,
          title: e.title,
          isAdmin: e.isAdmin,
          status: e.status,
        })),
        quoter: {
          quotes: quoteRows.map((q) => ({
            id: q.id,
            data: q.data,
            updatedAt: iso(q.updatedAt),
            committedBy: q.committedBy,
            overriddenBy: q.overriddenBy,
          })),
          intakes: intakeRows.map((i) => ({
            id: i.id,
            vin: i.vin,
            stock: i.stock,
            vehicle: i.vehicle,
            miles: i.miles,
            estimator: i.estimator,
            quoteId: i.quoteId,
            data: i.data,
            completedAt: iso(i.completedAt),
            updatedAt: iso(i.updatedAt),
            committedBy: i.committedBy,
            overriddenBy: i.overriddenBy,
          })),
          corrections: correctionRows.map((c) => ({ id: c.id, ts: c.ts, diffs: c.diffs })),
          productionTracker: trackerRows.map((t) => ({
            vin: t.vin,
            month: t.month,
            retailPlanUsd: t.retailPlanUsd,
            closedRoUsd: t.closedRoUsd,
            daysToClose: t.daysToClose,
            snapshotAt: iso(t.snapshotAt),
          })),
          photos: photosMeta,
        },
      };

      await audit(db, emp, "exported", {
        details: {
          inspections: rows.length,
          employees: emps.length,
          quotes: quoteRows.length,
          intakes: intakeRows.length,
          corrections: correctionRows.length,
          trackerRows: trackerRows.length,
          photos: photosMeta.length,
          photosIncluded: includePhotos,
          seq,
        },
      });
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="TruckRanch_FinalQC_backup_${includePhotos ? "full_" : ""}${new Date().toISOString().slice(0, 10)}.json"`
      );
      if (!includePhotos) return res.json(backup);

      // Stream: metadata head + one photo row at a time, so 400+ MB of photo
      // data never sits in server memory as a single string.
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      const head = JSON.stringify(backup);
      res.write(head.slice(0, -1) + ',"quoterPhotos":[');
      let first = true;
      for (const m of photosMeta) {
        const one = await db.execute(sql`SELECT data FROM photos WHERE id = ${m.id}`);
        const row = (one.rows as any[])[0];
        if (!row) continue;
        const buf = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
        const chunk =
          (first ? "" : ",") +
          JSON.stringify({ id: m.id, quoteId: m.quoteId, slot: m.slot, mime: m.mime, ts: m.ts, b64: buf.toString("base64") });
        first = false;
        // Respect backpressure so a slow client can't balloon server memory.
        if (!res.write(chunk)) await new Promise((r) => res.once("drain", r));
      }
      res.write("]}");
      res.end();
    } catch (err) {
      next(err);
    }
  });

  // Backup restore + one-time migration of legacy localStorage data.
  // Additive only: duplicates are skipped, existing rows are never overwritten.
  app.post("/api/import", requireEmployee, async (req: any, res, next) => {
    try {
      const parsed = importSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          message: "That file doesn't look like a valid Final QC backup — nothing was imported.",
          issues: parsed.error.issues.slice(0, 5),
        });
      }
      const body = parsed.data;
      const emp: Employee = req.employee;
      const hasQuoterData =
        !!body.quoterPhotos?.length ||
        !!(body.quoter && Object.values(body.quoter).some((arr) => (arr as any[])?.length));
      if ((body.employees?.length || hasQuoterData) && !emp.isAdmin) {
        return res.status(403).json({ message: "Only admins can restore employees or Quoter data from a backup." });
      }
      let imported = 0;
      let skipped = 0;
      let employeesAdded = 0;
      let employeesSkipped = 0;
      const qc = {
        quotesAdded: 0,
        quotesSkipped: 0,
        intakesAdded: 0,
        intakesSkipped: 0,
        correctionsAdded: 0,
        correctionsSkipped: 0,
        trackerRowsAdded: 0,
        trackerRowsSkipped: 0,
        photosAdded: 0,
        photosSkipped: 0,
      };

      await db.transaction(async (tx) => {
        // For legacy records (no FQ number), duplicates are recognized by
        // VIN + original timestamp of previously imported records — re-importing
        // the same old-app file must not create a second copy.
        const seenRes = await tx.execute(
          sql`SELECT vin, data->>'ts' AS ts FROM inspections WHERE imported = true`
        );
        const seen = new Set((seenRes.rows as any[]).map((r) => `${r.vin}|${r.ts}`));

        for (const rec of body.inspections) {
          let { id } = rec as any;
          const { ts, stock, vehicle, vin, result, status, ...rest } = rec as any;
          delete rest.id;
          if (!id) {
            const key = `${(vin || "").trim().toUpperCase()}|${ts}`;
            if (seen.has(key)) {
              skipped++;
              continue;
            }
            seen.add(key);
            // Legacy record without an FQ number — allocate one atomically so it
            // can never collide with concurrent inspections or other imports.
            const counterRes = await tx.execute(
              sql`UPDATE qc_counter SET value = value + 1 WHERE id = 1 RETURNING value`
            );
            id = `FQ-${Number((counterRes.rows[0] as any).value)}`;
          }
          const [row] = await tx
            .insert(inspections)
            .values({
              qcNumber: id,
              stock: stock || "",
              vehicle: vehicle || "",
              vin: (vin || "").trim().toUpperCase(),
              result,
              status,
              data: { ...rest, ts, inspector: rest.inspector || emp.name, title: rest.title || emp.title },
              imported: true,
              createdById: emp.userId || String(emp.id),
              createdByEmail: emp.email,
              createdByName: emp.name,
              updatedById: emp.userId || String(emp.id),
              updatedByEmail: emp.email,
              updatedByName: emp.name,
              createdAt: new Date(ts),
              updatedAt: new Date(ts),
            })
            .onConflictDoNothing({ target: inspections.qcNumber })
            .returning();
          if (row) {
            imported++;
            await audit(tx as any, emp, "imported", { inspectionId: row.id, qcNumber: id });
          } else {
            skipped++;
          }
        }

        // Merge missing employee allowlist rows. Existing rows are never
        // touched — roles, status, PINs, and linkage stay exactly as they are.
        for (const be of body.employees || []) {
          const [row] = await tx
            .insert(employees)
            .values({
              email: be.email,
              name: be.name,
              title: be.title,
              isAdmin: be.isAdmin,
              status: be.status,
            })
            .onConflictDoNothing({ target: employees.email })
            .returning();
          if (row) employeesAdded++;
          else employeesSkipped++;
        }

        // Merge missing Quoter rows — additive only, existing rows untouched.
        for (const q of body.quoter?.quotes || []) {
          const [row] = await tx
            .insert(quotes)
            .values({
              id: q.id,
              data: (q.data as any) ?? {},
              updatedAt: toDate(q.updatedAt),
              committedBy: q.committedBy ?? null,
              overriddenBy: q.overriddenBy ?? null,
            })
            .onConflictDoNothing({ target: quotes.id })
            .returning();
          if (row) qc.quotesAdded++;
          else qc.quotesSkipped++;
        }
        for (const i of body.quoter?.intakes || []) {
          const [row] = await tx
            .insert(intakes)
            .values({
              id: i.id,
              vin: i.vin,
              stock: i.stock,
              vehicle: i.vehicle,
              miles: i.miles,
              estimator: i.estimator,
              quoteId: i.quoteId ?? null,
              data: (i.data as any) ?? {},
              completedAt: toDate(i.completedAt),
              updatedAt: toDate(i.updatedAt),
              committedBy: i.committedBy ?? null,
              overriddenBy: i.overriddenBy ?? null,
            })
            .onConflictDoNothing({ target: intakes.id })
            .returning();
          if (row) qc.intakesAdded++;
          else qc.intakesSkipped++;
        }
        for (const c of body.quoter?.corrections || []) {
          // Keep original ids when present so a restore into a fresh database
          // preserves history; a colliding id means the row already exists.
          const [row] = await tx
            .insert(corrections)
            .values(c.id != null ? { id: c.id, ts: c.ts, diffs: (c.diffs as any) ?? [] } : { ts: c.ts, diffs: (c.diffs as any) ?? [] })
            .onConflictDoNothing()
            .returning();
          if (row) qc.correctionsAdded++;
          else qc.correctionsSkipped++;
        }
        if (body.quoter?.corrections?.some((c) => c.id != null)) {
          // Explicit-id inserts don't advance the bigserial sequence — fix it up
          // so future corrections never collide with restored ids.
          await tx.execute(
            sql`SELECT setval(pg_get_serial_sequence('corrections','id'), (SELECT COALESCE(MAX(id),1) FROM corrections))`
          );
        }
        for (const t of body.quoter?.productionTracker || []) {
          const [row] = await tx
            .insert(productionTracker)
            .values({
              vin: t.vin,
              month: t.month,
              retailPlanUsd: t.retailPlanUsd == null ? null : String(t.retailPlanUsd),
              closedRoUsd: t.closedRoUsd == null ? null : String(t.closedRoUsd),
              daysToClose: t.daysToClose ?? null,
              snapshotAt: toDate(t.snapshotAt),
            })
            .onConflictDoNothing()
            .returning();
          if (row) qc.trackerRowsAdded++;
          else qc.trackerRowsSkipped++;
        }
        for (const p of body.quoterPhotos || []) {
          const [row] = await tx
            .insert(photos)
            .values({
              id: p.id,
              quoteId: p.quoteId,
              slot: p.slot ?? null,
              mime: p.mime,
              ts: p.ts,
              data: Buffer.from(p.b64, "base64"),
            })
            .onConflictDoNothing({ target: photos.id })
            .returning();
          if (row) qc.photosAdded++;
          else qc.photosSkipped++;
        }

        // Never hand out a number at or below anything we've seen.
        const nums = body.inspections
          .map((r) => parseInt(String(r.id).replace("FQ-", ""), 10))
          .filter((n) => Number.isFinite(n));
        const maxSeen = Math.max(0, ...(nums.length ? nums : [0]), (body.seq || 1001) - 1);
        await tx.execute(sql`UPDATE qc_counter SET value = GREATEST(value, ${maxSeen}) WHERE id = 1`);

        await audit(tx as any, emp, "import_summary", {
          details: { imported, skipped, employeesAdded, employeesSkipped, ...qc, seq: body.seq ?? null },
        });
      });

      res.json({ imported, skipped, employeesAdded, employeesSkipped, quoter: qc, nextQc: await nextQcPreview() });
    } catch (err) {
      next(err);
    }
  });

  // ---------- admin: employee allowlist ----------

  app.get("/api/employees", requireAdmin, async (_req, res, next) => {
    try {
      const rows = await db.select().from(employees).orderBy(employees.email);
      // Never send the PIN hash to the client — only whether one is set.
      res.json(rows.map(({ pinHash, ...rest }) => ({ ...rest, hasPin: !!pinHash })));
    } catch (err) {
      next(err);
    }
  });

  const employeePatchSchema = z.object({
    status: z.enum(["pending", "active", "inactive"]).optional(),
    isAdmin: z.boolean().optional(),
    name: z.string().trim().max(120).optional(),
    title: z.string().trim().max(120).optional(),
    canOverride: z.boolean().optional(),
    active: z.boolean().optional(),
  });

  const employeeCreateSchema = z.object({
    email: z
      .string()
      .trim()
      .toLowerCase()
      .email()
      .refine((e) => e.endsWith("@truckranch.com"), "Only @truckranch.com emails can be approved."),
    name: z.string().trim().max(120).optional().default(""),
    title: z.string().trim().max(120).optional().default("Inspector"),
  });

  // Pre-approve an employee email before they first sign in.
  app.post("/api/employees", requireAdmin, async (req: any, res, next) => {
    try {
      const body = employeeCreateSchema.parse(req.body);
      const [row] = await db
        .insert(employees)
        .values({ email: body.email, name: body.name, title: body.title, status: "active" })
        .onConflictDoNothing({ target: employees.email })
        .returning();
      if (!row) return res.status(409).json({ message: "That email is already on the list." });
      await audit(db, req.employee, "employee_updated", { details: { email: body.email, change: "pre_approved" } });
      res.status(201).json(row);
    } catch (err) {
      next(err);
    }
  });

  app.patch("/api/employees/:id", requireAdmin, async (req: any, res, next) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
      const body = employeePatchSchema.parse(req.body);
      const me: Employee = req.employee;

      if (id === me.id && (body.status === "inactive" || body.isAdmin === false)) {
        return res.status(400).json({ message: "You cannot deactivate or demote your own account." });
      }

      const [row] = await db
        .update(employees)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(employees.id, id))
        .returning();
      if (!row) return res.status(404).json({ message: "Employee not found." });
      await audit(db, me, "employee_updated", { details: { email: row.email, change: body } });
      const { pinHash, ...safe } = row;
      res.json({ ...safe, hasPin: !!pinHash });
    } catch (err) {
      next(err);
    }
  });

  // Set or reset an employee's 4-digit sign-off PIN. Admin-only; the PIN is
  // hashed before storage and is never read back — a forgotten PIN is reset.
  const pinSetSchema = z.object({ pin: z.string().regex(/^\d{4}$/, "PIN must be 4 digits") });
  app.post("/api/employees/:id/pin", requireAdmin, async (req: any, res, next) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
      const { pin } = pinSetSchema.parse(req.body);
      if (!isValidPin(pin)) return res.status(400).json({ message: "PIN must be 4 digits" });
      const me: Employee = req.employee;
      const pinHash = await hashPin(pin);
      const [row] = await db
        .update(employees)
        .set({ pinHash, updatedAt: new Date() })
        .where(eq(employees.id, id))
        .returning();
      if (!row) return res.status(404).json({ message: "Employee not found." });
      await audit(db, me, "employee_updated", { details: { email: row.email, change: "pin_reset" } });
      res.json({ ok: true, hasPin: true });
    } catch (err) {
      next(err);
    }
  });

  // ---------- admin: unlock body quotes for editing ----------
  // Legacy quote-level sign-offs (the old "Commit quote" button, since
  // removed) left quotes.committed_by set, which silently blocks every
  // adjustment save. The intake SAVE is the one sign-off now, so quote-level
  // locks are vestigial — clear them all. Idempotent: already-unlocked rows
  // are untouched.
  app.post("/api/admin/unlock-quotes", requireAdmin, async (req: any, res, next) => {
    try {
      const emp: Employee = req.employee;
      const updated = await db
        .update(quotes)
        .set({ committedBy: null, overriddenBy: null })
        .where(sql`${quotes.committedBy} IS NOT NULL`)
        .returning({ id: quotes.id });
      if (updated.length) {
        await audit(db, emp, "quotes_unlocked", {
          details: { unlocked: updated.length },
        });
      }
      res.json({ unlocked: updated.length });
    } catch (err) {
      next(err);
    }
  });

  // ---------- admin: scan photos for EXIF orientation issues ----------
  // Returns photo IDs whose JPEG EXIF Orientation tag is anything other than 1
  // (upright). The admin UI fetches these, applies the client-side EXIF-aware
  // canvas path (orientedJpegDataUrl), and re-uploads each one so it is stored
  // upright with the orientation tag stripped. quoteId is required; call once
  // per truck to avoid holding large blobs in memory server-side.
  app.get(
    "/api/admin/photo-orientation-candidates",
    requireAdmin,
    async (req: any, res, next) => {
      try {
        const quoteId = String(req.query.quoteId || "").slice(0, 60);
        if (!quoteId) {
          return res.status(400).json({ error: "quoteId is required" });
        }
        const rows = await db
          .select({ id: photos.id, slot: photos.slot, quoteId: photos.quoteId, data: photos.data })
          .from(photos)
          .where(eq(photos.quoteId, quoteId));

        const candidates: { id: string; slot: string | null; quoteId: string; orientation: number }[] = [];
        for (const row of rows) {
          const buf = row.data as Buffer;
          const orientation = readJpegExifOrientation(buf);
          // orientation === null → no EXIF tag → image already stored upright (or isn't JPEG)
          // orientation === 1   → explicitly upright
          // anything else       → needs rotation
          if (orientation !== null && orientation !== 1) {
            candidates.push({ id: row.id, slot: row.slot, quoteId: row.quoteId, orientation });
          }
        }
        res.set("Cache-Control", "no-store");
        res.json({ scanned: rows.length, candidates });
      } catch (err) {
        next(err);
      }
    },
  );

  // ---------- admin: scan ALL photos for EXIF orientation issues ----------
  // Pages through every photo in the DB (PAGE_SIZE rows at a time) and returns
  // the sideways ones for this page. The client calls repeatedly with an
  // increasing offset until done:true, accumulating candidates across pages so
  // the whole table is checked without a single long-running query.
  //
  // PAGE-RELOAD SAFETY: Photos fixed by runFleetFix / runPhotoFix are
  // re-uploaded as canvas.toDataURL() JPEGs, which carry no EXIF APP1
  // segment. readJpegExifOrientation() returns null for those bytes; the
  // filter below (orientation !== null && orientation !== 1) excludes null,
  // so already-fixed photos never reappear as candidates in a fresh scan
  // after a page reload — no client-side "fixed IDs" set is required.
  const SCAN_PAGE_SIZE = 100;
  app.get(
    "/api/admin/photo-orientation-scan-all",
    requireAdmin,
    async (req: any, res, next) => {
      try {
        const offset = Math.max(0, Number(req.query.offset) || 0);

        const page = await db
          .select({ id: photos.id, slot: photos.slot, quoteId: photos.quoteId, data: photos.data })
          .from(photos)
          .orderBy(photos.id)
          .limit(SCAN_PAGE_SIZE)
          .offset(offset);

        const candidates: { id: string; slot: string | null; quoteId: string; orientation: number }[] = [];
        for (const row of page) {
          const buf = row.data as Buffer;
          const orientation = readJpegExifOrientation(buf);
          if (orientation !== null && orientation !== 1) {
            candidates.push({ id: row.id, slot: row.slot, quoteId: row.quoteId, orientation });
          }
        }

        res.set("Cache-Control", "no-store");
        res.json({
          offset,
          scanned: page.length,
          done: page.length < SCAN_PAGE_SIZE,
          candidates,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // ---------- admin: repair migrated re-checks ----------
  // Imported "open" inspections from the old app arrived without data.openItems,
  // so the re-check screen has nothing to work against. Rebuild that list from
  // the saved checklist (items marked "f"); rows with zero failed items were
  // mislabeled during migration and are cleared as passed. Idempotent — rows
  // that already have openItems are untouched.
  app.post("/api/admin/repair-imported-rechecks", requireAdmin, async (req: any, res, next) => {
    try {
      const emp: Employee = req.employee;
      const rows = await db
        .select()
        .from(inspections)
        .where(sql`status = 'open' AND imported = true AND data->'openItems' IS NULL`);
      let rebuilt = 0;
      let cleared = 0;
      for (const row of rows) {
        const data: any = row.data || {};
        const failItems: { cat: string; item: string; note: string; photos: string[] }[] = [];
        for (const [cat, arr] of Object.entries(data.items || {})) {
          if (!Array.isArray(arr)) continue;
          for (const it of arr as any[]) {
            if (it && it.mark === "f") {
              failItems.push({ cat, item: String(it.item || ""), note: String(it.note || ""), photos: Array.isArray(it.photos) ? it.photos : [] });
            }
          }
        }
        const base = { ...data, rechecks: Array.isArray(data.rechecks) ? data.rechecks : [] };
        const patch =
          failItems.length === 0
            ? { status: "cleared", data: { ...base, openItems: [], clearedTs: Date.now() } }
            : { data: { ...base, openItems: failItems, clearedTs: base.clearedTs ?? null } };
        // Re-assert eligibility in the UPDATE itself: if a concurrent repair
        // (or an inspector re-check after one) already touched this row, our
        // snapshot is stale and writing it back would clobber newer state.
        const updated = await db
          .update(inspections)
          .set({
            ...patch,
            updatedById: emp.userId || String(emp.id),
            updatedByEmail: emp.email,
            updatedByName: emp.name,
            updatedAt: new Date(),
          })
          .where(sql`${inspections.id} = ${row.id} AND status = 'open' AND imported = true AND data->'openItems' IS NULL`)
          .returning({ id: inspections.id });
        if (!updated.length) continue; // someone else repaired it first — skip
        if (failItems.length === 0) cleared += 1;
        else rebuilt += 1;
        await audit(db, emp, "imported_recheck_repaired", {
          inspectionId: row.id,
          qcNumber: row.qcNumber,
          details: failItems.length === 0 ? { cleared: true } : { openItems: failItems.length },
        });
      }
      if (rows.length) invalidateDashboardCache();
      res.json({ scanned: rows.length, rebuilt, cleared });
    } catch (err) {
      next(err);
    }
  });

  // ---------- admin: archive units imported from the old app ----------
  // Archived inspections stay fully viewable (bootstrap/records) but are
  // excluded from every dashboard and report aggregation. Idempotent.
  app.post("/api/admin/archive-imported", requireAdmin, async (req: any, res, next) => {
    try {
      const emp: Employee = req.employee;
      const updated = await db
        .update(inspections)
        .set({
          archived: true,
          updatedById: emp.userId || String(emp.id),
          updatedByEmail: emp.email,
          updatedByName: emp.name,
          updatedAt: new Date(),
        })
        .where(sql`imported = true AND archived = false`)
        .returning({ qcNumber: inspections.qcNumber });
      if (updated.length) {
        await audit(db, emp, "archived_imported", { details: { count: updated.length } });
        invalidateDashboardCache();
      }
      res.json({ archived: updated.length });
    } catch (err) {
      next(err);
    }
  });

  // ---------- admin: archive/unarchive a single inspection ----------
  app.post("/api/admin/archive", requireAdmin, async (req: any, res, next) => {
    try {
      const emp: Employee = req.employee;
      const qcNumber = String(req.body?.qcNumber || "").trim();
      const archived = req.body?.archived === true;
      if (!qcNumber) return res.status(400).json({ message: "qcNumber required" });
      const updated = await db
        .update(inspections)
        .set({
          archived,
          updatedById: emp.userId || String(emp.id),
          updatedByEmail: emp.email,
          updatedByName: emp.name,
          updatedAt: new Date(),
        })
        .where(eq(inspections.qcNumber, qcNumber))
        .returning({ id: inspections.id, qcNumber: inspections.qcNumber });
      if (!updated.length) return res.status(404).json({ message: "Not found" });
      await audit(db, emp, archived ? "archived" : "unarchived", {
        inspectionId: updated[0].id,
        qcNumber,
      });
      invalidateDashboardCache();
      res.json({ qcNumber, archived });
    } catch (err) {
      next(err);
    }
  });
}
