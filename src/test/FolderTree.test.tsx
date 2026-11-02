import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { FolderTree } from "@/components/FolderTree";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { loadCollapsedFolders } from "@/lib/folders";
import { useConnectionsStore } from "@/store/useConnectionsStore";
import type { Connection } from "@/types";
import { renderInPanel } from "./panel";
import { withPointerCoordinates } from "./pointerEvents";

const direct = (name: string, folder?: string, tags?: string[]): Connection => ({
  id: name,
  name,
  host: `${name}.example`,
  port: 22,
  type: "direct",
  folder,
  tags,
});

const forward = (name: string, folder?: string): Connection => ({
  id: name,
  name,
  host: "",
  port: 22,
  type: "port_forward",
  gateway_host: "gw",
  gateway_port: 22,
  gateway_credential_id: "k",
  local_port: 8080,
  destination_host: "x",
  destination_port: 80,
  folder,
});

const CONNECTIONS = [
  direct("top", "prod", ["blue"]),
  direct("eu-one", "prod/eu"),
  direct("west", "prod/eu/west"),
  direct("lookalike", "production"),
  direct("loose"),
];

const handlers = {
  onEdit: vi.fn(),
  onDelete: vi.fn(),
  onClone: vi.fn(),
  onConnect: vi.fn(),
  onScp: vi.fn(),
  onBrowse: vi.fn(),
};

const invokeMock = vi.mocked(invoke);

/** The tree, fed from the store as `ConnectionsView` does, with a search box. */
function Harness({ query: initial = "" }: { query?: string }) {
  const connections = useConnectionsStore((s) => s.connections);
  const [query, setQuery] = useState(initial);
  return (
    <>
      <input aria-label="search" value={query} onChange={(e) => setQuery(e.target.value)} />
      <FolderTree connections={connections} credentials={[]} query={query} {...handlers} />
    </>
  );
}

function show(connections: Connection[] = CONNECTIONS, query?: string) {
  act(() => {
    useConnectionsStore.setState({ connections, error: null, isLoading: false });
  });
  return render(<Harness query={query} />);
}

const folderRow = (path: string) =>
  document.querySelector<HTMLElement>(`[data-testid="folder-row"][data-name="${path}"]`);
const noFolderRow = () => screen.queryByTestId("folder-no-folder");
const connectionRow = (name: string) =>
  document.querySelector<HTMLElement>(`[data-testid^="connection-row-"][data-name="${name}"]`);
const treeItemNames = () =>
  screen.getAllByRole("treeitem").map((item) => item.getAttribute("aria-label"));
const focusedLabel = () => document.activeElement?.getAttribute("aria-label");

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
  for (const handler of Object.values(handlers)) handler.mockReset();
});

afterEach(() => {
  act(() => useConnectionsStore.setState({ connections: [] }));
});

describe("the tree", () => {
  it("is an ARIA tree of nested folders with a count each", () => {
    show();
    expect(screen.getByRole("tree", { name: "Connections by folder" })).toBeInTheDocument();
    expect(treeItemNames()).toEqual([
      "prod, 3 connections",
      "eu, 2 connections",
      "west, 1 connection",
      "west",
      "eu-one",
      "top, tagged blue",
      "production, 1 connection",
      "lookalike",
      "No folder, 1 connection",
      "loose",
    ]);
    const prod = folderRow("prod")!;
    expect(prod).toHaveAttribute("aria-level", "1");
    expect(prod).toHaveAttribute("aria-expanded", "true");
    expect(prod).toHaveAttribute("aria-posinset", "1");
    expect(prod).toHaveAttribute("aria-setsize", "3");
    expect(within(prod).getByTestId("folder-count")).toHaveTextContent("3");
    expect(connectionRow("west")).toHaveAttribute("aria-level", "4");
    expect(connectionRow("west")).not.toHaveAttribute("aria-expanded");
  });

  it("collapses and expands from a click, and remembers it for the next visit", async () => {
    const user = userEvent.setup();
    const { unmount } = show();
    await user.click(folderRow("prod/eu")!);
    expect(folderRow("prod/eu")).toHaveAttribute("aria-expanded", "false");
    expect(connectionRow("eu-one")).toBeNull();
    expect(connectionRow("top")).not.toBeNull();

    unmount();
    render(<Harness />);
    expect(folderRow("prod/eu")).toHaveAttribute("aria-expanded", "false");
    expect(connectionRow("eu-one")).toBeNull();

    await user.click(folderRow("prod/eu")!);
    expect(connectionRow("eu-one")).not.toBeNull();
  });

  it("opens fully when the remembered state is corrupt", () => {
    localStorage.setItem("ssix.folders.collapsed", "{not json");
    show();
    expect(connectionRow("west")).not.toBeNull();
  });

  it("leaves port forwards out, however they are filed", () => {
    show([direct("web", "prod"), forward("tunnel", "prod"), forward("other", "only-forwards")]);
    expect(connectionRow("tunnel")).toBeNull();
    expect(folderRow("only-forwards")).toBeNull();
    expect(within(folderRow("prod")!).getByTestId("folder-count")).toHaveTextContent("1");
  });

  it("shows the empty state when only forwards exist", () => {
    show([forward("tunnel", "prod")]);
    expect(screen.queryByRole("tree")).not.toBeInTheDocument();
    expect(screen.getByText("No connections yet")).toBeInTheDocument();
  });

  it("keeps an empty no-folder section to drop on", () => {
    show([direct("web", "prod")]);
    expect(noFolderRow()).toHaveAttribute("aria-label", "No folder, 0 connections");
    expect(noFolderRow()).not.toHaveAttribute("aria-expanded");
  });
});

