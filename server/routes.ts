import type { Express } from "express";
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "./db";
import { auditLog, employees, inspections, qcCounter, type Employee, type Inspection } from "@shared/schema";
import { isAuthenticated } from "./replit_integrations/auth";
import { requireAdmin, requireEmployee, resolveAccess } from "./access";
import { exportInspectionToSheet } from "./googleSheets";

// ---------- helpers ----------

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

const importSchema = z.object({
  seq: z.number().int().min(1001).max(1_000_000).optional(),
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
    .max(2000),
});

// ---------- routes ----------

export function registerAppRoutes(app: Express) {
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

      const created = await db.transaction(async (tx) => {
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
            vin: body.vin.toUpperCase(),
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
        return row;
      });

      // Fire-and-forget: sheet export never blocks or fails the inspection.
      void exportInspectionToSheet(created);
      res.status(201).json({ record: toClientRecord(created), nextQc: await nextQcPreview() });
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

  // One-time migration of legacy localStorage data. Duplicate FQ numbers are skipped.
  app.post("/api/import", requireEmployee, async (req: any, res, next) => {
    try {
      const body = importSchema.parse(req.body);
      const emp: Employee = req.employee;
      let imported = 0;
      let skipped = 0;

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
            const key = `${(vin || "").toUpperCase()}|${ts}`;
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
              vin: (vin || "").toUpperCase(),
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

        // Never hand out a number at or below anything we've seen.
        const nums = body.inspections
          .map((r) => parseInt(String(r.id).replace("FQ-", ""), 10))
          .filter((n) => Number.isFinite(n));
        const maxSeen = Math.max(0, ...(nums.length ? nums : [0]), (body.seq || 1001) - 1);
        await tx.execute(sql`UPDATE qc_counter SET value = GREATEST(value, ${maxSeen}) WHERE id = 1`);
      });

      res.json({ imported, skipped, nextQc: await nextQcPreview() });
    } catch (err) {
      next(err);
    }
  });

  // ---------- admin: employee allowlist ----------

  app.get("/api/employees", requireAdmin, async (_req, res, next) => {
    try {
      const rows = await db.select().from(employees).orderBy(employees.email);
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  const employeePatchSchema = z.object({
    status: z.enum(["pending", "active", "inactive"]).optional(),
    isAdmin: z.boolean().optional(),
    name: z.string().trim().max(120).optional(),
    title: z.string().trim().max(120).optional(),
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
      res.json(row);
    } catch (err) {
      next(err);
    }
  });
}
