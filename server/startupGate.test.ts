import { describe, expect, it, vi } from "vitest";
import { createStartupGate } from "./startupGate";

function responseMock() {
  return {
    status: vi.fn(),
    type: vi.fn(),
    set: vi.fn(),
    send: vi.fn(),
  };
}

describe("startup gate", () => {
  it("returns a non-cached 200 for the root probe during the bounded startup window", () => {
    const gate = createStartupGate({ deadlineMs: 120_000, onDeadline: vi.fn() });
    const res = responseMock();
    const next = vi.fn();
    gate.middleware({ method: "GET", path: "/" } as any, res as any, next);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.set).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining("Application is starting"));
    expect(next).not.toHaveBeenCalled();
  });

  it("holds API requests until startup finishes", async () => {
    const gate = createStartupGate();
    const next = vi.fn();
    gate.middleware({ method: "GET", path: "/api/me" } as any, responseMock() as any, next);
    expect(next).not.toHaveBeenCalled();
    gate.markReady();
    await Promise.resolve();
    expect(next).toHaveBeenCalledOnce();
  });

  it("passes all requests through after startup finishes", () => {
    const gate = createStartupGate();
    const next = vi.fn();
    gate.markReady();
    gate.middleware({ method: "GET", path: "/" } as any, responseMock() as any, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("fires a bounded startup deadline unless readiness is reached", () => {
    vi.useFakeTimers();
    const onDeadline = vi.fn();
    createStartupGate({ deadlineMs: 120_000, onDeadline });
    vi.advanceTimersByTime(119_999);
    expect(onDeadline).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onDeadline).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("cancels the startup deadline after readiness", () => {
    vi.useFakeTimers();
    const onDeadline = vi.fn();
    const gate = createStartupGate({ deadlineMs: 120_000, onDeadline });
    gate.markReady();
    vi.advanceTimersByTime(120_000);
    expect(onDeadline).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});