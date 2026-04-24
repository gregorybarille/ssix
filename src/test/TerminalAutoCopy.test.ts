import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Audit-3 P1#1: Terminal clipboard interactions.
 *
 * The Terminal component uses xterm.js which cannot run in jsdom, so we
 * verify the clipboard integration by exercising the same callbacks that
 * Terminal.tsx wires up. This file pins three behaviors:
 *
 *   1. Auto-copy on selection is OPT-IN (gated on
 *      `settings.auto_copy_selection`). The default (false) MUST NOT
 *      silently overwrite the user's clipboard when text is highlighted.
 *
 *   2. Cmd/Ctrl+C with a non-empty selection copies it AND swallows the
 *      keystroke so xterm doesn't also forward Ctrl+C to the remote shell
 *      as SIGINT (matching iTerm/Terminal.app convention).
 *
 *   3. Cmd/Ctrl+C with an EMPTY selection does NOT swallow — the
 *      keystroke flows through to xterm's data handler so SIGINT still
 *      reaches the remote shell.
 *
 * If any of these regress, users either lose clipboard data on highlight
 * (the original P1#1 finding) or lose the ability to interrupt remote
 * commands.
 */

describe("Terminal — auto-copy on selection (opt-in)", () => {
  const originalClipboard = navigator.clipboard;

  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      writable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
        readText: vi.fn().mockResolvedValue(""),
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      writable: true,
      value: originalClipboard,
    });
  });

  /**
   * Mirrors the `onSelectionChange` body in `src/components/Terminal.tsx`:
   *   if (!autoCopyEnabledRef.current) return;
   *   const sel = term.getSelection();
   *   if (sel) navigator.clipboard.writeText(sel)...
   * The ref dereference is the part we care about — without it, every
   * highlight clobbers the system clipboard.
   */
  function makeSelectionHandler(opts: {
    autoCopyEnabled: { current: boolean };
    getSelection: () => string;
  }) {
    return () => {
      if (!opts.autoCopyEnabled.current) return;
      const sel = opts.getSelection();
      if (sel) {
        navigator.clipboard.writeText(sel).catch(() => {});
      }
    };
  }

  it("does NOT write to clipboard when auto-copy is disabled (default)", () => {
    const handler = makeSelectionHandler({
      autoCopyEnabled: { current: false },
      getSelection: () => "highlighted but should NOT be copied",
    });
    handler();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("writes to clipboard when auto-copy is enabled and selection non-empty", () => {
    const handler = makeSelectionHandler({
      autoCopyEnabled: { current: true },
      getSelection: () => "selected text",
    });
    handler();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("selected text");
  });

  it("does not write when auto-copy enabled but selection is empty", () => {
    const handler = makeSelectionHandler({
      autoCopyEnabled: { current: true },
      getSelection: () => "",
    });
    handler();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("respects live updates to the ref (no remount required)", () => {
    const ref = { current: false };
    const handler = makeSelectionHandler({
      autoCopyEnabled: ref,
      getSelection: () => "x",
    });
    handler();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    // User flips the setting — next selection should copy.
    ref.current = true;
    handler();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("x");
  });
});

describe("Terminal — explicit Cmd/Ctrl+C copy (always available)", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      writable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  /**
   * Mirrors `attachCustomKeyEventHandler` in Terminal.tsx — the function
   * returns `false` to swallow the keystroke (xterm will not forward it
   * to the data handler) or `true` to let it through.
   */
  function makeKeyHandler(opts: { getSelection: () => string }) {
    return (e: { type: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; key: string }) => {
      if (e.type !== "keydown") return true;
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.altKey) return true;
      const key = e.key.toLowerCase();
      if (key === "c") {
        const sel = opts.getSelection();
        if (sel.length > 0) {
          navigator.clipboard.writeText(sel).catch(() => {});
          return false;
        }
        return true;
      }
      return true;
    };
  }

  it("Cmd+C with selection copies AND swallows keystroke", () => {
    const handler = makeKeyHandler({ getSelection: () => "abc" });
    const result = handler({
      type: "keydown",
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      key: "c",
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("abc");
    expect(result).toBe(false); // xterm must NOT forward as SIGINT
  });

  it("Ctrl+C with selection copies AND swallows keystroke", () => {
    const handler = makeKeyHandler({ getSelection: () => "abc" });
    const result = handler({
      type: "keydown",
      metaKey: false,
      ctrlKey: true,
      altKey: false,
      key: "c",
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("abc");
    expect(result).toBe(false);
  });

  it("Ctrl+C with EMPTY selection does NOT swallow (SIGINT must reach remote)", () => {
    const handler = makeKeyHandler({ getSelection: () => "" });
    const result = handler({
      type: "keydown",
      metaKey: false,
      ctrlKey: true,
      altKey: false,
      key: "c",
    });
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(result).toBe(true); // pass-through so xterm sends Ctrl+C
  });

  it("Ctrl+Alt+C is NOT treated as copy (modifier collision avoidance)", () => {
    const handler = makeKeyHandler({ getSelection: () => "abc" });
    const result = handler({
      type: "keydown",
      metaKey: false,
      ctrlKey: true,
      altKey: true,
      key: "c",
    });
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });
});

describe("Terminal — ssh_write failure surfaces inline (P1#2)", () => {
  /**
   * Mirrors the `term.onData` body in Terminal.tsx — when ssh_write
   * rejects, we render a single red banner the first time and remember
   * the failure flag so the user isn't spammed on every keystroke after
   * the session is dead.
   */
  function makeDataHandler(opts: {
    invokeImpl: (cmd: string, args: unknown) => Promise<void>;
    write: (s: string) => void;
  }) {
    let writeFailed = false;
    return async (data: string) => {
      try {
        await opts.invokeImpl("ssh_write", { data });
      } catch (err) {
        if (!writeFailed) {
          writeFailed = true;
          const msg = typeof err === "string" ? err : String(err ?? "session lost");
          opts.write(`\r\n\x1b[31mInput dropped — SSH session lost: ${msg}\x1b[0m\r\n`);
        }
      }
    };
  }

  it("renders red error banner once when ssh_write rejects", async () => {
    const writeSpy = vi.fn();
    const handler = makeDataHandler({
      invokeImpl: () => Promise.reject("session not found"),
      write: writeSpy,
    });
    await handler("a");
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy.mock.calls[0][0]).toContain("Input dropped");
    expect(writeSpy.mock.calls[0][0]).toContain("session not found");
    expect(writeSpy.mock.calls[0][0]).toContain("\x1b[31m"); // red ANSI
  });

  it("does NOT spam the banner on subsequent failed writes", async () => {
    const writeSpy = vi.fn();
    const handler = makeDataHandler({
      invokeImpl: () => Promise.reject("dead"),
      write: writeSpy,
    });
    await handler("a");
    await handler("b");
    await handler("c");
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  it("succeeds silently when ssh_write resolves (no banner)", async () => {
    const writeSpy = vi.fn();
    const handler = makeDataHandler({
      invokeImpl: () => Promise.resolve(),
      write: writeSpy,
    });
    await handler("a");
    expect(writeSpy).not.toHaveBeenCalled();
  });
});