describe("rows keep what rows have elsewhere", () => {
  it("has the row test id, data-name and every action", async () => {
    const user = userEvent.setup();
    show();
    const row = connectionRow("top")!;
    expect(row).toHaveAttribute("data-testid", "connection-row-top");
    expect(row).toHaveAttribute("role", "treeitem");

    await user.click(within(row).getByRole("button", { name: "Connect to top" }));
    expect(handlers.onConnect).toHaveBeenCalledWith(expect.objectContaining({ id: "top" }));
    await user.click(within(row).getByRole("button", { name: "Browse files on top" }));
    expect(handlers.onBrowse).toHaveBeenCalledTimes(1);
    await user.click(within(row).getByRole("button", { name: "Transfer files to top" }));
    expect(handlers.onScp).toHaveBeenCalledTimes(1);
    await user.click(within(row).getByRole("button", { name: "Clone top" }));
    expect(handlers.onClone).toHaveBeenCalledTimes(1);
    await user.click(within(row).getByRole("button", { name: "Edit top" }));
    expect(handlers.onEdit).toHaveBeenCalledTimes(1);
    await user.click(within(row).getByRole("button", { name: "Delete top" }));
    expect(handlers.onDelete).toHaveBeenCalledWith("top");
    // Those stayed on their buttons: none of them opened a session as well.
    expect(handlers.onConnect).toHaveBeenCalledTimes(1);
  });

  it("connects on a click on the row", async () => {
    const user = userEvent.setup();
    show();
    await user.click(connectionRow("top")!);
    expect(handlers.onConnect).toHaveBeenCalledTimes(1);
  });

  it("has the context menu, with Browse files, and adds the move", () => {
    show();
    fireEvent.contextMenu(connectionRow("top")!);
    const menu = screen.getByRole("menu", { name: "Actions for top" });
    for (const name of [
      "Connect",
      "Edit",
      "Clone",
      "Move to folder…",
      "Transfer files",
      "Browse files",
      "Copy SSH command",
      "Delete",
    ]) {
      expect(within(menu).getByRole("menuitem", { name })).toBeInTheDocument();
    }
  });
});

