// Durable Google Sheets export queue.
//
// Replaces the old in-memory fire-and-forget export chain. Every exportable
// QC result becomes a sheet_export_jobs row that survives restarts; a
// single-flight drain loop retries with bounded backoff, and admins can see
// pending/failed jobs and retry them manually.
//
// Design rules preserved from the old exporter:
// - Enqueueing NEVER blocks or fails the inspection commit.
// - Exports run one at a time per instance (read-target-then-write on the
//   sheet is not atomic; the sequential drain prevents double-row grabs).
// - Not configured → no-op, same as before (nothing piles up in dev).
import type { Express } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "./db";
import { inspections, sheetExportJobs, type Inspection } from "@shared/schema";
import { requireAdmin } from "./access";
import { isExportable, isSheetsConfigured, performSheetExport } from "./googleSheets";

/** Attempts after which automatic retries stop (manual retry still allowed). */
export const MAX_AUTO_ATTEMPTS = 8;

/** Bounded backoff: 1m, 5m, 15m, 30m, then 60m forever. */
export function backoffMs(attempts: number): number {
  const steps = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000];
  return steps[Math.min(Math.max(attempts, 1) - 1, steps.length - 1)];
}

/** Pure state transition applied when an export attempt fails. */
export function failureTransition(attemptsBefore: number): {
  status: "pending" | "failed";
  attempts: number;
  delayMs: number;
} {
  const attempts = attemptsBefore + 1;
  return {
    attempts,
    status: attempts >= MAX_AUTO_ATTEMPTS ? "failed" : "pending",
    delayMs: backoffMs(attempts),
  };
}

/**
 * Queue a passed/cleared inspection for export. Fire-and-forget from route
 * handlers; a failed enqueue is logged loudly but never affects the commit.
 */
export function enqueueSheetExport(record: Inspection): void {
  if (!isExportable(record)) return;
  if (!isSheetsConfigured()) return; // same no-op-when-unconfigured semantics as before
  void (async () => {
    try {
      await db.insert(sheetExportJobs).values({
        inspectionId: record.id,
        qcNumber: record.qcNumber,
        status: "pending",
        attempts: 0,
        nextAttemptAt: new Date(),
      });
      void drainSheetExports();
    } catch (err: any) {
      console.error(`Sheet export ENQUEUE failed for ${record.qcNumber} — export will not happen until re-triggered:`, err?.message || err);
    }
  })();
}

let draining = false;

/** Process due jobs sequentially. Single-flight; safe to call at any time. */
export async function drainSheetExports(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    for (let guard = 0; guard < 100; guard += 1) {
      // Atomic claim: flip exactly one due job to 'running' (SKIP LOCKED so a
      // second instance — e.g. dev workspace + published VM on the same DB —
      // can never grab the same job and write a duplicate sheet row). Jobs
      // stuck in 'running' >15min (crash mid-export) are reclaimable.
      const claimed = await db.execute(sql`
        UPDATE sheet_export_jobs SET status = 'running', updated_at = now()
        WHERE id = (
          SELECT id FROM sheet_export_jobs
          WHERE (status = 'pending' AND next_attempt_at <= now())
             OR (status = 'running' AND updated_at < now() - interval '15 minutes')
          ORDER BY id
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, inspection_id AS "inspectionId", qc_number AS "qcNumber", attempts
      `);
      const job = (claimed.rows?.[0] as any) as
        | { id: number; inspectionId: number; qcNumber: string; attempts: number }
        | undefined;
      if (!job) break;
      try {
        const [rec] = await db.select().from(inspections).where(eq(inspections.id, job.inspectionId));
        if (!rec) throw new Error("Inspection row no longer exists");
        if (!isExportable(rec)) {
          // Re-opened or otherwise not exportable anymore — close the job out.
          await db
            .update(sheetExportJobs)
            .set({ status: "done", lastError: "Skipped — inspection is not in an exportable state", updatedAt: new Date() })
            .where(eq(sheetExportJobs.id, job.id));
          continue;
        }
        await performSheetExport(rec); // throws on any failure
        await db
          .update(sheetExportJobs)
          .set({ status: "done", lastError: null, attempts: job.attempts + 1, updatedAt: new Date() })
          .where(eq(sheetExportJobs.id, job.id));
      } catch (err: any) {
        const next = failureTransition(job.attempts);
        await db
          .update(sheetExportJobs)
          .set({
            status: next.status,
            attempts: next.attempts,
            lastError: String(err?.message || err).slice(0, 500),
            nextAttemptAt: new Date(Date.now() + next.delayMs),
            updatedAt: new Date(),
          })
          .where(eq(sheetExportJobs.id, job.id));
        console.error(
          `Google Sheets export failed for ${job.qcNumber} (attempt ${next.attempts}${next.status === "failed" ? " — automatic retries exhausted, manual retry required" : ""}):`,
          err?.message || err,
        );
        if (next.status === "pending") break; // wait out the backoff instead of hot-looping
      }
    }
  } catch (err: any) {
    console.error("Sheet export drain error:", err?.message || err);
  } finally {
    draining = false;
  }
}

let workerStarted = false;
/** Start the periodic drain (survives restarts by re-reading the table). */
export function startSheetExportWorker(): void {
  if (workerStarted) return;
  workerStarted = true;
  const t = setInterval(() => void drainSheetExports(), 60_000);
  (t as any).unref?.();
  void drainSheetExports();
}

export function registerSheetExportRoutes(app: Express) {
  // Admin visibility: recent jobs, pending/failed first.
  app.get("/api/sheet-exports", requireAdmin, async (_req, res, next) => {
    try {
      const jobs = await db
        .select({
          id: sheetExportJobs.id,
          qcNumber: sheetExportJobs.qcNumber,
          status: sheetExportJobs.status,
          attempts: sheetExportJobs.attempts,
          lastError: sheetExportJobs.lastError,
          nextAttemptAt: sheetExportJobs.nextAttemptAt,
          createdAt: sheetExportJobs.createdAt,
        })
        .from(sheetExportJobs)
        .orderBy(desc(sheetExportJobs.id))
        .limit(100);
      res.set("Cache-Control", "no-store");
      res.json({ configured: isSheetsConfigured(), jobs });
    } catch (err) {
      next(err);
    }
  });

  // Manual retry for a pending/failed job — makes it due right now.
  app.post("/api/sheet-exports/:id/retry", requireAdmin, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ message: "Bad job id" });
      const [job] = await db
        .update(sheetExportJobs)
        .set({ status: "pending", nextAttemptAt: new Date(), updatedAt: new Date() })
        .where(and(eq(sheetExportJobs.id, id), inArray(sheetExportJobs.status, ["pending", "failed"])))
        .returning({ id: sheetExportJobs.id });
      if (!job) return res.status(404).json({ message: "Job not found or already exported" });
      void drainSheetExports();
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });
}
