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

async function main() {
  // Ensure the QC-number counter row exists (first number handed out: FQ-1001).
  await db.execute(sql`INSERT INTO qc_counter (id, value) VALUES (1, 1000) ON CONFLICT (id) DO NOTHING`);

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

  const server = http.createServer(app);

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

  const port = Number(process.env.PORT) || 5000;
  server.listen(port, "0.0.0.0", () => {
    console.log(`Final QC server listening on 0.0.0.0:${port} (${process.env.NODE_ENV || "development"})`);
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
