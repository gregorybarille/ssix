import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal as XTerm } from "@xterm/xterm";
import type { SearchAddon } from "@xterm/addon-search";
import { TerminalPaneOverlays } from "@/components/terminal/TerminalPaneOverlays";
import { terminalSearch } from "@/components/terminal/terminalSearch";
import type { TerminalExtensionContext } from "@/components/terminal/extensions";
import { registerTerminal, unregisterTerminal } from "@/lib/terminalRegistry";
import { registerSearchablePane, unregisterSearchablePane } from "@/lib/terminalSearch";
import { useTerminalSearchStore } from "@/store/useTerminalSearchStore";
import { useTerminalsStore } from "@/store/useTerminalsStore";
import { useViewStore } from "@/store/useViewStore";

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {
    onDidChangeResults() {
      return { dispose() {} };
    }
    clearDecorations() {}
  },
}));

type ResultsListener = (results: { resultIndex: number; resultCount: number }) => void;

function fakePane(sessionId: string) {
  let listener: ResultsListener = () => {};
  const term = {
    options: { theme: { background: "#1a1b26" } },
    textarea: document.createElement("textarea"),
    focus: vi.fn(),
    clearSelection: vi.fn(),
  };
  const addon = {
    findNext: vi.fn(() => true),
    findPrevious: vi.fn(() => true),
    clearDecorations: vi.fn(),
    onDidChangeResults: (next: ResultsListener) => {
      listener = next;
      return { dispose() {} };
    },
  };
  registerTerminal(sessionId, term as unknown as XTerm);
  registerSearchablePane(sessionId, addon as unknown as SearchAddon);
  return { term, addon, report: (index: number, count: number) => listener({ resultIndex: index, resultCount: count }) };
}

const search = () => useTerminalSearchStore.getState();

const sessions = ["s1", "s2", "elsewhere"];
let panes: Record<string, ReturnType<typeof fakePane>>;

/** Forget the pane that last had focus, which the registry keeps past a terminal going. */
function forgetLastFocus(pane: ReturnType<typeof fakePane>) {
  document.body.appendChild(pane.term.textarea);
  pane.term.textarea.focus();
  pane.term.textarea.remove();
}

function renderOverlay(sessionId = "s1", isVisible = true) {
  return render(<TerminalPaneOverlays sessionId={sessionId} isVisible={isVisible} statusShown={false} />);
}

const input = () => screen.getByTestId("terminal-search-input") as HTMLInputElement;

beforeEach(() => {
  sessions.forEach((id) => {
    unregisterTerminal(id);
    unregisterSearchablePane(id);
  });
  document.body.innerHTML = "";
  panes = Object.fromEntries(sessions.map((id) => [id, fakePane(id)]));
  forgetLastFocus(panes.elsewhere);
  useViewStore.setState({ view: "terminals" });
  useTerminalsStore.setState({
    tabs: [
      {
        id: "t1",
        mode: "horizontal",
        panes: [
          { sessionId: "s1", connectionName: "a" },
          { sessionId: "s2", connectionName: "b" },
        ],
      },
      { id: "t2", mode: "single", panes: [{ sessionId: "elsewhere", connectionName: "c" }] },
    ],
    activeTabId: "t1",
  });
  useTerminalSearchStore.setState({ sessionId: null, focusRequest: 0 });
});

