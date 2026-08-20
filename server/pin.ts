import type { Express, RequestHandler, Response } from "express";
import express from "express";
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { eq, sql } from "drizzle-orm";
import { db } from "./db";
import { requireEmployee } from "./access";
import { invalidateDashboardCache } from "./dashboard";
import { and } from "drizzle-orm";
import { auditLog, employees, quotes, intakes, settings, type Employee } from "@shared/schema";
import { captureCommitSnapshot } from "./quoteSnapshot";

// ---------------------------------------------------------------------------
// PIN sign-off for Body Quoter commits.
//
// PIN is required AT COMMIT, never at start. Committing an intake (all 9
// RO-Ready items checked) or a quote prompts the signer to identify themselves
// and enter their 4-digit PIN. committed_by is written from the verified PIN
// owner — never a free-text dropdown — and is immutable once set.
//
// Supervisor override: a signer with can_override may enter THEIR OWN PIN and
// pick whose work they are countersigning. committed_by = the worker,
// overridden_by = the supervisor.
// ---------------------------------------------------------------------------

/**
 * Rate-version guard for commits. When the client sends the ratesVersion it
 * loaded with the quote, refuse the commit if rates have changed since — the
 * estimator must reload and re-approve totals instead of silently committing
 * against rates they never saw. Older clients that send nothing are unaffected.
 */
async function ratesVersionConflict(executor: any, body: any): Promise<{ conflict: boolean; current?: number }> {
  const sent = body?.ratesVersion;
  if (sent == null) return { conflict: false };
  // FOR UPDATE inside the commit transaction: a rates save that races this
  // commit must either land before (version bumped → conflict) or wait until
  // the commit finishes — never slip between check and commit.
  const r = await executor.execute(
    sql`SELECT value FROM ${settings} WHERE key = 'ratesMeta' FOR UPDATE`,
  );
  const current = Number((r.rows?.[0] as any)?.value?.version ?? 0);
  return { conflict: Number(sent) !== current, current };
}

const RATES_CHANGED_409 = {
  error: "Pricing rates were updated since this quote was loaded. Reopen the quote to refresh totals, then commit.",
  code: "rates_changed",
};

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const SCRYPT_KEYLEN = 32;

// Hash a 4-digit PIN with a per-user random salt. Stored as "scrypt$<saltHex>$<hashHex>".
export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(pin, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

// Constant-time PIN verification against a stored "scrypt$salt$hash" string.
export async function verifyPin(pin: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[1], "hex");
    expected = Buffer.from(parts[2], "hex");
  } catch {
    return false;
  }
  const derived = await scrypt(pin, salt, expected.length || SCRYPT_KEYLEN);
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

export function isValidPin(pin: unknown): pin is string {
  return typeof pin === "string" && /^\d{4}$/.test(pin);
}

// ---- rate limit: PIN verification attempts ----
// Two independent buckets so a spoofed X-Forwarded-For can't unlock brute
// force: at most 10 attempts/min per signer id (regardless of source IP) AND
// 30 attempts/min per client IP. Either bucket overflowing blocks the attempt.
const PIN_PER_SIGNER = 10;
const PIN_PER_IP = 30;
const pinBuckets = new Map<string, { start: number; count: number }>();
function bumpBucket(key: string, now: number): number {
  let b = pinBuckets.get(key);
  if (!b || now - b.start > 60000) {
    b = { start: now, count: 0 };
    pinBuckets.set(key, b);
  }
  if (pinBuckets.size > 5000) {
    for (const [k, v] of pinBuckets) {
      if (now - v.start > 60000) pinBuckets.delete(k);
    }
  }
  b.count++;
  return b.count;
}

/** Test-only: clear the rate-limit buckets so unrelated cases don't collide. */
export function resetPinRateLimits() {
  pinBuckets.clear();
}

function pinRateLimited(signerId: number, ip: string): boolean {
  const now = Date.now();
  // Always bump both so neither axis can be sidestepped by varying the other.
  const bySigner = bumpBucket(`signer:${signerId}`, now);
  const byIp = bumpBucket(`ip:${ip}`, now);
  return bySigner > PIN_PER_SIGNER || byIp > PIN_PER_IP;
}

// Prefer Express's req.ip (from the trusted proxy hop configured in
// server/index.ts) over the raw, client-spoofable X-Forwarded-For header.
function clientIp(req: any): string {
  return String(req.ip || req.socket?.remoteAddress || "").trim();
}

const jsonBody = express.json({ limit: "64kb" });

function withBody(handler: (req: any, res: Response) => Promise<unknown> | unknown): RequestHandler {
  return (req, res, next) => {
    jsonBody(req, res, (err) => {
      if (err) return res.status(400).json({ error: "Invalid JSON" });
      Promise.resolve(handler(req, res)).catch(next);
    });
  };
}

