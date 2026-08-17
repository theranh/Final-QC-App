import fs from "fs";
import path from "path";
import type { Express } from "express";
import type { Server } from "http";
import express from "express";

export async function setupVite(app: Express, server: Server) {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    configFile: path.resolve(process.cwd(), "vite.config.js"),
    server: {
      middlewareMode: true,
      // Vite 8: server.hmr.* moved to server.ws.*
      ws: { server, clientPort: 443 },
      allowedHosts: true as const,
    },
    appType: "custom",
  });

  app.use(vite.middlewares);
  app.use(async (req, res, next) => {
    try {
      const template = fs.readFileSync(path.resolve(process.cwd(), "index.html"), "utf-8");
      const html = await vite.transformIndexHtml(req.originalUrl, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(html);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}

export function serveStatic(app: Express) {
  const distPath = path.resolve(process.cwd(), "dist");
  if (!fs.existsSync(distPath)) {
    throw new Error(`Build directory not found: ${distPath} — run \`npm run build\` first.`);
  }
  app.use(express.static(distPath));
  app.use((_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
