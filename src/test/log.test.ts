import { describe, it, expect, beforeEach, vi } from "vitest";
import { log, useFrontendLogs } from "@/lib/log";

describe("frontend log helper", () => {
  beforeEach(() => {
    useFrontendLogs.getState().clear();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("exposes info/warn/error as functions (no namespace mis-call regressions)", () => {
    expect(typeof log.info).toBe("function");
    expect(typeof log.warn).toBe("function");
    expect(typeof log.error).toBe("function");
  });

  it("error() pushes an entry into the in-memory ring", () => {
    log.error("settings", "Failed to save layout settings: boom");
    const entries = useFrontendLogs.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: "error",
      source: "settings",
      message: "Failed to save layout settings: boom",
    });
  });

  it("calling log() as a function would throw — guards against the App.tsx regression", () => {
    expect(() => (log as unknown as Function)("oops", new Error("x"))).toThrow();
  });
});
