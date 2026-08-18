import express from "express";
import http from "http";
import { setupAuth, registerAuthRoutes } from "./replit_integrations/auth";
import { registerAppRoutes } from "./routes";
import { runMigrations } from "./migrations";
import { startSheetExportWorker } from "./sheetExports";

const app = express();
// Replit runs behind exactly one reverse proxy, so trust a single hop. This
// makes req.ip the real client address (from the left-most X-Forwarded-For
// entry the proxy sets) and lets rate limiters key off it safely instead of
// parsing the raw, client-spoofable X-Forwarded-For header themselves.
app.set("trust proxy", 1);
// Inspection payloads include compressed JPEG data URLs.
app.use(express.json({ limit: "40mb" }));
app.use(express.urlencoded({ extended: false, limit: "40mb" }));

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

  // Reviewed, versioned migrations run BEFORE the request gate opens: the
  // port is already accepting connections (health check passes) but requests
  // wait on `ready`, so traffic never hits a half-migrated schema. On a total
  // failure (DB unreachable after bounded retries) we log loudly and still
  // serve — a broken DB fails requests anyway, and a bricked publish is worse.
  console.log("Startup: running migrations…");
  const migrated = await runMigrations();
  if (!migrated) {
    console.error("STARTUP ERROR: serving with incomplete migrations — investigate immediately.");
  }

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

  // Durable Google Sheets export queue: pick up any jobs left over from a
  // previous run and keep retrying with bounded backoff.
  startSheetExportWorker();
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