// `executor` is db or a transaction handle — the commit UPDATE and this audit
// INSERT run on the SAME transaction so a commit can never exist without its
// audit row.
async function auditCommit(
  executor: { insert: typeof db.insert },
  action: string,
  actor: Employee,
  details: Record<string, unknown>,
) {
  await executor.insert(auditLog).values({
    action,
    actorId: actor.userId || String(actor.id),
    actorEmail: actor.email,
    actorName: actor.name,
    details: details as any,
  });
}

// Resolve the signer + (optional) worker being signed for. Verifies the
// signer's own PIN and applies the override rule. Returns a discriminated
// result the caller turns into an HTTP response.
type SignResult =
  | { ok: true; committedBy: string; overriddenBy: string | null; signer: Employee }
  | { ok: false; status: number; error: string };

async function resolveSignature(body: any, req: any): Promise<SignResult> {
  const signerId = Number(body?.signerId);
  const pin = body?.pin;
  const forEmployeeId = body?.forEmployeeId != null ? Number(body.forEmployeeId) : null;

  if (!Number.isFinite(signerId)) return { ok: false, status: 400, error: "Missing signer" };
  if (!isValidPin(pin)) return { ok: false, status: 400, error: "PIN must be 4 digits" };

  if (pinRateLimited(signerId, clientIp(req))) {
    return { ok: false, status: 429, error: "Too many PIN attempts — wait a minute and try again" };
  }

  const [signer] = await db.select().from(employees).where(eq(employees.id, signerId));
  if (!signer || !signer.active || signer.status !== "active") {
    return { ok: false, status: 403, error: "That signer is not active" };
  }
  if (!signer.pinHash) {
    return { ok: false, status: 403, error: "No PIN set for that person — see an admin" };
  }
  const good = await verifyPin(pin, signer.pinHash);
  if (!good) return { ok: false, status: 401, error: "Incorrect PIN" };

  // Normal sign-off: signer signs for themselves.
  if (forEmployeeId == null || forEmployeeId === signerId) {
    return { ok: true, committedBy: signer.name, overriddenBy: null, signer };
  }

  // Supervisor override: signer must be able to override; worker must be active.
  if (!signer.canOverride) {
    return { ok: false, status: 403, error: "You are not allowed to sign for someone else" };
  }
  const [worker] = await db.select().from(employees).where(eq(employees.id, forEmployeeId));
  if (!worker || !worker.active || worker.status !== "active") {
    return { ok: false, status: 400, error: "That employee is not active" };
  }
  return { ok: true, committedBy: worker.name, overriddenBy: signer.name, signer };
}

