import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerTerminalExtension,
  runTerminalCreate,
  runTerminalData,
  runTerminalOutput,
  terminalExtensions,
  type TerminalExtension,
  type TerminalExtensionContext,
} from "@/components/terminal/extensions";

const ctx = { sessionId: "s1", settings: undefined } as unknown as TerminalExtensionContext;

describe("terminal extension registry", () => {
  const removers: (() => void)[] = [];
  const add = (extension: TerminalExtension) => {
    removers.push(registerTerminalExtension(extension));
  };

  afterEach(() => {
    removers.splice(0).forEach((remove) => remove());
    vi.restoreAllMocks();
  });

  it("runs onCreate and onOutput in registration order", () => {
    const calls: string[] = [];
    add({
      id: "first",
      onCreate: () => void calls.push("first:create"),
      onOutput: () => calls.push("first:output"),
    });
    add({
      id: "second",
      onCreate: () => void calls.push("second:create"),
      onOutput: () => calls.push("second:output"),
    });
    runTerminalCreate(ctx);
    runTerminalOutput(ctx, new Uint8Array([1]));
    expect(calls).toEqual(["first:create", "second:create", "first:output", "second:output"]);
  });

  it("hands each onOutput the bytes it was given", () => {
    const onOutput = vi.fn();
    add({ id: "observer", onOutput });
    const bytes = new Uint8Array([1, 2, 3]);
    runTerminalOutput(ctx, bytes);
    expect(onOutput).toHaveBeenCalledWith(ctx, bytes);
  });

  it("runs the cleanups onCreate returned, last first", () => {
    const calls: string[] = [];
    add({ id: "first", onCreate: () => () => void calls.push("first") });
    add({ id: "second", onCreate: () => () => void calls.push("second") });
    const dispose = runTerminalCreate(ctx);
    expect(calls).toEqual([]);
    dispose();
    expect(calls).toEqual(["second", "first"]);
  });

  it("still cleans up an extension removed after its onCreate ran", () => {
    const cleanup = vi.fn();
    const remove = registerTerminalExtension({ id: "removed", onCreate: () => cleanup });
    const dispose = runTerminalCreate(ctx);
    remove();
    dispose();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("runs the remaining cleanups when one throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const healthy = vi.fn();
    add({ id: "healthy", onCreate: () => healthy });
    add({
      id: "broken",
      onCreate: () => () => {
        throw new Error("boom");
      },
    });
    runTerminalCreate(ctx)();
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it("passes input through untouched when no extension has onData", () => {
    add({ id: "quiet" });
    expect(runTerminalData(ctx, "ls\r")).toBe("ls\r");
  });

  it("chains onData: each extension sees what the previous one returned", () => {
    add({ id: "upper", onData: (_ctx, data) => data.toUpperCase() });
    add({ id: "suffix", onData: (_ctx, data) => `${data}!` });
    expect(runTerminalData(ctx, "ab")).toBe("AB!");
  });

  it("stops at the first onData that swallows the input", () => {
    const later = vi.fn((_ctx: TerminalExtensionContext, data: string) => data);
    add({ id: "swallow", onData: () => null });
    add({ id: "later", onData: later });
    expect(runTerminalData(ctx, "secret")).toBeNull();
    expect(later).not.toHaveBeenCalled();
  });

  it("keeps the input flowing when an onData throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    add({
      id: "broken",
      onData: () => {
        throw new Error("boom");
      },
    });
    add({ id: "suffix", onData: (_ctx, data) => `${data}!` });
    expect(runTerminalData(ctx, "ab")).toBe("ab!");
  });

  it("runs the remaining extensions and logs when a hook throws", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const onCreate = vi.fn();
    add({
      id: "broken",
      onCreate: () => {
        throw new Error("boom");
      },
    });
    add({ id: "healthy", onCreate });
    runTerminalCreate(ctx);
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0][1]).toContain("broken");
    expect(logged.mock.calls[0][1]).toContain("boom");
  });

  it("logs a hook that keeps failing only once", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    add({
      id: "noisy",
      onOutput: () => {
        throw new Error("boom");
      },
    });
    for (let chunk = 0; chunk < 3; chunk += 1) runTerminalOutput(ctx, new Uint8Array([chunk]));
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it("replaces an extension registered again under the same id, in place", () => {
    const before = terminalExtensions.length;
    add({ id: "a" });
    add({ id: "b" });
    const replacement: TerminalExtension = { id: "a" };
    add(replacement);
    expect(terminalExtensions.length).toBe(before + 2);
    expect(terminalExtensions[before]).toBe(replacement);
    expect(terminalExtensions[before + 1].id).toBe("b");
  });

  it("removes an extension through the returned function", () => {
    const onCreate = vi.fn();
    registerTerminalExtension({ id: "gone", onCreate })();
    runTerminalCreate(ctx);
    expect(onCreate).not.toHaveBeenCalled();
  });
});
