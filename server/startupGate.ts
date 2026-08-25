import type { RequestHandler } from "express";

export function createStartupGate(): {
  middleware: RequestHandler;
  markReady: () => void;
};
export function createStartupGate(options: {
  deadlineMs: number;
  onDeadline: () => void;
}): {
  middleware: RequestHandler;
  markReady: () => void;
};
export function createStartupGate(options?: {
  deadlineMs: number;
  onDeadline: () => void;
}): {
  middleware: RequestHandler;
  markReady: () => void;
} {
  let isReady = false;
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const deadline = options
    ? setTimeout(() => {
        if (!isReady) options.onDeadline();
      }, options.deadlineMs)
    : null;
  deadline?.unref();

  const middleware: RequestHandler = (req, res, next) => {
    // Replit's VM probe requires GET / to return HTTP 200. This temporary
    // response exists only during the bounded startup window; the deadline
    // terminates the process if initialization never reaches markReady().
    if (!isReady && req.method === "GET" && req.path === "/") {
      res.status(200);
      res.type("html");
      res.set("Cache-Control", "no-store");
      res.send(
        "<!doctype html><meta charset=\"utf-8\"><meta http-equiv=\"refresh\" content=\"2\"><title>Starting</title><p>Application is starting…</p>",
      );
      return;
    }
    if (isReady) {
      next();
      return;
    }
    void ready.then(next);
  };

  return {
    middleware,
    markReady() {
      if (isReady) return;
      isReady = true;
      if (deadline) clearTimeout(deadline);
      resolveReady();
    },
  };
}