export function registerPinRoutes(app: Express) {
  // ----- GET /api/quoter/signers -----
  // Active employees who can sign. Picking a signer here selects WHO IS
  // SIGNING (then verified by their own PIN) — it is not a free name dropdown.
  app.get(
    "/api/quoter/signers",
    requireEmployee,
    (req, res, next) => {
      (async () => {
        const rows = await db
          .select({
            id: employees.id,
            name: employees.name,
            canOverride: employees.canOverride,
            pinHash: employees.pinHash,
          })
          .from(employees)
          .where(and(eq(employees.active, true), eq(employees.status, "active")))
          .orderBy(employees.name);
        res.set("Cache-Control", "no-store");
        res.json({
          signers: rows.map((r) => ({
            id: r.id,
            name: r.name,
            canOverride: !!r.canOverride,
            hasPin: !!r.pinHash,
          })),
        });
      })().catch(next);
    },
  );

  // ----- POST /api/quoter/commit-intake -----
  app.post(
    "/api/quoter/commit-intake",
    requireEmployee,
    withBody(async (req: any, res) => {
      const id = String(req.body?.id || "");
      if (!id) return res.status(400).json({ error: "Missing id" });

      const [row] = await db.select().from(intakes).where(eq(intakes.id, id));
      if (!row) return res.status(404).json({ error: "Intake not found" });
      if (row.committedBy) {
        return res.status(409).json({
          error: "This intake is already committed. A correction is a new record.",
          committedBy: row.committedBy,
          overriddenBy: row.overriddenBy,
        });
      }
      const sig = await resolveSignature(req.body, req);
      if (!sig.ok) return res.status(sig.status).json({ error: sig.error });

      // Commit + audit atomically: the immutability-guarded UPDATE and the
      // audit INSERT share one transaction, so a commit never lands without
      // its audit row (and a failed audit rolls the commit back).
      let ratesConflict: { current?: number } | null = null;
      const committedRow = await db.transaction(async (tx) => {
        const rv = await ratesVersionConflict(tx, req.body);
        if (rv.conflict) {
          ratesConflict = { current: rv.current };
          return null;
        }
        // Immutability guard: only write when committed_by is still NULL.
        const [saved] = await tx
          .update(intakes)
          // Committing is what marks the intake complete (the old RO-ready
          // checklist gate was removed); keep an earlier timestamp if present.
          .set({ committedBy: sig.committedBy, overriddenBy: sig.overriddenBy, completedAt: sql`COALESCE(${intakes.completedAt}, NOW())` })
          .where(sql`${intakes.id} = ${id} AND ${intakes.committedBy} IS NULL`)
          .returning();
        if (!saved) return null;
        await auditCommit(tx, sig.overriddenBy ? "intake_committed_override" : "intake_committed", sig.signer, {
          intakeId: id,
          vin: row.vin,
          stock: row.stock,
          committedBy: sig.committedBy,
          overriddenBy: sig.overriddenBy,
        });
        // Phase 1A: snapshot the linked quote in the SAME transaction — a
        // failed snapshot rolls the commit back (never fire-and-forget).
        // The quote is read HERE, under FOR UPDATE, so a concurrent autosave
        // can neither change the document mid-commit nor leave the snapshot
        // stale relative to what was approved.
        if (row.quoteId) {
          const qr = await tx.execute(
            sql`SELECT id, data, committed_by, overridden_by FROM ${quotes} WHERE id = ${row.quoteId} FOR UPDATE`,
          );
          const q = qr.rows?.[0] as any;
          if (q) {
            await captureCommitSnapshot(tx, {
              quoteRow: { id: q.id, data: q.data, committedBy: q.committed_by, overriddenBy: q.overridden_by, updatedAt: null } as any,
              intakeId: id,
              committedBy: sig.committedBy,
              overriddenBy: sig.overriddenBy,
            });
          }
        }
        return saved;
      });
      if (ratesConflict) {
        return res.status(409).json({ ...RATES_CHANGED_409, currentRatesVersion: (ratesConflict as any).current });
      }
      if (!committedRow) {
        return res.status(409).json({ error: "This intake was just committed by someone else." });
      }
      // Committing marks the intake complete, which moves it into the
      // awaiting-Final-QC list — refresh the cached dashboard right away.
      invalidateDashboardCache();
      const completedMs = new Date(committedRow.completedAt as any).getTime();

      res.json({
        ok: true,
        committedBy: sig.committedBy,
        overriddenBy: sig.overriddenBy,
        completedAt: Number.isFinite(completedMs) ? completedMs : Date.now(),
      });
    }),
  );

  // ----- POST /api/quoter/commit-quote -----
  app.post(
    "/api/quoter/commit-quote",
    requireEmployee,
    withBody(async (req: any, res) => {
      const id = String(req.body?.id || "");
      if (!id) return res.status(400).json({ error: "Missing id" });

      const [row] = await db.select().from(quotes).where(eq(quotes.id, id));
      if (!row) return res.status(404).json({ error: "Quote not found" });
      if (row.committedBy) {
        return res.status(409).json({
          error: "This quote is already committed. A correction is a new record.",
          committedBy: row.committedBy,
          overriddenBy: row.overriddenBy,
        });
      }

      const sig = await resolveSignature(req.body, req);
      if (!sig.ok) return res.status(sig.status).json({ error: sig.error });

      const qData = (row.data as any) || {};
      // Commit + audit atomically (see commit-intake for rationale).
      let ratesConflict: { current?: number } | null = null;
      const committed = await db.transaction(async (tx) => {
        const rv = await ratesVersionConflict(tx, req.body);
        if (rv.conflict) {
          ratesConflict = { current: rv.current };
          return false;
        }
        const [saved] = await tx
          .update(quotes)
          .set({ committedBy: sig.committedBy, overriddenBy: sig.overriddenBy })
          .where(sql`${quotes.id} = ${id} AND ${quotes.committedBy} IS NULL`)
          .returning();
        if (!saved) return false;
        await auditCommit(tx, sig.overriddenBy ? "quote_committed_override" : "quote_committed", sig.signer, {
          quoteId: id,
          vin: qData.vin || null,
          stock: qData.stock || null,
          committedBy: sig.committedBy,
          overriddenBy: sig.overriddenBy,
        });
        // Phase 1A: same-transaction snapshot (see commit-intake). `saved` is
        // the row AS LOCKED AND UPDATED by this transaction — never the
        // pre-transaction read — so the snapshot can't capture a stale doc.
        await captureCommitSnapshot(tx, {
          quoteRow: saved,
          intakeId: null,
          committedBy: sig.committedBy,
          overriddenBy: sig.overriddenBy,
        });
        return true;
      });
      if (ratesConflict) {
        return res.status(409).json({ ...RATES_CHANGED_409, currentRatesVersion: (ratesConflict as any).current });
      }
      if (!committed) {
        return res.status(409).json({ error: "This quote was just committed by someone else." });
      }

      res.json({ ok: true, committedBy: sig.committedBy, overriddenBy: sig.overriddenBy });
    }),
  );
}
