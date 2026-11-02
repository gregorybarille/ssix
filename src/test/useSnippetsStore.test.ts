import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SHORTCUTS, TABLE_SHORTCUTS, useGlobalShortcuts } from "@/hooks/useGlobalShortcuts";
import { invoke } from "@/lib/tauri";
import { useSnippetsStore } from "@/store/useSnippetsStore";
import { useTerminalsStore } from "@/store/useTerminalsStore";
import { useViewStore } from "@/store/useViewStore";
import type { Snippet } from "@/types";

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn() }));

const mockInvoke = vi.mocked(invoke);
const disk: Snippet = { id: "s1", name: "disk", command: "df -h" };
const input = { name: "disk", command: "df -h", tags: [] };
const store = () => useSnippetsStore.getState();

const oneTab = {
  tabs: [{ id: "t1", mode: "single" as const, panes: [{ sessionId: "s", connectionName: "c" }] }],
  activeTabId: "t1",
};

describe("useSnippetsStore", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    useSnippetsStore.setState({ snippets: [], error: null, isLoading: false, paletteOpen: false });
    useTerminalsStore.setState({ tabs: [], activeTabId: null });
    useViewStore.setState({ view: "connections", leaveGuard: null });
  });

  it("fetches and keeps a load failure in error", async () => {
    mockInvoke.mockResolvedValueOnce([disk]);
    await store().fetchSnippets();
    expect(mockInvoke).toHaveBeenCalledWith("get_snippets");
    expect(store().snippets).toEqual([disk]);

    mockInvoke.mockRejectedValueOnce("nope");
    await store().fetchSnippets();
    expect(store().error).toBe("nope");
    expect(store().snippets).toEqual([disk]);
  });

  it("appends what the backend created, with the backend's id", async () => {
    mockInvoke.mockResolvedValueOnce(disk);
    await expect(store().addSnippet(input)).resolves.toEqual(disk);
    expect(mockInvoke).toHaveBeenCalledWith("add_snippet", { input });
    expect(store().snippets).toEqual([disk]);
  });

  it("replaces an updated snippet", async () => {
    useSnippetsStore.setState({ snippets: [disk, { ...disk, id: "s2" }] });
    const updated = { ...disk, command: "du" };
    mockInvoke.mockResolvedValueOnce(updated);
    await store().updateSnippet("s1", { ...input, command: "du" });
    expect(mockInvoke).toHaveBeenCalledWith("update_snippet", {
      id: "s1",
      input: { ...input, command: "du" },
    });
    expect(store().snippets.map((s) => s.command)).toEqual(["du", "df -h"]);
  });

  it("removes a deleted snippet", async () => {
    useSnippetsStore.setState({ snippets: [disk, { ...disk, id: "s2" }] });
    mockInvoke.mockResolvedValueOnce(undefined);
    await store().deleteSnippet("s1");
    expect(mockInvoke).toHaveBeenCalledWith("delete_snippet", { id: "s1" });
    expect(store().snippets.map((s) => s.id)).toEqual(["s2"]);
  });

  it.each([
    ["addSnippet", () => store().addSnippet(input)],
    ["updateSnippet", () => store().updateSnippet("s1", input)],
    ["deleteSnippet", () => store().deleteSnippet("s1")],
  ])("%s rejects to its caller and leaves no load error behind", async (_name, call) => {
    useSnippetsStore.setState({ snippets: [disk] });
    mockInvoke.mockRejectedValueOnce("refused");
    await expect(call()).rejects.toBe("refused");
    expect(store().error).toBeNull();
    expect(store().snippets).toEqual([disk]);
    expect(store().isLoading).toBe(false);
  });

  describe("the palette", () => {
    it("opens and closes", () => {
      store().openPalette();
      expect(store().paletteOpen).toBe(true);
      store().closePalette();
      expect(store().paletteOpen).toBe(false);
    });

    it("stays on the current view with no terminal open, to explain that there", () => {
      store().openPalette();
      expect(useViewStore.getState().view).toBe("connections");
    });

    it("goes to the terminals, which only exist on their own view", () => {
      useTerminalsStore.setState(oneTab);
      store().openPalette();
      expect(useViewStore.getState().view).toBe("terminals");
      expect(store().paletteOpen).toBe(true);
    });

    it("lets an editor with unsaved changes ask first", () => {
      useTerminalsStore.setState(oneTab);
      const guard = vi.fn();
      useViewStore.setState({ leaveGuard: guard });
      store().openPalette();
      expect(guard).toHaveBeenCalledOnce();
      expect(useViewStore.getState().view).toBe("connections");
    });
  });
});

describe("the palette shortcut", () => {
  const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || "");
  const mod = isMac ? { metaKey: true } : { ctrlKey: true };
  const entry = SHORTCUTS.find((s) => s.combo === "mod+shift+s");

  beforeEach(() => {
    document.body.innerHTML = "";
    useSnippetsStore.setState({ paletteOpen: false });
    useTerminalsStore.setState({ tabs: [], activeTabId: null });
  });

  it("is in the table once, and App's own map does not take it", () => {
    expect(entry).toBeDefined();
    expect(SHORTCUTS.filter((s) => s.combo === "mod+shift+s")).toHaveLength(1);
    const app = readFileSync(resolve(__dirname, "../App.tsx"), "utf8");
    expect(app).not.toContain("mod+shift+s");
  });

  it("leaves the combos xterm handles itself alone", () => {
    expect(entry?.combo).not.toMatch(/\+[cv]$/);
  });

  it("is documented", () => {
    const docs = readFileSync(resolve(__dirname, "../../docs/features.md"), "utf8");
    expect(docs).toContain("`Mod+Shift+S`");
  });

  it("opens the palette from inside a terminal, which is its main use", () => {
    renderHook(() => useGlobalShortcuts(TABLE_SHORTCUTS));
    const term = document.createElement("div");
    term.className = "xterm";
    const textarea = document.createElement("textarea");
    term.appendChild(textarea);
    document.body.appendChild(term);
    const event = new KeyboardEvent("keydown", {
      key: "S",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
      ...mod,
    });
    textarea.dispatchEvent(event);
    expect(useSnippetsStore.getState().paletteOpen).toBe(true);
    expect(event.defaultPrevented).toBe(true);
  });

  it("does not fire without Shift", () => {
    renderHook(() => useGlobalShortcuts(TABLE_SHORTCUTS));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", bubbles: true, ...mod }));
    expect(useSnippetsStore.getState().paletteOpen).toBe(false);
  });
});
