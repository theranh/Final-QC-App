import express from "express";
import http from "http";
import path from "path";
import { sql } from "drizzle-orm";
import { db } from "./db";
import { setupAuth, registerAuthRoutes } from "./replit_integrations/auth";
import { registerAppRoutes } from "./routes";

const app = express();
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

  // Live VPC dashboard — a single self-contained page, gated behind the same
  // Replit Auth login so its /api/dashboard polls always carry a session.
  const { isAuthenticated } = await import("./replit_integrations/auth");
  app.get("/dashboard", isAuthenticated, (_req, res) =>
    res.sendFile(path.resolve(import.meta.dirname, "..", "public", "VPC-Dashboard.html"))
  );

  const server = http.createServer(app);

  if (process.env.NODE_ENV === "production") {
    const { serveStatic } = await import("./vite");
    serveStatic(app);
  } else {
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