describe("keyboard", () => {
  const press = (key: string, init: object = {}) => {
    fireEvent.keyDown(document.activeElement!, { key, ...init });
    return new Promise<void>((resolve) => queueMicrotask(resolve));
  };

  const focus = (element: HTMLElement) => act(() => element.focus());

  it("is one tab stop, whatever the rows hold", () => {
    show();
    const inTree = screen.getByRole("tree").querySelectorAll<HTMLElement>("*");
    const stops = [...inTree].filter((element) => element.tabIndex >= 0);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toHaveAttribute("role", "treeitem");
    // The buttons taken out of the order are still there for the pointer.
    expect(within(folderRow("prod")!).getByTestId("folder-rename")).toBeInTheDocument();
    expect(screen.getByTestId("connect-button-top")).toBeInTheDocument();
  });

  it("offers everything a row's buttons do in its menu", () => {
    show();
    const row = connectionRow("top")!;
    const buttons = within(row)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"));
    expect(buttons).toEqual([
      "Connect to top",
      "Browse files on top",
      "Transfer files to top",
      "Clone top",
      "Edit top",
      "Delete top",
    ]);
    fireEvent.contextMenu(row);
    const rowMenu = screen.getByRole("menu", { name: "Actions for top" });
    for (const name of ["Connect", "Browse files", "Transfer files", "Clone", "Edit", "Delete"]) {
      expect(within(rowMenu).getByRole("menuitem", { name })).toBeInTheDocument();
    }
    fireEvent.keyDown(document, { key: "Escape" });

    const folder = folderRow("prod")!;
    expect(within(folder).getAllByRole("button")).toHaveLength(2);
    fireEvent.contextMenu(folder);
    const folderMenu = screen.getByRole("menu", { name: "Actions for prod" });
    for (const name of ["Rename folder…", "Delete folder…"]) {
      expect(within(folderMenu).getByRole("menuitem", { name })).toBeInTheDocument();
    }
  });

  it("walks the visible rows with Up, Down, Home and End", async () => {
    show();
    focus(folderRow("prod")!);
    await act(() => press("ArrowDown"));
    expect(focusedLabel()).toBe("eu, 2 connections");
    await act(() => press("ArrowUp"));
    expect(focusedLabel()).toBe("prod, 3 connections");
    await act(() => press("End"));
    expect(focusedLabel()).toBe("loose");
    await act(() => press("Home"));
    expect(focusedLabel()).toBe("prod, 3 connections");
  });

  it("follows the tree pattern with Right and Left", async () => {
    show();
    focus(folderRow("prod")!);
    // Open folder, Right: first child.
    await act(() => press("ArrowRight"));
    expect(focusedLabel()).toBe("eu, 2 connections");
    // Open folder, Left: closes.
    await act(() => press("ArrowLeft"));
    expect(folderRow("prod/eu")).toHaveAttribute("aria-expanded", "false");
    expect(connectionRow("eu-one")).toBeNull();
    expect(focusedLabel()).toBe("eu, 2 connections");
    // Closed folder, Right: opens and stays.
    await act(() => press("ArrowRight"));
    expect(folderRow("prod/eu")).toHaveAttribute("aria-expanded", "true");
    expect(focusedLabel()).toBe("eu, 2 connections");
    // Closed folder, Left: its parent.
    await act(() => press("ArrowLeft"));
    await act(() => press("ArrowLeft"));
    expect(focusedLabel()).toBe("prod, 3 connections");
  });

  it("moves from a connection to its folder with Left, and Right does nothing", async () => {
    show();
    focus(connectionRow("top")!);
    await act(() => press("ArrowRight"));
    expect(focusedLabel()).toBe("top, tagged blue");
    await act(() => press("ArrowLeft"));
    expect(focusedLabel()).toBe("prod, 3 connections");
  });

  it("toggles a folder and connects a row with Enter and Space", async () => {
    show();
    focus(folderRow("production")!);
    await act(() => press("Enter"));
    expect(folderRow("production")).toHaveAttribute("aria-expanded", "false");
    await act(() => press(" "));
    expect(folderRow("production")).toHaveAttribute("aria-expanded", "true");
    expect(handlers.onConnect).not.toHaveBeenCalled();

    focus(connectionRow("loose")!);
    await act(() => press("Enter"));
    await act(() => press(" "));
    expect(handlers.onConnect).toHaveBeenCalledTimes(2);
  });

  /** Press a key at a moment of the test's choosing, as type-ahead reads it. */
  const pressAt = (at: number, key: string) =>
    act(async () => {
      const element = document.activeElement!;
      const event = createEvent.keyDown(element, { key });
      Object.defineProperty(event, "timeStamp", { value: at });
      fireEvent(element, event);
    });

  it("jumps with type-ahead, and starts a new word after a pause", async () => {
    show();
    focus(folderRow("prod")!);
    await pressAt(1000, "l");
    expect(focusedLabel()).toBe("lookalike");
    await pressAt(1100, "o");
    expect(focusedLabel()).toBe("lookalike");
    await pressAt(1200, "z");
    expect(focusedLabel()).toBe("lookalike");
    await pressAt(1800, "w");
    expect(focusedLabel()).toBe("west, 1 connection");
  });

  describe("a space", () => {
    const NAMED = [direct("web server"), direct("web proxy"), direct("alpha")];

    it("belongs to a word being typed, and does not connect", async () => {
      show(NAMED);
      focus(noFolderRow()!);
      await pressAt(1000, "w");
      await pressAt(1100, "e");
      await pressAt(1200, "b");
      expect(focusedLabel()).toBe("web server");
      await pressAt(1300, " ");
      expect(focusedLabel()).toBe("web server");
      await pressAt(1400, "p");
      expect(focusedLabel()).toBe("web proxy");
      expect(handlers.onConnect).not.toHaveBeenCalled();
    });

    it("keeps its word through the Shift of a capital", async () => {
      show(NAMED);
      focus(noFolderRow()!);
      await pressAt(1000, "w");
      await pressAt(1100, "e");
      await pressAt(1200, "b");
      await pressAt(1300, " ");
      await pressAt(1350, "Shift");
      await pressAt(1400, "P");
      expect(focusedLabel()).toBe("web proxy");
      expect(handlers.onConnect).not.toHaveBeenCalled();
    });

    it("activates when no word is running", async () => {
      show(NAMED);
      focus(connectionRow("alpha")!);
      await pressAt(1000, " ");
      expect(handlers.onConnect).toHaveBeenCalledWith(expect.objectContaining({ id: "alpha" }));
    });

    it("activates once the word has lapsed", async () => {
      show(NAMED);
      focus(noFolderRow()!);
      await pressAt(1000, "w");
      expect(focusedLabel()).toBe("web server");
      await pressAt(1501, " ");
      expect(handlers.onConnect).toHaveBeenCalledWith(expect.objectContaining({ id: "web server" }));
    });

    it("activates after another key has ended the word", async () => {
      show(NAMED);
      focus(noFolderRow()!);
      await pressAt(1000, "w");
      await pressAt(1100, "ArrowDown");
      expect(focusedLabel()).toBe("web proxy");
      await pressAt(1200, " ");
      expect(handlers.onConnect).toHaveBeenCalledWith(expect.objectContaining({ id: "web proxy" }));
    });
  });

  it("opens each row's menu with Shift+F10 and the Menu key", async () => {
    show();
    focus(connectionRow("top")!);
    await act(() => press("F10", { shiftKey: true }));
    expect(screen.getByRole("menu", { name: "Actions for top" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });

    focus(folderRow("prod")!);
    await act(() => press("ContextMenu"));
    const menu = screen.getByRole("menu", { name: "Actions for prod" });
    expect(within(menu).getByRole("menuitem", { name: "Rename folder…" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Delete folder…" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Collapse" })).toBeInTheDocument();
  });

  describe("the folder menu", () => {
    it("does not open on an empty no-folder row, then or on a later key", async () => {
      show([direct("web", "prod")]);
      fireEvent.contextMenu(noFolderRow()!);
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();

      focus(noFolderRow()!);
      await act(() => press("F10", { shiftKey: true }));
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();

      focus(folderRow("prod")!);
      await act(() => press("x"));
      await act(() => press("ArrowDown"));
      fireEvent.keyDown(folderRow("prod")!, { key: "y" });
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("opens on a no-folder row that holds something", () => {
      show();
      fireEvent.contextMenu(noFolderRow()!);
      const menu = screen.getByRole("menu", { name: "Actions for No folder" });
      expect(within(menu).getByRole("menuitem", { name: "Collapse" })).toBeInTheDocument();
    });

    it("stays shut on ordinary keys after it has been closed", async () => {
      show();
      fireEvent.contextMenu(folderRow("prod")!);
      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
      fireEvent.keyDown(folderRow("prod/eu")!, { key: "x" });
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
  });

  it("leaves keys on a row's own buttons alone", () => {
    show();
    const button = within(connectionRow("top")!).getByRole("button", { name: "Edit top" });
    focus(button);
    fireEvent.keyDown(button, { key: "ArrowLeft" });
    fireEvent.keyDown(button, { key: "a" });
    expect(document.activeElement).toBe(button);
  });

  it("moves a connection from the keyboard: menu, picker, Enter", async () => {
    const user = userEvent.setup();
    invokeMock.mockResolvedValueOnce({ ...direct("loose"), folder: "prod/eu" });
    show();
    focus(connectionRow("loose")!);
    await user.keyboard("{Shift>}{F10}{/Shift}");
    const menu = screen.getByRole("menu", { name: "Actions for loose" });
    await act(async () => {
      within(menu).getByRole("menuitem", { name: "Move to folder…" }).click();
    });

    const input = await screen.findByTestId("folder-move-input");
    expect(input).toHaveFocus();
    await user.type(input, "prod/eu{Enter}");
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("move_connection_to_folder", {
        id: "loose",
        folder: "prod/eu",
      }),
    );
    await waitFor(() => expect(screen.queryByTestId("folder-move-dialog")).not.toBeInTheDocument());
    expect(connectionRow("loose")).toHaveAttribute("aria-level", "3");
  });
});

describe("search", () => {
  it("opens collapsed folders that hold a match and hides everything else", async () => {
    const user = userEvent.setup();
    const { unmount } = show();
    await user.click(folderRow("prod")!);
    expect(connectionRow("west")).toBeNull();
    unmount();

    render(<Harness query="west" />);
    expect(treeItemNames()).toEqual([
      "prod, 1 connection",
      "eu, 1 connection",
      "west, 1 connection",
      "west",
    ]);
    expect(noFolderRow()).toBeNull();
  });

  it("counts the matches, not the whole folder", () => {
    show(CONNECTIONS, "eu-one");
    expect(within(folderRow("prod")!).getByTestId("folder-count")).toHaveTextContent("1");
  });

  it("matches a folder's path, and tags", () => {
    const { unmount } = show(CONNECTIONS, "production");
    expect(treeItemNames()).toEqual(["production, 1 connection", "lookalike"]);
    unmount();
    render(<Harness query="blue" />);
    expect(connectionRow("top")).not.toBeNull();
    expect(connectionRow("west")).toBeNull();
  });

  it("shows no match without saying there are no connections", () => {
    show(CONNECTIONS, "zzz");
    expect(screen.queryByRole("tree")).not.toBeInTheDocument();
    expect(screen.getByText("No matching connections")).toBeInTheDocument();
  });

  it("gives back the remembered state when it is cleared, and folds only for itself", async () => {
    const user = userEvent.setup();
    localStorage.setItem("ssix.folders.collapsed", '["production"]');
    show(CONNECTIONS, "e");
    expect(connectionRow("lookalike")).not.toBeNull();

    // Folding during the search is not remembered...
    await user.click(folderRow("prod")!);
    expect(connectionRow("top")).toBeNull();
    expect(localStorage.getItem("ssix.folders.collapsed")).toBe('["production"]');

    // ...and a new search starts open again.
    await user.type(screen.getByLabelText("search"), "u");
    expect(connectionRow("eu-one")).not.toBeNull();

    await user.clear(screen.getByLabelText("search"));
    expect(connectionRow("lookalike")).toBeNull();
    expect(connectionRow("top")).not.toBeNull();
  });
});

describe("dragging", () => {
  withPointerCoordinates();

  const dragOnto = (from: HTMLElement, over: Element | null) => {
    fireEvent.pointerDown(from, { button: 0, clientX: 0, clientY: 0 });
    document.elementFromPoint = vi.fn(() => over);
    fireEvent.pointerMove(window, { clientX: 50, clientY: 50 });
  };
  const drop = () => fireEvent.pointerUp(window, { clientX: 50, clientY: 50 });

  it("moves a row onto a folder and shows it there", async () => {
    invokeMock.mockResolvedValueOnce({ ...direct("loose"), folder: "production" });
    show();
    dragOnto(connectionRow("loose")!, folderRow("production"));
    expect(screen.getByTestId("folder-drag-chip")).toHaveTextContent("loose");
    expect(folderRow("production")).toHaveAttribute("data-drop-target", "true");
    drop();
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("move_connection_to_folder", {
        id: "loose",
        folder: "production",
      }),
    );
    await waitFor(() => expect(connectionRow("loose")).toHaveAttribute("aria-level", "2"));
    expect(screen.queryByTestId("folder-drag-chip")).not.toBeInTheDocument();
  });

  it("clears the folder when dropped on the no-folder section", async () => {
    invokeMock.mockResolvedValueOnce(direct("top"));
    show();
    dragOnto(connectionRow("top")!, noFolderRow());
    drop();
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("move_connection_to_folder", {
        id: "top",
        folder: null,
      }),
    );
  });

  it("treats another row as its folder", async () => {
    invokeMock.mockResolvedValueOnce({ ...direct("loose"), folder: "prod/eu" });
    show();
    dragOnto(connectionRow("loose")!, connectionRow("eu-one"));
    expect(folderRow("prod/eu")).toHaveAttribute("data-drop-target", "true");
    drop();
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("move_connection_to_folder", {
        id: "loose",
        folder: "prod/eu",
      }),
    );
  });

  it("opens the folder a row was dropped on, so the row stays in sight", async () => {
    localStorage.setItem("ssix.folders.collapsed", '["production"]');
    invokeMock.mockResolvedValueOnce({ ...direct("loose"), folder: "production" });
    show();
    dragOnto(connectionRow("loose")!, folderRow("production"));
    drop();
    await waitFor(() => expect(connectionRow("loose")).toHaveAttribute("aria-level", "2"));
    expect(localStorage.getItem("ssix.folders.collapsed")).toBe("[]");
  });

  it("does nothing when dropped back in its own folder", async () => {
    show();
    dragOnto(connectionRow("top")!, folderRow("prod"));
    drop();
    await act(async () => {});
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("does nothing when dropped outside the tree", async () => {
    show();
    dragOnto(connectionRow("top")!, document.body);
    expect(screen.getByTestId("folder-drag-chip")).toBeInTheDocument();
    drop();
    await act(async () => {});
    expect(invokeMock).not.toHaveBeenCalled();
  });

  const cancelWithEscape = () => fireEvent.keyDown(document.body, { key: "Escape" });
  const nextTask = () => act(() => new Promise<void>((resolve) => setTimeout(resolve)));

  it("cancels with Escape, and neither the release nor its click does anything", async () => {
    show();
    const row = connectionRow("top")!;
    dragOnto(row, noFolderRow());
    cancelWithEscape();
    expect(screen.queryByTestId("folder-drag-chip")).not.toBeInTheDocument();
    await nextTask();
    drop();
    fireEvent.click(row);
    await act(async () => {});
    expect(invokeMock).not.toHaveBeenCalled();
    expect(handlers.onConnect).not.toHaveBeenCalled();
  });

  it("still takes a later click after a cancelled drag", async () => {
    show();
    const row = connectionRow("top")!;
    dragOnto(row, row);
    cancelWithEscape();
    drop();
    await nextTask();
    fireEvent.click(row);
    expect(handlers.onConnect).toHaveBeenCalledTimes(1);
  });

  it("leaves nothing waiting for a release a pointercancel took away", () => {
    show();
    const row = connectionRow("top")!;
    dragOnto(row, row);
    cancelWithEscape();
    fireEvent.pointerCancel(window);

    fireEvent.pointerUp(window, { clientX: 0, clientY: 0 });
    fireEvent.click(row);
    expect(handlers.onConnect).toHaveBeenCalledTimes(1);
  });

  it("takes the click of a new press when the release never came", () => {
    show();
    const row = connectionRow("top")!;
    dragOnto(row, row);
    cancelWithEscape();

    fireEvent.pointerDown(row, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerUp(window, { clientX: 0, clientY: 0 });
    fireEvent.click(row);
    expect(handlers.onConnect).toHaveBeenCalledTimes(1);
  });

  describe("selecting text", () => {
    /** Whether a selection may start: `fireEvent` says if nobody prevented it. */
    const canSelect = () =>
      fireEvent(document.body, new Event("selectstart", { bubbles: true, cancelable: true }));

    it("waits for the release of a press that never moved", () => {
      show();
      expect(canSelect()).toBe(true);
      fireEvent.pointerDown(connectionRow("top")!, { button: 0, clientX: 0, clientY: 0 });
      expect(canSelect()).toBe(false);
      fireEvent.pointerUp(window, { clientX: 0, clientY: 0 });
      expect(canSelect()).toBe(true);
    });

    it("waits for the end of a drag", () => {
      show();
      dragOnto(connectionRow("top")!, connectionRow("top"));
      expect(canSelect()).toBe(false);
      drop();
      expect(canSelect()).toBe(true);
    });

    it("waits for the release after Escape, with the button still down", () => {
      show();
      dragOnto(connectionRow("top")!, connectionRow("top"));
      cancelWithEscape();
      expect(canSelect()).toBe(false);
      drop();
      expect(canSelect()).toBe(true);
    });

    it("comes back when a pointercancel takes the release away", () => {
      show();
      dragOnto(connectionRow("top")!, connectionRow("top"));
      fireEvent.pointerCancel(window);
      expect(canSelect()).toBe(true);

      dragOnto(connectionRow("top")!, connectionRow("top"));
      cancelWithEscape();
      fireEvent.pointerCancel(window);
      expect(canSelect()).toBe(true);
    });

    it("does not pile up when a new press replaces a release that never came", () => {
      show();
      dragOnto(connectionRow("top")!, connectionRow("top"));
      cancelWithEscape();
      fireEvent.pointerDown(connectionRow("top")!, { button: 0, clientX: 0, clientY: 0 });
      fireEvent.pointerUp(window, { clientX: 0, clientY: 0 });
      expect(canSelect()).toBe(true);
    });

    it("leaves a press that is not the start of a drag alone", () => {
      show();
      fireEvent.pointerDown(connectionRow("top")!, { button: 2, clientX: 0, clientY: 0 });
      expect(canSelect()).toBe(true);
    });
  });

  describe("with the side panel open", () => {
    const onOpenChange = vi.fn();

    beforeEach(() => {
      onOpenChange.mockReset();
      act(() => {
        useConnectionsStore.setState({ connections: CONNECTIONS, error: null, isLoading: false });
      });
      renderInPanel(
        <>
          <Harness />
          <Dialog open onOpenChange={onOpenChange}>
            <DialogContent>
              <DialogTitle>Beside the tree</DialogTitle>
              <DialogDescription>A form with unsaved changes, perhaps.</DialogDescription>
            </DialogContent>
          </Dialog>
        </>,
      );
    });

    it("keeps Escape from the panel while it cancels a drag", () => {
      dragOnto(connectionRow("top")!, noFolderRow());
      cancelWithEscape();
      expect(screen.queryByTestId("folder-drag-chip")).not.toBeInTheDocument();
      expect(onOpenChange).not.toHaveBeenCalled();
      drop();

      cancelWithEscape();
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it("leaves Escape to the panel for a press that has not moved", () => {
      fireEvent.pointerDown(connectionRow("top")!, { button: 0, clientX: 0, clientY: 0 });
      cancelWithEscape();
      expect(onOpenChange).toHaveBeenCalledWith(false);
      fireEvent.pointerUp(window, { clientX: 0, clientY: 0 });
    });
  });

  it("does not connect when the release lands back on the row", () => {
    show();
    const row = connectionRow("top")!;
    dragOnto(row, row);
    drop();
    fireEvent.click(row);
    expect(handlers.onConnect).not.toHaveBeenCalled();
  });

  it("still connects on a later click, and on a press that never moved", async () => {
    show();
    const row = connectionRow("top")!;
    dragOnto(row, row);
    drop();
    await new Promise((resolve) => setTimeout(resolve, 1));
    fireEvent.click(row);
    expect(handlers.onConnect).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(row, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerUp(window, { clientX: 1, clientY: 1 });
    fireEvent.click(row);
    expect(handlers.onConnect).toHaveBeenCalledTimes(2);
  });

  it("does not start from a row's own buttons", () => {
    show();
    const button = within(connectionRow("top")!).getByRole("button", { name: "Edit top" });
    dragOnto(button, noFolderRow());
    expect(screen.queryByTestId("folder-drag-chip")).not.toBeInTheDocument();
    drop();
  });

  describe("while a change is on its way", () => {
    /** Hold back the next backend answer until the test gives it. */
    function holdAnswer() {
      let give: (answer: unknown) => void = () => {};
      invokeMock.mockReturnValueOnce(new Promise((resolve) => (give = resolve)) as never);
      return (answer: unknown) => act(async () => give(answer));
    }
    const foldWithKeyboard = (path: string) =>
      fireEvent.keyDown(folderRow(path)!, { key: "Enter" });

    it("keeps a folder folded during the drag and during the call", async () => {
      const setItem = vi.spyOn(Storage.prototype, "setItem");
      const answer = holdAnswer();
      show();
      dragOnto(connectionRow("loose")!, folderRow("production"));
      foldWithKeyboard("prod/eu/west");
      expect(setItem).toHaveBeenCalledTimes(1);
      drop();
      foldWithKeyboard("prod/eu");
      expect(setItem).toHaveBeenCalledTimes(2);

      await answer({ ...direct("loose"), folder: "production" });
      expect(setItem).toHaveBeenCalledTimes(3);
      expect(folderRow("prod/eu")).toHaveAttribute("aria-expanded", "false");
      expect(loadCollapsedFolders()).toEqual(new Set(["prod/eu/west", "prod/eu"]));
      setItem.mockRestore();
    });

    it("keeps a folder folded during a rename", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      show();
      await user.click(within(folderRow("production")!).getByTestId("folder-rename"));
      const input = await screen.findByTestId("folder-rename-input");
      await user.clear(input);
      await user.type(input, "live");
      const answer = holdAnswer();
      await user.keyboard("{Enter}");
      foldWithKeyboard("prod/eu");

      await answer(CONNECTIONS.map((c) => (c.folder === "production" ? { ...c, folder: "live" } : c)));
      await waitFor(() => expect(folderRow("live")).not.toBeNull());
      expect(folderRow("prod/eu")).toHaveAttribute("aria-expanded", "false");
      expect(loadCollapsedFolders()).toEqual(new Set(["prod/eu"]));
    });

    it("keeps a folder folded during a delete", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      show();
      await user.click(within(folderRow("production")!).getByTestId("folder-delete"));
      await screen.findByTestId("folder-delete-dialog");
      const answer = holdAnswer();
      await user.click(screen.getByTestId("folder-delete-dialog-confirm"));
      foldWithKeyboard("prod/eu");

      await answer(CONNECTIONS.map((c) => (c.folder === "production" ? { ...c, folder: undefined } : c)));
      await waitFor(() => expect(folderRow("production")).toBeNull());
      expect(folderRow("prod/eu")).toHaveAttribute("aria-expanded", "false");
      expect(loadCollapsedFolders()).toEqual(new Set(["prod/eu"]));
    });
  });

  describe("a refused move's message", () => {
    const refuseADrag = async () => {
      invokeMock.mockRejectedValueOnce("refused");
      dragOnto(connectionRow("loose")!, folderRow("production"));
      drop();
      await screen.findByTestId("folder-move-error");
      await nextTask();
    };
    const messageGoes = () =>
      waitFor(() => expect(screen.queryByTestId("folder-move-error")).not.toBeInTheDocument());

    it("goes with a later drag that works", async () => {
      show();
      await refuseADrag();
      invokeMock.mockResolvedValueOnce({ ...direct("loose"), folder: "production" });
      dragOnto(connectionRow("loose")!, folderRow("production"));
      drop();
      await messageGoes();
    });

    it("goes with a later move from the menu", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      show();
      await refuseADrag();
      invokeMock.mockResolvedValueOnce({ ...direct("loose"), folder: "production" });
      fireEvent.contextMenu(connectionRow("loose")!);
      await act(async () => {
        screen.getByRole("menuitem", { name: "Move to folder…" }).click();
      });
      await user.type(await screen.findByTestId("folder-move-input"), "production{Enter}");
      await messageGoes();
    });

    it("goes with a later rename", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      show();
      await refuseADrag();
      invokeMock.mockResolvedValueOnce(CONNECTIONS);
      await user.click(within(folderRow("prod")!).getByTestId("folder-rename"));
      const input = await screen.findByTestId("folder-rename-input");
      await user.clear(input);
      await user.type(input, "live{Enter}");
      await messageGoes();
    });

    it("goes with a later delete", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      show();
      await refuseADrag();
      invokeMock.mockResolvedValueOnce(CONNECTIONS);
      await user.click(within(folderRow("prod")!).getByTestId("folder-delete"));
      await user.click(await screen.findByTestId("folder-delete-dialog-confirm"));
      await messageGoes();
    });
  });

  it("says so when the move is refused", async () => {
    invokeMock.mockRejectedValueOnce("Connection not found");
    show();
    dragOnto(connectionRow("loose")!, folderRow("production"));
    drop();
    const banner = await screen.findByTestId("folder-move-error");
    expect(banner).toHaveTextContent("Could not move loose: Connection not found");
    expect(connectionRow("loose")).toHaveAttribute("aria-level", "2");
  });
});

describe("rename", () => {
  const open = async (user: ReturnType<typeof userEvent.setup>, path: string) => {
    await user.click(within(folderRow(path)!).getByRole("button", { name: `Rename folder ${path}` }));
    return screen.findByTestId("folder-rename-input");
  };

  it("does not fold the folder when its button is pressed", async () => {
    const user = userEvent.setup();
    show();
    await open(user, "prod");
    expect(folderRow("prod")).toHaveAttribute("aria-expanded", "true");
  });

  it("makes one backend call and takes the whole answer", async () => {
    const user = userEvent.setup();
    const renamed = [
      direct("top", "staging"),
      direct("eu-one", "staging/eu"),
      direct("west", "staging/eu/west"),
      direct("lookalike", "production"),
      direct("loose"),
    ];
    invokeMock.mockResolvedValueOnce(renamed);
    show();
    const input = await open(user, "prod");
    expect(input).toHaveValue("prod");
    await user.clear(input);
    await user.type(input, " staging/ {Enter}");

    await waitFor(() => expect(folderRow("staging")).not.toBeNull());
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("rename_folder", { from: "prod", to: "staging" });
    expect(folderRow("prod")).toBeNull();
    expect(screen.queryByTestId("folder-rename-dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(folderRow("staging")).toHaveFocus());
  });

  it("keeps a renamed folder collapsed", async () => {
    const user = userEvent.setup();
    localStorage.setItem("ssix.folders.collapsed", '["production"]');
    invokeMock.mockResolvedValueOnce([direct("lookalike", "live")]);
    show([direct("lookalike", "production")]);
    const input = await open(user, "production");
    await user.clear(input);
    await user.type(input, "live{Enter}");
    await waitFor(() => expect(folderRow("live")).not.toBeNull());
    expect(folderRow("live")).toHaveAttribute("aria-expanded", "false");
  });

  it("opens what the folder moved into, and focuses it there", async () => {
    const user = userEvent.setup();
    localStorage.setItem("ssix.folders.collapsed", '["archive"]');
    invokeMock.mockResolvedValueOnce([direct("kept", "archive"), direct("mover", "archive/old")]);
    show([direct("kept", "archive"), direct("mover", "old")]);
    const input = await open(user, "old");
    await user.clear(input);
    await user.type(input, "archive/old{Enter}");

    await waitFor(() => expect(folderRow("archive/old")).toHaveFocus());
    expect(folderRow("archive")).toHaveAttribute("aria-expanded", "true");
    expect(connectionRow("mover")).not.toBeNull();
    expect(loadCollapsedFolders()).toEqual(new Set());
  });

  it("opens the folder it merges into", async () => {
    const user = userEvent.setup();
    localStorage.setItem("ssix.folders.collapsed", '["into"]');
    invokeMock.mockResolvedValueOnce([direct("here", "into"), direct("mover", "into")]);
    show([direct("here", "into"), direct("mover", "old")]);
    const input = await open(user, "old");
    await user.clear(input);
    await user.type(input, "into{Enter}");

    await waitFor(() => expect(folderRow("into")).toHaveFocus());
    expect(connectionRow("mover")).not.toBeNull();
  });

  it("shows why a path is refused, inline, without calling the backend", async () => {
    const user = userEvent.setup();
    show();
    const input = await open(user, "prod");
    await user.clear(input);
    await user.type(input, "prod/eu{Enter}");
    expect(await screen.findByTestId("folder-rename-error")).toHaveTextContent(
      "A folder cannot move inside itself",
    );
    await user.clear(input);
    await user.type(input, "a/../b{Enter}");
    expect(await screen.findByTestId("folder-rename-error")).toHaveTextContent(
      "A folder cannot be named . or ..",
    );
    await user.clear(input);
    await user.keyboard("{Enter}");
    expect(await screen.findByTestId("folder-rename-error")).toHaveTextContent(
      "A folder path is required",
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("stays open with the backend's reason when it refuses", async () => {
    const user = userEvent.setup();
    invokeMock.mockRejectedValueOnce("Folders can nest at most 10 levels: west would end up in x");
    show();
    const input = await open(user, "prod");
    await user.clear(input);
    await user.type(input, "x{Enter}");
    expect(await screen.findByTestId("folder-rename-error")).toHaveTextContent("west would end up");
    expect(folderRow("prod")).not.toBeNull();
  });

  it("warns that an existing folder would merge", async () => {
    const user = userEvent.setup();
    show();
    const input = await open(user, "production");
    expect(screen.getByTestId("folder-rename-preview")).toBeEmptyDOMElement();
    await user.clear(input);
    await user.type(input, "prod/eu");
    expect(screen.getByTestId("folder-rename-preview")).toHaveTextContent(
      "prod/eu already exists: the two folders merge.",
    );
  });

  it("does nothing for an unchanged path", async () => {
    const user = userEvent.setup();
    show();
    const input = await open(user, "prod");
    await user.type(input, "{Enter}");
    await waitFor(() =>
      expect(screen.queryByTestId("folder-rename-dialog")).not.toBeInTheDocument(),
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("delete", () => {
  const open = async (user: ReturnType<typeof userEvent.setup>, path: string) => {
    await user.click(within(folderRow(path)!).getByRole("button", { name: `Delete folder ${path}` }));
    return screen.findByTestId("folder-delete-dialog");
  };

  it("goes through the confirm dialog, with the real count and destination", async () => {
    const user = userEvent.setup();
    invokeMock.mockResolvedValueOnce([
      direct("top", "prod"),
      direct("eu-one", "prod"),
      direct("west", "prod"),
      direct("lookalike", "production"),
      direct("loose"),
    ]);
    show();
    const dialog = await open(user, "prod/eu");
    expect(within(dialog).getByTestId("folder-delete-contents")).toHaveTextContent("2 connections");
    expect(dialog).toHaveTextContent("to prod.");
    expect(dialog).toHaveTextContent("No connection is deleted.");
    expect(invokeMock).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("folder-delete-dialog-confirm"));
    await waitFor(() => expect(folderRow("prod/eu")).toBeNull());
    expect(invokeMock).toHaveBeenCalledWith("delete_folder", { path: "prod/eu" });
    expect(connectionRow("west")).not.toBeNull();
    await waitFor(() => expect(folderRow("prod")).toHaveFocus());
  });

  it("opens a closed No folder when what moved lands there, and focuses it", async () => {
    const user = userEvent.setup();
    localStorage.setItem("ssix.folders.collapsed", '[""]');
    invokeMock.mockResolvedValueOnce([direct("web"), direct("loose")]);
    show([direct("web", "prod"), direct("loose")]);
    await open(user, "prod");
    await user.click(screen.getByTestId("folder-delete-dialog-confirm"));

    await waitFor(() => expect(noFolderRow()).toHaveFocus());
    expect(noFolderRow()).toHaveAttribute("aria-expanded", "true");
    expect(connectionRow("web")).not.toBeNull();
    expect(loadCollapsedFolders()).toEqual(new Set());
  });

  it("names a forward it would also move, and says when nothing keeps a folder", async () => {
    const user = userEvent.setup();
    show([direct("web", "prod"), forward("tunnel", "prod")]);
    const dialog = await open(user, "prod");
    expect(within(dialog).getByTestId("folder-delete-contents")).toHaveTextContent(
      "1 connection and 1 port forward",
    );
    expect(dialog).toHaveTextContent("out of any folder.");
  });

  it("counts the whole folder during a search that shows only part of it", async () => {
    const user = userEvent.setup();
    show(CONNECTIONS, "west");
    const dialog = await open(user, "prod");
    expect(within(dialog).getByTestId("folder-delete-contents")).toHaveTextContent("3 connections");
  });

  it("stays open with the reason when it fails", async () => {
    const user = userEvent.setup();
    invokeMock.mockRejectedValueOnce("The folder prod no longer exists");
    show();
    await open(user, "prod");
    await user.click(screen.getByTestId("folder-delete-dialog-confirm"));
    expect(await screen.findByTestId("folder-delete-dialog-error")).toHaveTextContent(
      "The folder prod no longer exists",
    );
    expect(connectionRow("top")).not.toBeNull();
  });

  it("can be cancelled", async () => {
    const user = userEvent.setup();
    show();
    await open(user, "prod");
    await user.click(screen.getByTestId("folder-delete-dialog-cancel"));
    expect(screen.queryByTestId("folder-delete-dialog")).not.toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