describe("opening the find bar", () => {
  it("opens on the pane that last had focus in the visible tab", () => {
    document.body.appendChild(panes.s2.term.textarea);
    panes.s2.term.textarea.focus();
    search().open();
    expect(search().sessionId).toBe("s2");
  });

  it("opens on the first pane of the tab otherwise, never on a background tab", () => {
    document.body.appendChild(panes.elsewhere.term.textarea);
    panes.elsewhere.term.textarea.focus();
    search().open();
    expect(search().sessionId).toBe("s1");
  });

  it("does nothing outside the Terminals view", () => {
    useViewStore.setState({ view: "connections" });
    search().open();
    expect(search().sessionId).toBeNull();
  });

  it("does nothing while a panel holds the keyboard", () => {
    const panel = document.createElement("div");
    panel.dataset.slot = "app-panel-content";
    document.body.appendChild(panel);
    search().open();
    expect(search().sessionId).toBeNull();
  });

  it("does nothing when the visible tab has no live terminal", () => {
    useTerminalsStore.setState({
      tabs: [{ id: "t9", mode: "single", panes: [{ sessionId: "failed", connectionName: "x", error: "no" }] }],
      activeTabId: "t9",
    });
    search().open();
    expect(search().sessionId).toBeNull();
  });

  it("moves to another pane, and clears the search it leaves", () => {
    search().open();
    expect(search().sessionId).toBe("s1");
    document.body.appendChild(panes.s2.term.textarea);
    panes.s2.term.textarea.focus();
    search().open();
    expect(search().sessionId).toBe("s2");
    expect(panes.s1.addon.clearDecorations).toHaveBeenCalledOnce();
  });

  it("takes the keyboard back when asked again while open", () => {
    search().open();
    renderOverlay();
    expect(document.activeElement).toBe(input());
    input().blur();
    act(() => search().open());
    expect(document.activeElement).toBe(input());
  });
});

describe("the find bar", () => {
  const open = () => {
    search().open();
    renderOverlay();
  };

  it("searches as the query is typed, staying on a match that still fits", () => {
    open();
    fireEvent.change(input(), { target: { value: "needle" } });
    expect(panes.s1.addon.findNext).toHaveBeenCalledExactlyOnceWith(
      "needle",
      expect.objectContaining({ incremental: true }),
    );
  });

  it("goes to the next match on Enter and the button, the previous on Shift+Enter and the button", () => {
    open();
    fireEvent.change(input(), { target: { value: "needle" } });
    panes.s1.addon.findNext.mockClear();

    fireEvent.keyDown(input(), { key: "Enter" });
    fireEvent.click(screen.getByTestId("terminal-search-next"));
    expect(panes.s1.addon.findNext).toHaveBeenCalledTimes(2);
    expect(panes.s1.addon.findNext).toHaveBeenLastCalledWith(
      "needle",
      expect.objectContaining({ incremental: false }),
    );

    fireEvent.keyDown(input(), { key: "Enter", shiftKey: true });
    fireEvent.click(screen.getByTestId("terminal-search-previous"));
    expect(panes.s1.addon.findPrevious).toHaveBeenCalledTimes(2);
    expect(panes.s1.addon.findPrevious).toHaveBeenLastCalledWith("needle", expect.anything());
  });

  it("does nothing on Enter with no query", () => {
    open();
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(panes.s1.addon.findNext).not.toHaveBeenCalled();
    expect(screen.getByTestId("terminal-search-next")).toBeDisabled();
    expect(screen.getByTestId("terminal-search-previous")).toBeDisabled();
  });

  it("says how many matches there are and which one is current", () => {
    open();
    fireEvent.change(input(), { target: { value: "needle" } });
    act(() => panes.s1.report(1, 3));
    expect(screen.getByTestId("terminal-search-status")).toHaveTextContent("2 of 3");
    act(() => panes.s1.report(-1, 1000));
    expect(screen.getByTestId("terminal-search-status")).toHaveTextContent("More than 1000 matches");
  });

  it("says so in words when nothing matches, and offers nowhere to go", () => {
    open();
    fireEvent.change(input(), { target: { value: "absent" } });
    act(() => panes.s1.report(-1, 0));
    expect(screen.getByTestId("terminal-search-status")).toHaveTextContent("No matches");
    expect(screen.getByTestId("terminal-search-status")).toHaveClass("text-destructive");
    expect(input()).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByTestId("terminal-search-next")).toBeDisabled();
  });

  it("says nothing for an empty query, though the addon reports no results for it", () => {
    open();
    fireEvent.change(input(), { target: { value: "x" } });
    fireEvent.change(input(), { target: { value: "" } });
    act(() => panes.s1.report(-1, 0));
    expect(screen.getByTestId("terminal-search-status")).toHaveTextContent("");
    expect(input()).not.toHaveAttribute("aria-invalid");
  });

  it("closes on Escape, clears the highlights and gives the terminal the keyboard back", () => {
    open();
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(search().sessionId).toBeNull();
    expect(panes.s1.addon.clearDecorations).toHaveBeenCalledOnce();
    expect(panes.s1.term.clearSelection).toHaveBeenCalledOnce();
    expect(panes.s1.term.focus).toHaveBeenCalledOnce();
  });

  it("closes on its button the same way", () => {
    open();
    fireEvent.click(screen.getByTestId("terminal-search-close"));
    expect(search().sessionId).toBeNull();
    expect(panes.s1.term.focus).toHaveBeenCalledOnce();
  });

  it("is only ever on its own pane", () => {
    search().open();
    renderOverlay("s2");
    expect(screen.queryByTestId("terminal-search")).toBeNull();
  });

  it("closes without taking the keyboard when its pane is hidden", () => {
    search().open();
    const view = renderOverlay();
    view.rerender(<TerminalPaneOverlays sessionId="s1" isVisible={false} statusShown={false} />);
    expect(screen.queryByTestId("terminal-search")).toBeNull();
    expect(search().sessionId).toBeNull();
    expect(panes.s1.addon.clearDecorations).toHaveBeenCalledOnce();
    expect(panes.s1.term.focus).not.toHaveBeenCalled();
  });

  it("moves out of the way of a connection status along the top", () => {
    search().open();
    const view = renderOverlay();
    expect(screen.getByTestId("terminal-search")).toHaveClass("top-2");
    view.rerender(<TerminalPaneOverlays sessionId="s1" isVisible statusShown />);
    expect(screen.getByTestId("terminal-search")).toHaveClass("bottom-2");
  });
});

