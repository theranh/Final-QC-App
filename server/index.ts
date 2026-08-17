import express from "express";
import http from "http";
import { sql } from "drizzle-orm";
import { db } from "./db";
import { setupAuth, registerAuthRoutes } from "./replit_integrations/auth";
import { registerAppRoutes } from "./routes";

const app = express();
// Replit runs behind exactly one reverse proxy, so trust a single hop. This
// makes req.ip the real client address (from the left-most X-Forwarded-For
// entry the proxy sets) and lets rate limiters key off it safely instead of
// parsing the raw, client-spoofable X-Forwarded-For header themselves.
app.set("trust proxy", 1);
// Inspection payloads include compressed JPEG data URLs.
app.use(express.json({ limit: "40mb" }));
app.use(express.urlencoded({ extended: false, limit: "40mb" }));

// Ensure the AI accuracy schema is in place.  Runs after listen for the same
// reason as seedQcCounter (health-check must not block).  Handles both a fresh
// environment (CREATE TABLE IF NOT EXISTS) and an existing install that already
// has ai_analyses without the analysis_id column (ALTER TABLE … IF NOT EXISTS).
async function ensureAccuracySchema() {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      // Create table; column list matches the full schema so new envs are complete.
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS ai_analyses (
          id bigserial PRIMARY KEY,
          ts bigint NOT NULL,
          analysis_id text
        )
      `);
      // For existing installs that pre-date analysis_id / corrected columns.
      await db.execute(sql`ALTER TABLE ai_analyses ADD COLUMN IF NOT EXISTS analysis_id text`);
      await db.execute(sql`ALTER TABLE ai_analyses ADD COLUMN IF NOT EXISTS corrected boolean NOT NULL DEFAULT false`);
      // Regular (non-partial) unique index: PostgreSQL treats every NULL as
      // distinct from every other NULL, so multiple rows with analysis_id IS NULL
      // are allowed.  A non-partial index is required for ON CONFLICT
      // (analysis_id) DO NOTHING — PostgreSQL cannot infer the conflict target
      // from a partial WHERE index.
      await db.execute(sql`
        CREATE UNIQUE INDEX IF NOT EXISTS ai_analyses_analysis_id_key
        ON ai_analyses (analysis_id)
      `);
      // Link corrections to the analysis that triggered them.
      await db.execute(sql`ALTER TABLE corrections ADD COLUMN IF NOT EXISTS analysis_id text`);
      return;
    } catch (err) {
      console.error(`accuracy schema attempt ${attempt} failed:`, err);
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  console.error("accuracy schema setup gave up — AI accuracy tracking may not function correctly.");
}

// Ensure the QC-number counter row exists (first number handed out: FQ-1001).
// Runs AFTER the server starts listening: a slow database connection during a
// publish must never keep the health check from getting a response, or the
// whole publish times out with no logs. Retries a few times, then gives up
// loudly (the counter row already exists on any environment that has run once).
async function seedQcCounter() {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await db.execute(sql`INSERT INTO qc_counter (id, value) VALUES (1, 1000) ON CONFLICT (id) DO NOTHING`);
      return;
    } catch (err) {
      console.error(`qc_counter seed attempt ${attempt} failed:`, err);
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  console.error("qc_counter seed gave up — counter must already exist for FQ numbers to work.");
}

// Loud check for required production configuration. A missing secret must show
// up as an explicit log line in deploy logs, never a silent hang.
function checkRequiredEnv() {
  const required = ["DATABASE_URL", "SESSION_SECRET", "REPL_ID"];
  if (process.env.NODE_ENV === "production") required.push("QUOTER_SYNC_TOKEN");
  const missing = required.filter((name) => !process.env[name]);
  for (const name of missing) {
    console.error(`STARTUP ERROR: required environment variable ${name} is not set — the app cannot run correctly without it.`);
  }
  return missing;
}

async function main() {
  checkRequiredEnv();

  const server = http.createServer(app);

  // Open the port IMMEDIATELY. The deployment readiness check only needs the
  // port to accept connections; auth setup (OIDC discovery + DB-backed session
  // store) can be slow, so it runs after listen(). Requests that arrive before
  // setup finishes wait on this gate instead of finding a closed port.
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  app.use((_req, _res, next) => {
    void ready.then(() => next());
  });

  const port = Number(process.env.PORT) || 5000;
  server.listen(port, "0.0.0.0", () => {
    console.log(`Final QC server listening on 0.0.0.0:${port} (${process.env.NODE_ENV || "development"})`);
  });

  console.log("Startup: configuring auth…");
  await setupAuth(app);
  registerAuthRoutes(app);
  registerAppRoutes(app);

  // JSON error handler for API routes — no silent failures.
  app.use("/api", (err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("API error:", err);
    if (res.headersSent) return;
    if (err?.name === "ZodError") {
      return res.status(400).json({ message: "Invalid request", issues: err.issues });
    }
    res.status(500).json({ message: "Internal server error" });
  });

  // The old standalone VPC dashboard page was replaced by the in-app Dash tab.
  app.get("/dashboard", (_req, res) => res.redirect("/"));

  if (process.env.NODE_ENV === "production") {
    const { serveStatic } = await import("./vite");
    serveStatic(app);
  } else {
    // Dev-only service-worker kill switch. Browsers that once loaded a built
    // (PWA) version of this app on the dev domain still have that old service
    // worker installed, and it keeps serving its stale cached shell instead of
    // the live dev server. When such a browser checks /sw.js for updates, hand
    // it a worker that wipes the old caches, unregisters itself, and reloads
    // the open pages so they fetch the current app.
    app.get("/sw.js", (_req, res) => {
      res.set("Content-Type", "application/javascript");
      res.set("Cache-Control", "no-store");
      res.send(`self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach((c) => c.navigate(c.url));
  })());
});
`);
    });
    const { setupVite } = await import("./vite");
    await setupVite(app, server);
  }

  // Routes are all registered — release any requests that arrived early.
  markReady();
  console.log("Startup: auth + routes ready");

  // Background DB seed — never blocks the health check.
  void seedQcCounter();
  void ensureAccuracySchema();
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
