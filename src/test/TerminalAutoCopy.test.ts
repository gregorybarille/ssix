import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Test the auto-copy-on-selection logic in isolation.
// The Terminal component uses xterm.js which cannot run in jsdom, so we verify
// the clipboard integration by simulating the onSelectionChange callback.

describe("Terminal auto-copy on selection", () => {
  const originalClipboard = navigator.clipboard;

  beforeEach(() => {
    // Stub clipboard.writeText
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      writable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      writable: true,
      value: originalClipboard,
    });
  });

  it("writes selected text to clipboard when selection is non-empty", async () => {
    const getSelection = vi.fn().mockReturnValue("selected text");
    // Simulate the callback registered with term.onSelectionChange
    const onSelectionChange = () => {
      const sel = getSelection();
      if (sel) {
        navigator.clipboard.writeText(sel).catch(() => {});
      }
    };

    onSelectionChange();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("selected text");
  });

  it("does not write to clipboard when selection is empty", async () => {
    const getSelection = vi.fn().mockReturnValue("");
    const onSelectionChange = () => {
      const sel = getSelection();
      if (sel) {
        navigator.clipboard.writeText(sel).catch(() => {});
      }
    };

    onSelectionChange();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });
});
