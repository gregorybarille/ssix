import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useDebouncedCallback } from "@/hooks/useDebouncedCallback";

describe("useDebouncedCallback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces rapid calls into one trailing call with the last arguments", () => {
    const fn = vi.fn();
    const { result } = renderHook(() => useDebouncedCallback(fn, 300));

    result.current("a");
    result.current("b");
    vi.advanceTimersByTime(299);
    result.current("c");
    expect(fn).not.toHaveBeenCalled();
    expect(result.current.isPending()).toBe(true);

    vi.advanceTimersByTime(300);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("c");
    expect(result.current.isPending()).toBe(false);
  });

  it("flush() runs the pending call immediately and is a no-op when idle", () => {
    const fn = vi.fn();
    const { result } = renderHook(() => useDebouncedCallback(fn, 300));

    result.current.flush();
    expect(fn).not.toHaveBeenCalled();

    result.current(1);
    result.current.flush();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(1);

    // The timer was cleared by flush; nothing fires later.
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("cancel() drops the pending call", () => {
    const fn = vi.fn();
    const { result } = renderHook(() => useDebouncedCallback(fn, 300));

    result.current(1);
    result.current.cancel();
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
    expect(result.current.isPending()).toBe(false);
  });

  it("invokes the latest callback passed on the most recent render", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { result, rerender } = renderHook(
      ({ fn }: { fn: (v: number) => void }) => useDebouncedCallback(fn, 300),
      { initialProps: { fn: first } },
    );
    const debounced = result.current;

    debounced(1);
    rerender({ fn: second });
    // Identity is stable across renders for the same delay.
    expect(result.current).toBe(debounced);

    vi.advanceTimersByTime(300);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(1);
  });

  it("cancels a pending call on unmount by default", () => {
    const fn = vi.fn();
    const { result, unmount } = renderHook(() => useDebouncedCallback(fn, 300));

    result.current("x");
    unmount();
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
  });

  it("flushes a pending call on unmount when onUnmount is 'flush'", () => {
    const fn = vi.fn();
    const { result, unmount } = renderHook(() =>
      useDebouncedCallback(fn, 300, { onUnmount: "flush" }),
    );

    result.current("x");
    unmount();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("x");
  });
});