describe("the find shortcut, per platform", () => {
  it.each([
    ["macOS", "MacIntel", { key: "f", metaKey: true }],
    ["Linux", "Linux x86_64", { key: "F", ctrlKey: true, shiftKey: true }],
    ["Windows", "Win32", { key: "F", ctrlKey: true, shiftKey: true }],
  ])("is its own on %s, and Ctrl+F stays the program's", async (_os, platform, find) => {
    vi.resetModules();
    const stub = vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    const { normalizeEvent, TABLE_SHORTCUTS } = await import("@/hooks/useGlobalShortcuts");
    const { terminalSearch: extension } = await import("@/components/terminal/terminalSearch");
    const ctx = { sessionId: "s1" } as TerminalExtensionContext;
    const opensFind = (event: KeyboardEvent) =>
      TABLE_SHORTCUTS[normalizeEvent(event) ?? ""] !== undefined;

    const shortcut = new KeyboardEvent("keydown", find);
    expect(opensFind(shortcut)).toBe(true);
    expect(extension.onKey?.(ctx, shortcut)).toBe(false);

    const ctrlF = new KeyboardEvent("keydown", { key: "f", ctrlKey: true });
    expect(opensFind(ctrlF)).toBe(false);
    expect(extension.onKey?.(ctx, ctrlF)).toBe(true);

    stub.mockRestore();
    vi.resetModules();
  });
});

describe("the terminal-search extension", () => {
  const IS_MAC = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || "");
  const find = IS_MAC ? { key: "f", metaKey: true } : { key: "F", ctrlKey: true, shiftKey: true };
  const ctx = { sessionId: "s1" } as TerminalExtensionContext;
  const passes = (init: KeyboardEventInit) =>
    terminalSearch.onKey?.(ctx, new KeyboardEvent("keydown", init));

  it("keeps the find shortcut from xterm and nothing else", () => {
    expect(passes(find)).toBe(false);
    expect(passes({ ...find, key: find.key === "f" ? "F" : "f" })).toBe(false);
    expect(passes({ key: "f" })).toBe(true);
    expect(passes({ key: "f", ctrlKey: true })).toBe(true);
    expect(passes({ ...find, altKey: true })).toBe(true);
    expect(passes({ ...find, key: "c" })).toBe(true);
  });

  it("closes its pane's bar and stops taking part when the terminal goes", () => {
    const term = {
      options: {} as { allowProposedApi?: boolean },
      loadAddon: vi.fn(),
      focus: vi.fn(),
      clearSelection: vi.fn(),
    };
    const cleanup = terminalSearch.onCreate?.({
      ...ctx,
      term: term as unknown as XTerm,
    });
    expect(term.options.allowProposedApi).toBe(true);
    search().open();
    expect(search().sessionId).toBe("s1");
    if (cleanup) cleanup();
    expect(search().sessionId).toBeNull();
    expect(term.focus).not.toHaveBeenCalled();
  });
});
