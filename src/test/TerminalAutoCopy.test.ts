import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { autoCopySelection } from "@/components/terminal/autoCopySelection";
import type { TerminalExtensionContext } from "@/components/terminal/extensions";
import { useTerminalSearchStore } from "@/store/useTerminalSearchStore";
import type { AppSettings } from "@/types";

/**
 * Audit-3 P1#1: Terminal clipboard interactions.
 *
 * Auto-copy is a terminal extension and is tested directly against a stand-in
 * for xterm. It is OPT-IN (gated on `settings.auto_copy_selection`): the default
 * (false) MUST NOT silently overwrite the user's clipboard when text is
 * highlighted (the original P1#1 finding). The ssh_write behaviour still lives
 * in Terminal.tsx, so that test exercises a copy of its callback. The clipboard
 * keys are tested on the real handler, in `TerminalExtensionHooks.test.tsx`.
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
   * Runs the real extension against a stand-in for xterm. `settings` is what
   * the terminal's context would hand out at that moment, so changing it
   * models the setting being toggled while the terminal stays mounted.
   */
  function mountExtension(opts: {
    settings: { current: Pick<AppSettings, "auto_copy_selection"> | undefined };
    getSelection: () => string;
  }) {
    let onSelection: () => void = () => {};
    const dispose = vi.fn();
    const ctx = {
      term: {
        getSelection: opts.getSelection,
        onSelectionChange: (listener: () => void) => {
          onSelection = listener;
          return { dispose };
        },
      },
      sessionId: "s1",
      get settings() {
        return opts.settings.current;
      },
    } as unknown as TerminalExtensionContext;
    const cleanup = autoCopySelection.onCreate?.(ctx);
    return { select: () => onSelection(), cleanup, dispose };
  }

  it("does NOT write to clipboard when auto-copy is disabled (default)", () => {
    const { select } = mountExtension({
      settings: { current: { auto_copy_selection: false } },
      getSelection: () => "highlighted but should NOT be copied",
    });
    select();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("does NOT write to clipboard before settings are known", () => {
    const { select } = mountExtension({
      settings: { current: undefined },
      getSelection: () => "highlighted but should NOT be copied",
    });
    select();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("writes to clipboard when auto-copy is enabled and selection non-empty", () => {
    const { select } = mountExtension({
      settings: { current: { auto_copy_selection: true } },
      getSelection: () => "selected text",
    });
    select();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("selected text");
  });

  it("does not write when auto-copy enabled but selection is empty", () => {
    const { select } = mountExtension({
      settings: { current: { auto_copy_selection: true } },
      getSelection: () => "",
    });
    select();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("respects live updates to the setting (no remount required)", () => {
    const settings = { current: { auto_copy_selection: false } };
    const { select } = mountExtension({ settings, getSelection: () => "x" });
    select();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    // User flips the setting — next selection should copy.
    settings.current = { auto_copy_selection: true };
    select();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("x");
  });

  it("leaves the clipboard alone while a search selects its matches", () => {
    const { select } = mountExtension({
      settings: { current: { auto_copy_selection: true } },
      getSelection: () => "a match",
    });
    useTerminalSearchStore.setState({ sessionId: "s1" });
    select();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();

    useTerminalSearchStore.setState({ sessionId: "another-pane" });
    select();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("a match");
    useTerminalSearchStore.setState({ sessionId: null });
  });

  it("releases the selection listener when the terminal goes away", () => {
    const { cleanup, dispose } = mountExtension({
      settings: { current: { auto_copy_selection: true } },
      getSelection: () => "x",
    });
    if (cleanup) cleanup();
    expect(dispose).toHaveBeenCalledTimes(1);
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
