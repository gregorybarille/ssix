import { describe, it, expect, vi } from "vitest";
import { runAsync, runAsyncRethrow } from "@/lib/asyncAction";

/**
 * Audit-4 Dup H1: regression tests for the shared async-action wrapper.
 *
 * These mirror the contract every Zustand store relies on:
 *   - isLoading is true during the call, false after
 *   - error is cleared at start, populated on failure
 *   - runAsync returns undefined on failure (no rethrow)
 *   - runAsyncRethrow rethrows so dialogs can stay open
 */
describe("runAsync / runAsyncRethrow", () => {
  it("manages isLoading and clears error on success", async () => {
    const set = vi.fn();
    const result = await runAsync(set, async () => 42);
    expect(result).toBe(42);
    expect(set).toHaveBeenNthCalledWith(1, { isLoading: true, error: null });
    expect(set).toHaveBeenNthCalledWith(2, { isLoading: false });
  });

  it("returns undefined and records error on failure (no rethrow)", async () => {
    const set = vi.fn();
    const result = await runAsync(set, async () => {
      throw new Error("boom");
    });
    expect(result).toBeUndefined();
    expect(set).toHaveBeenLastCalledWith({
      error: "Error: boom",
      isLoading: false,
    });
  });

  it("runAsyncRethrow propagates errors after recording state", async () => {
    const set = vi.fn();
    await expect(
      runAsyncRethrow(set, async () => {
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    expect(set).toHaveBeenLastCalledWith({
      error: "Error: nope",
      isLoading: false,
    });
  });

  it("runAsyncRethrow returns the value on success", async () => {
    const set = vi.fn();
    const result = await runAsyncRethrow(set, async () => "ok");
    expect(result).toBe("ok");
  });
});
