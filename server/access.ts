import type { Request, RequestHandler } from "express";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { employees, type Employee } from "@shared/schema";
import { isAuthenticated } from "./replit_integrations/auth";

export const ALLOWED_DOMAIN = "@truckranch.com";

export type AccessState =
  | { access: "domain_blocked"; email: string; employee: null }
  | { access: "pending" | "inactive" | "active"; email: string; employee: Employee };

function claimsOf(req: Request) {
  const claims = (req.user as any)?.claims || {};
  const email = String(claims.email || "").trim().toLowerCase();
  // Replit accounts require a verified email, so the claim is normally absent/true.
  // If the IdP ever reports an explicitly unverified email, refuse it.
  const emailVerified = claims.email_verified !== false;
  const name =
    [claims.first_name, claims.last_name].filter(Boolean).join(" ").trim() ||
    email.split("@")[0] ||
    "Employee";
  return { userId: String(claims.sub || ""), email, emailVerified, name };
}

// Resolve the caller's access level from verified server-side session claims only.
// Never trusts anything from the request body or query string.
export async function resolveAccess(req: Request): Promise<AccessState> {
  const { userId, email, emailVerified, name } = claimsOf(req);

  if (!email || !emailVerified || !email.endsWith(ALLOWED_DOMAIN)) {
    return { access: "domain_blocked", email, employee: null };
  }

  // Link by Replit user id first, then by pre-approved email.
  let [emp] = await db.select().from(employees).where(eq(employees.userId, userId));
  if (!emp) {
    const [byEmail] = await db.select().from(employees).where(eq(employees.email, email));
    if (byEmail && !byEmail.userId) {
      [emp] = await db
        .update(employees)
        .set({ userId, name: byEmail.name || name, updatedAt: new Date() })
        .where(eq(employees.id, byEmail.id))
        .returning();
    } else {
      emp = byEmail;
    }
  }

  if (!emp) {
    // First sign-in from a valid company email: create a pending allowlist row.
    [emp] = await db
      .insert(employees)
      .values({ userId, email, name, status: "pending" })
      .onConflictDoNothing({ target: employees.email })
      .returning();
    if (!emp) {
      [emp] = await db.select().from(employees).where(eq(employees.email, email));
    }
  }

  const status = emp.status === "active" ? "active" : emp.status === "inactive" ? "inactive" : "pending";
  return { access: status, email, employee: emp };
}

const employeeCheck: RequestHandler = async (req: any, res, next) => {
  try {
    const state = await resolveAccess(req);
    if (state.access !== "active") {
      return res.status(403).json({
        message:
          state.access === "domain_blocked"
            ? "Access restricted to verified @truckranch.com accounts."
            : state.access === "pending"
            ? "Access pending approval."
            : "This account has been deactivated.",
        access: state.access,
      });
    }
    req.employee = state.employee;
    next();
  } catch (err) {
    next(err);
  }
};

const adminCheck: RequestHandler = (req: any, res, next) => {
  if (!req.employee?.isAdmin) {
    return res.status(403).json({ message: "Admin access required." });
  }
  next();
};

function chain(...handlers: RequestHandler[]): RequestHandler {
  return (req, res, next) => {
    let i = 0;
    const run = (err?: any) => {
      if (err) return next(err);
      const handler = handlers[i++];
      if (!handler) return next();
      handler(req, res, run);
    };
    run();
  };
}

// Requires: authenticated session + verified @truckranch.com email + active on the allowlist.
export const requireEmployee: RequestHandler = chain(isAuthenticated, employeeCheck);
export const requireAdmin: RequestHandler = chain(isAuthenticated, employeeCheck, adminCheck);
