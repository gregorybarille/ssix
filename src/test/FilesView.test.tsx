import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { FilesView } from "@/components/views/FilesView";
import { invoke } from "@/lib/tauri";
import { useConnectionsStore } from "@/store/useConnectionsStore";
import { useSftpStore } from "@/store/useSftpStore";
import type { Connection, FileEntry, FileListing, PaneTarget } from "@/types";
import { renderInPanel } from "./panel";
import { withPointerCoordinates } from "./pointerEvents";

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);

const dropListeners: ((event: { payload: unknown }) => void)[] = [];
const unlisten = vi.fn();
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: async (listener: (event: { payload: unknown }) => void) => {
      dropListeners.push(listener);
      return unlisten;
    },
  }),
}));

const connections: Connection[] = [
  { id: "c1", name: "web", host: "web", port: 22, type: "direct", credential_id: "k" },
  {
    id: "f1",
    name: "tunnel",
    host: "",
    port: 22,
    type: "port_forward",
    gateway_host: "gw",
    gateway_port: 22,
    gateway_credential_id: "k",
    local_port: 8080,
    destination_host: "x",
    destination_port: 80,
  },
];

const entry = (dir: string, name: string, patch: Partial<FileEntry> = {}): FileEntry => ({
  name,
  path: `${dir}/${name}`,
  kind: "file",
  target_is_dir: false,
  size: 2048,
  modified: 100,
  mode: 0o644,
  ...patch,
});

const LOCAL: FileEntry[] = [
  entry("/work", "docs", { kind: "dir", size: null, mode: 0o755 }),
  entry("/work", "a.txt"),
  entry("/work", "b.txt"),
  entry("/work", "link", { kind: "symlink", mode: 0o777 }),
];
const REMOTE: FileEntry[] = [
  entry("/home/me", "site", { kind: "dir", size: null, mode: 0o755 }),
  entry("/home/me", "conf.txt"),
];

const listing = (path: string, entries: FileEntry[]): FileListing => ({
  path,
  parent: path === "/" ? null : "/",
  entries,
  omitted: 0,
  truncated: false,
});

const calls = (command: string) =>
  invokeMock.mock.calls.filter(([name]) => name === command).map(([, args]) => args as never);

function answer(overrides: Record<string, (args: Record<string, unknown>) => unknown> = {}) {
  invokeMock.mockImplementation(async (command: string, args?: unknown) => {
    const input = (args ?? {}) as Record<string, unknown>;
    if (overrides[command]) return overrides[command](input) as never;
    switch (command) {
      case "sftp_local_home":
        return "/work" as never;
      case "sftp_connect":
        return { session_id: "s1", start_path: "/home/me", label: "me@web" } as never;
      case "sftp_list":
        return ((input.target as PaneTarget).side === "remote"
          ? listing(input.path as string, input.path === "/home/me" ? REMOTE : [])
          : listing(input.path as string, input.path === "/work" ? LOCAL : [])) as never;
      case "sftp_start_transfer":
        return "t1" as never;
      default:
        return undefined as never;
    }
  });
}

const initialState = useSftpStore.getState();

/** Show the view; a `<form>` makes Radix render its native select for reading. */
async function show({ connect = true } = {}) {
  const result = renderInPanel(
    <form onSubmit={(e) => e.preventDefault()}>
      <FilesView />
    </form>,
  );
  await screen.findByTestId("files-pane-local");
  await waitFor(() =>
    expect(screen.getByTestId("files-pane-local")).toHaveAttribute("data-path", "/work"),
  );
  if (connect) {
    await act(() => useSftpStore.getState().connect("c1"));
    await waitFor(() =>
      expect(screen.getByTestId("files-pane-remote")).toHaveAttribute("data-path", "/home/me"),
    );
  }
  return result;
}

const pane = (side: "local" | "remote") => within(screen.getByTestId(`files-pane-${side}`));
const row = (side: "local" | "remote", name: string) => {
  const found = pane(side)
    .getAllByTestId("file-row")
    .find((r) => r.dataset.name === name);
  if (!found) throw new Error(`No row ${name}`);
  return found;
};

beforeEach(() => {
  invokeMock.mockReset();
  answer();
  dropListeners.length = 0;
  unlisten.mockClear();
  useSftpStore.setState(initialState, true);
  useConnectionsStore.setState({ connections });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("FilesView", () => {
  it("starts on this computer's home with no connection open", async () => {
    await show({ connect: false });
    expect(calls("sftp_list")).toEqual([{ target: { side: "local" }, path: "/work" }]);
    expect(screen.getByText("No connection open")).toBeInTheDocument();
    expect(screen.getByTestId("files-disconnect")).toBeDisabled();
  });

  it("offers every connection except forwards", async () => {
    await show({ connect: false });
    const native = screen
      .getByTestId("files-connection-select")
      .parentElement?.querySelector("select");
    const options = Array.from(native?.options ?? []).map((o) => o.value);
    expect(options).toContain("c1");
    expect(options).not.toContain("f1");
  });

  it("lists both sides with what each row is", async () => {
    await show();
    expect(screen.getByTestId("files-status")).toHaveAttribute("data-state", "connected");
    expect(screen.getByTestId("files-status")).toHaveTextContent("me@web");
    const a = row("local", "a.txt");
    expect(a).toHaveAttribute("data-kind", "file");
    expect(a).toHaveAttribute("data-mode", "644");
    expect(a).toHaveTextContent("2.0 KB");
    expect(a).toHaveTextContent("rw-r--r--");
    expect(row("remote", "site")).toHaveAttribute("data-drop-dir", "/home/me/site");
    expect(row("remote", "conf.txt")).not.toHaveAttribute("data-drop-dir");
  });

  it("shows why it could not connect, with no rows pretending otherwise", async () => {
    answer({
      sftp_connect: () => {
        throw "Authentication failed";
      },
    });
    await show({ connect: false });
    await act(() => useSftpStore.getState().connect("c1"));
    expect(screen.getByTestId("files-connect-error")).toHaveTextContent("Authentication failed");
    expect(screen.queryByTestId("files-list-remote")).not.toBeInTheDocument();

    answer();
    fireEvent.click(screen.getByTestId("files-connect-error-retry"));
    await waitFor(() =>
      expect(screen.getByTestId("files-pane-remote")).toHaveAttribute("data-path", "/home/me"),
    );
    expect(screen.queryByTestId("files-connect-error")).not.toBeInTheDocument();
  });

  it("offers to trust a changed host key and connects again", async () => {
    let refuse = true;
    answer({
      sftp_connect: () => {
        if (refuse) {
          refuse = false;
          throw "HOST_KEY_MISMATCH host=web port=22 fingerprint=SHA256:new\nThe key changed.";
        }
        return { session_id: "s1", start_path: "/home/me", label: "me@web" };
      },
    });
    await show({ connect: false });
    await act(() => useSftpStore.getState().connect("c1"));
    const error = screen.getByTestId("files-connect-error");
    expect(error).toHaveTextContent("Host key for web:22 has changed");
    expect(error).toHaveTextContent("SHA256:new");
    fireEvent.click(screen.getByTestId("files-trust-host-key"));
    await waitFor(() =>
      expect(screen.getByTestId("files-status")).toHaveAttribute("data-state", "connected"),
    );
    expect(calls("ssh_forget_host_key")).toEqual([{ host: "web", port: 22 }]);
    expect(screen.queryByTestId("files-connect-error")).not.toBeInTheDocument();
  });

  it("disconnects from the header", async () => {
    await show();
    fireEvent.click(screen.getByTestId("files-disconnect"));
    expect(calls("sftp_disconnect")).toEqual([{ sessionId: "s1" }]);
    expect(screen.getByText("No connection open")).toBeInTheDocument();
  });
});

describe("rows", () => {
  it("selects with click, ctrl-click and shift-click", async () => {
    await show();
    fireEvent.click(row("local", "docs"));
    expect(row("local", "docs")).toHaveAttribute("aria-current", "true");
    fireEvent.click(row("local", "b.txt"), { ctrlKey: true });
    expect(row("local", "docs")).toHaveAttribute("aria-current", "true");
    expect(row("local", "b.txt")).toHaveAttribute("aria-current", "true");
    fireEvent.click(row("local", "docs"));
    fireEvent.click(row("local", "b.txt"), { shiftKey: true });
    expect(row("local", "a.txt")).toHaveAttribute("aria-current", "true");
    expect(screen.getByTestId("files-footer-local")).toHaveTextContent("4 items, 3 selected");
  });

  it("opens a folder on double-click and Enter, not a file", async () => {
    await show();
    fireEvent.doubleClick(row("local", "a.txt"));
    expect(calls("sftp_list")).toHaveLength(2);
    fireEvent.doubleClick(row("local", "docs"));
    await waitFor(() =>
      expect(screen.getByTestId("files-pane-local")).toHaveAttribute("data-path", "/work/docs"),
    );
    fireEvent.change(screen.getByTestId("files-path-local"), { target: { value: "/work" } });
    fireEvent.keyDown(screen.getByTestId("files-path-local"), { key: "Enter" });
    await waitFor(() => expect(row("local", "docs")).toBeInTheDocument());
    const docs = row("local", "docs");
    docs.focus();
    fireEvent.keyDown(docs, { key: "Enter" });
    await waitFor(() =>
      expect(screen.getByTestId("files-pane-local")).toHaveAttribute("data-path", "/work/docs"),
    );
  });

  it("Space picks a row without opening it", async () => {
    await show();
    const docs = row("local", "docs");
    docs.focus();
    fireEvent.keyDown(docs, { key: " " });
    expect(row("local", "docs")).toHaveAttribute("aria-current", "true");
    expect(screen.getByTestId("files-pane-local")).toHaveAttribute("data-path", "/work");
  });

  it("goes up to the parent folder", async () => {
    await show();
    fireEvent.click(screen.getByTestId("files-up-local"));
    await waitFor(() =>
      expect(screen.getByTestId("files-pane-local")).toHaveAttribute("data-path", "/"),
    );
  });

  it("shows a load failure with a retry", async () => {
    await show();
    answer({
      sftp_list: () => {
        throw "Permission denied";
      },
    });
    fireEvent.click(screen.getByTestId("files-refresh-local"));
    await waitFor(() =>
      expect(screen.getByTestId("files-error-local")).toHaveTextContent("Permission denied"),
    );
    answer();
    fireEvent.click(screen.getByTestId("files-error-local-retry"));
    await waitFor(() => expect(screen.queryByTestId("files-error-local")).not.toBeInTheDocument());
  });

  it("says when a listing is cut short or leaves names out", async () => {
    answer({
      sftp_list: () => ({ ...listing("/work", LOCAL), omitted: 2, truncated: true }),
    });
    await show({ connect: false });
    const footer = screen.getByTestId("files-footer-local");
    expect(footer).toHaveTextContent("Only the first 4 are shown");
    expect(footer).toHaveTextContent("2 with names that cannot be shown safely");
  });

  it("offers its actions in a context menu, from the keyboard too", async () => {
    await show();
    const conf = row("remote", "conf.txt");
    conf.focus();
    fireEvent.keyDown(conf, { key: "F10", shiftKey: true });
    const menu = await screen.findByRole("menu", { name: "Actions for conf.txt" });
    expect(within(menu).getByRole("menuitem", { name: "Download" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Edit" })).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete" }));
    expect(await screen.findByTestId("files-delete-confirm")).toHaveTextContent("Delete conf.txt?");
  });

  it("gives a symlink no permissions action", async () => {
    await show();
    fireEvent.click(row("local", "link"));
    expect(screen.getByTestId("files-chmod-local")).toBeDisabled();
    fireEvent.contextMenu(row("local", "link"));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Permissions" })).toBeDisabled();
  });
});

describe("changing files", () => {
  it("creates a folder, and keeps the dialog open on a refusal", async () => {
    answer({
      sftp_mkdir: () => {
        throw "Could not create it: Permission denied";
      },
    });
    await show();
    fireEvent.click(screen.getByTestId("files-mkdir-remote"));
    const input = await screen.findByTestId("files-name-input");

    fireEvent.click(screen.getByTestId("files-name-submit"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Name is required");
    expect(calls("sftp_mkdir")).toEqual([]);

    fireEvent.change(input, { target: { value: "new" } });
    fireEvent.click(screen.getByTestId("files-name-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("files-name-dialog")).toHaveTextContent("Permission denied"),
    );
    expect(calls("sftp_mkdir")).toEqual([{ target: { side: "remote", session_id: "s1" }, dir: "/home/me", name: "new" }]);

    // The button stays disabled until the refused action has finished.
    await waitFor(() => expect(screen.getByTestId("files-name-submit")).toBeEnabled());
    answer();
    fireEvent.click(screen.getByTestId("files-name-submit"));
    await waitFor(() => expect(screen.queryByTestId("files-name-dialog")).not.toBeInTheDocument());
  });

  it("renames starting from the current name", async () => {
    await show();
    fireEvent.click(row("local", "a.txt"));
    fireEvent.click(screen.getByTestId("files-rename-local"));
    const input = await screen.findByTestId("files-name-input");
    expect(input).toHaveValue("a.txt");
    fireEvent.change(input, { target: { value: "c.txt" } });
    fireEvent.click(screen.getByTestId("files-name-submit"));
    await waitFor(() =>
      expect(calls("sftp_rename")).toEqual([
        { target: { side: "local" }, path: "/work/a.txt", newName: "c.txt" },
      ]),
    );
  });

  it("refuses a mode that is not octal and previews one that is", async () => {
    await show();
    fireEvent.click(row("remote", "conf.txt"));
    fireEvent.click(screen.getByTestId("files-chmod-remote"));
    const input = await screen.findByTestId("files-chmod-input");
    expect(input).toHaveValue("644");
    expect(screen.getByTestId("files-chmod-preview")).toHaveTextContent("rw-r--r--");

    fireEvent.change(input, { target: { value: "999" } });
    fireEvent.click(screen.getByTestId("files-chmod-submit"));
    expect(await screen.findByRole("alert")).toHaveTextContent("octal");
    expect(calls("sftp_chmod")).toEqual([]);

    fireEvent.change(input, { target: { value: "600" } });
    expect(screen.getByTestId("files-chmod-preview")).toHaveTextContent("rw-------");
    fireEvent.click(screen.getByTestId("files-chmod-submit"));
    await waitFor(() =>
      expect(calls("sftp_chmod")).toEqual([
        { target: { side: "remote", session_id: "s1" }, path: "/home/me/conf.txt", mode: 0o600 },
      ]),
    );
  });

  it("deletes only after confirming, starting on Cancel", async () => {
    await show();
    fireEvent.click(row("local", "a.txt"));
    fireEvent.click(row("local", "b.txt"), { ctrlKey: true });
    fireEvent.click(screen.getByTestId("files-delete-local"));
    const dialog = await screen.findByTestId("files-delete-confirm");
    expect(dialog).toHaveTextContent("Delete 2 items?");
    expect(dialog).toHaveTextContent("Symbolic links are removed, not what they point to");
    expect(screen.getByTestId("files-delete-confirm-cancel")).toHaveFocus();
    expect(calls("sftp_delete")).toEqual([]);

    fireEvent.click(screen.getByTestId("files-delete-confirm-confirm"));
    await waitFor(() => expect(calls("sftp_delete")).toHaveLength(2));
    await waitFor(() =>
      expect(screen.queryByTestId("files-delete-confirm")).not.toBeInTheDocument(),
    );
  });

  it("keeps the confirmation open when the delete fails", async () => {
    answer({
      sftp_delete: () => {
        throw "Permission denied";
      },
    });
    await show();
    fireEvent.click(row("local", "a.txt"));
    fireEvent.click(screen.getByTestId("files-delete-local"));
    fireEvent.click(await screen.findByTestId("files-delete-confirm-confirm"));
    expect(await screen.findByTestId("files-delete-confirm-error")).toHaveTextContent(
      "Permission denied",
    );
  });

  it("closes an open dialog when the connection closes", async () => {
    await show();
    fireEvent.click(row("remote", "conf.txt"));
    fireEvent.click(screen.getByTestId("files-delete-remote"));
    await screen.findByTestId("files-delete-confirm");
    act(() => useSftpStore.getState().disconnect());
    await waitFor(() =>
      expect(screen.queryByTestId("files-delete-confirm")).not.toBeInTheDocument(),
    );
    expect(calls("sftp_delete")).toEqual([]);
  });

  it("says a lost session stopped a change, since its dialog closes", async () => {
    answer({
      sftp_delete: () => {
        throw "SFTP_SESSION_LOST\nThe connection to the server was lost.";
      },
    });
    await show();
    fireEvent.click(row("remote", "conf.txt"));
    fireEvent.click(screen.getByTestId("files-delete-remote"));
    fireEvent.click(await screen.findByTestId("files-delete-confirm-confirm"));
    expect(await screen.findByTestId("files-change-error")).toHaveTextContent(
      "That change did not finish",
    );
    expect(screen.queryByTestId("files-delete-confirm")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("files-change-error-dismiss"));
    expect(screen.queryByTestId("files-change-error")).not.toBeInTheDocument();
  });

  it("offers no change to the server's files while it has no session", async () => {
    await show();
    fireEvent.click(row("remote", "conf.txt"));
    for (const id of ["rename", "chmod", "delete"]) {
      expect(screen.getByTestId(`files-${id}-remote`)).toBeEnabled();
    }
    act(() => useSftpStore.setState({ sessionId: null }));
    for (const id of ["rename", "chmod", "delete", "mkdir"]) {
      expect(screen.getByTestId(`files-${id}-remote`)).toBeDisabled();
    }
    expect(screen.getByTestId("files-edit")).toBeDisabled();
  });

  it("disables what the selection does not allow", async () => {
    await show();
    for (const id of ["rename", "chmod", "delete", "transfer"]) {
      expect(screen.getByTestId(`files-${id}-local`)).toBeDisabled();
    }
    expect(screen.getByTestId("files-edit")).toBeDisabled();
    fireEvent.click(row("remote", "site"));
    expect(screen.getByTestId("files-edit")).toBeDisabled();
    fireEvent.click(row("remote", "conf.txt"));
    expect(screen.getByTestId("files-edit")).toBeEnabled();
    fireEvent.click(row("remote", "site"), { ctrlKey: true });
    expect(screen.getByTestId("files-edit")).toBeDisabled();
    expect(screen.getByTestId("files-rename-remote")).toBeDisabled();
    expect(screen.getByTestId("files-delete-remote")).toBeEnabled();
  });

  it("cannot copy with no connection open", async () => {
    await show({ connect: false });
    fireEvent.click(row("local", "a.txt"));
    expect(screen.getByTestId("files-transfer-local")).toBeDisabled();
  });
});

describe("transfers", () => {
  const onEvent = () => {
    const [args] = calls("sftp_start_transfer").slice(-1) as {
      onEvent: { onmessage: (e: unknown) => void };
    }[];
    return args.onEvent.onmessage;
  };

  async function uploading() {
    await show();
    fireEvent.click(row("local", "a.txt"));
    fireEvent.click(screen.getByTestId("files-transfer-local"));
    return await screen.findByTestId("files-transfer");
  }

  it("shows progress and cancels", async () => {
    const transfer = await uploading();
    expect(transfer).toHaveAttribute("data-name", "a.txt");
    expect(transfer).toHaveAttribute("data-status", "running");
    act(() =>
      onEvent()({
        type: "progress",
        id: "t1",
        bytes_done: 1024,
        bytes_total: 4096,
        files_done: 0,
        files_total: 1,
        current: "a.txt",
      }),
    );
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
    expect(screen.getByTestId("files-transfer-status")).toHaveTextContent("1.0 KB of 4.0 KB");

    fireEvent.click(screen.getByTestId("files-transfer-cancel"));
    await waitFor(() => expect(calls("sftp_cancel_transfer")).toEqual([{ id: "t1" }]));
    expect(screen.getByTestId("files-transfer-status")).toHaveTextContent("Cancelling");
    expect(screen.getByTestId("files-transfer-cancel")).toBeDisabled();

    act(() => onEvent()({ type: "cancelled", id: "t1" }));
    expect(screen.getByTestId("files-transfer")).toHaveAttribute("data-status", "cancelled");
    fireEvent.click(screen.getByTestId("files-transfer-dismiss"));
    expect(screen.queryByTestId("files-transfer")).not.toBeInTheDocument();
  });

  it("says what was left out of a finished folder", async () => {
    await uploading();
    act(() =>
      onEvent()({ type: "done", id: "t1", bytes: 2048, files: 3, skipped: 1, target: "/home/me/a" }),
    );
    expect(screen.getByTestId("files-transfer-status")).toHaveTextContent(
      "3 files, 2.0 KB, 1 skipped",
    );
    fireEvent.click(screen.getByTestId("files-transfers-clear"));
    expect(screen.queryByTestId("files-transfers")).not.toBeInTheDocument();
  });

  it("shows why one failed", async () => {
    await uploading();
    act(() => onEvent()({ type: "failed", id: "t1", error: "No space left" }));
    expect(screen.getByTestId("files-transfer-status")).toHaveTextContent("No space left");
  });

  it("asks before replacing, and starts again only on yes", async () => {
    await uploading();
    act(() =>
      onEvent()({ type: "conflict", id: "t1", target: "/home/me/a.txt", target_is_dir: false }),
    );
    const dialog = await screen.findByTestId("files-overwrite-confirm");
    expect(dialog).toHaveTextContent("Replace a.txt?");
    expect(dialog).toHaveTextContent("/home/me/a.txt already exists");
    fireEvent.click(screen.getByTestId("files-overwrite-confirm-confirm"));
    await waitFor(() => expect(calls("sftp_start_transfer")).toHaveLength(2));
    const [, second] = calls("sftp_start_transfer") as { input: { overwrite: boolean } }[];
    expect(second.input.overwrite).toBe(true);
    await waitFor(() =>
      expect(screen.queryByTestId("files-overwrite-confirm")).not.toBeInTheDocument(),
    );
  });

  it("explains that a folder is merged, and no means nothing is written", async () => {
    await uploading();
    act(() =>
      onEvent()({ type: "conflict", id: "t1", target: "/home/me/a", target_is_dir: true }),
    );
    const dialog = await screen.findByTestId("files-overwrite-confirm");
    expect(dialog).toHaveTextContent("Files with the same name are replaced; the others stay");
    fireEvent.click(screen.getByTestId("files-overwrite-confirm-cancel"));
    await waitFor(() => expect(screen.queryByTestId("files-transfer")).not.toBeInTheDocument());
    expect(calls("sftp_start_transfer")).toHaveLength(1);
  });

  it("asks about one conflict at a time", async () => {
    await show();
    let id = 0;
    answer({ sftp_start_transfer: () => `t${++id}` });
    fireEvent.click(row("local", "a.txt"));
    fireEvent.click(row("local", "b.txt"), { ctrlKey: true });
    fireEvent.click(screen.getByTestId("files-transfer-local"));
    await waitFor(() => expect(calls("sftp_start_transfer")).toHaveLength(2));
    const channels = calls("sftp_start_transfer") as {
      input: { source: string };
      onEvent: { onmessage: (e: unknown) => void };
    }[];
    act(() => {
      channels[0].onEvent.onmessage({
        type: "conflict",
        id: "t1",
        target: "/home/me/a.txt",
        target_is_dir: false,
      });
      channels[1].onEvent.onmessage({
        type: "conflict",
        id: "t2",
        target: "/home/me/b.txt",
        target_is_dir: false,
      });
    });
    expect(await screen.findByTestId("files-overwrite-confirm")).toHaveTextContent("a.txt");
    fireEvent.click(screen.getByTestId("files-overwrite-confirm-cancel"));
    await waitFor(() =>
      expect(screen.getByTestId("files-overwrite-confirm")).toHaveTextContent("b.txt"),
    );
  });
});

describe("dragging", () => {
  /** What the pointer is over, as `elementFromPoint` would report it. */
  function pointerOver(element: Element | null) {
    document.elementFromPoint = vi.fn(() => element);
  }

  const drag = (from: HTMLElement, over: Element | null, point = { x: 50, y: 50 }) => {
    fireEvent.pointerDown(from, { button: 0, clientX: 0, clientY: 0 });
    pointerOver(over);
    fireEvent.pointerMove(window, { clientX: point.x, clientY: point.y });
  };

  withPointerCoordinates();

  const lastInput = () => {
    const [args] = calls("sftp_start_transfer").slice(-1) as {
      input: { source: string; target_dir: string; direction: string };
    }[];
    return args?.input;
  };

  it("uploads into the folder the other pane shows", async () => {
    await show();
    drag(row("local", "a.txt"), screen.getByTestId("files-list-remote"));
    expect(screen.getByTestId("files-drag-chip")).toHaveTextContent("a.txt");
    fireEvent.pointerUp(window, { clientX: 50, clientY: 50 });
    await waitFor(() =>
      expect(lastInput()).toMatchObject({
        direction: "upload",
        source: "/work/a.txt",
        target_dir: "/home/me",
      }),
    );
    expect(screen.queryByTestId("files-drag-chip")).not.toBeInTheDocument();
  });

  it("drops onto a folder row, and takes the selection along", async () => {
    await show();
    fireEvent.click(row("local", "a.txt"));
    fireEvent.click(row("local", "b.txt"), { ctrlKey: true });
    drag(row("local", "a.txt"), row("remote", "site"));
    expect(screen.getByTestId("files-drag-chip")).toHaveTextContent("2 items");
    fireEvent.pointerUp(window, { clientX: 50, clientY: 50 });
    await waitFor(() => expect(calls("sftp_start_transfer")).toHaveLength(2));
    expect(lastInput().target_dir).toBe("/home/me/site");
  });

  it("downloads the other way", async () => {
    await show();
    drag(row("remote", "conf.txt"), screen.getByTestId("files-list-local"));
    fireEvent.pointerUp(window, { clientX: 50, clientY: 50 });
    await waitFor(() =>
      expect(lastInput()).toMatchObject({
        direction: "download",
        source: "/home/me/conf.txt",
        target_dir: "/work",
      }),
    );
  });

  it("does nothing dropped on its own pane, after Escape, or for a small move", async () => {
    await show();
    drag(row("local", "a.txt"), screen.getByTestId("files-list-local"));
    fireEvent.pointerUp(window, { clientX: 50, clientY: 50 });

    drag(row("local", "a.txt"), screen.getByTestId("files-list-remote"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("files-drag-chip")).not.toBeInTheDocument();
    fireEvent.pointerUp(window, { clientX: 50, clientY: 50 });

    drag(row("local", "a.txt"), screen.getByTestId("files-list-remote"), { x: 2, y: 2 });
    expect(screen.queryByTestId("files-drag-chip")).not.toBeInTheDocument();
    fireEvent.pointerUp(window, { clientX: 2, clientY: 2 });

    await act(async () => {});
    expect(calls("sftp_start_transfer")).toEqual([]);
  });
});

describe("files dropped from the desktop", () => {
  const drop = (paths: string[]) =>
    act(() =>
      dropListeners[0]({ payload: { type: "drop", paths, position: { x: 100, y: 100 } } }),
    );

  it("upload when dropped on the server's pane", async () => {
    await show();
    await waitFor(() => expect(dropListeners).toHaveLength(1));
    document.elementFromPoint = vi.fn(() => screen.getByTestId("files-list-remote"));
    drop(["/desktop/x.bin"]);
    await waitFor(() => expect(calls("sftp_start_transfer")).toHaveLength(1));
    const [args] = calls("sftp_start_transfer") as {
      input: { source: string; target_dir: string; direction: string };
    }[];
    expect(args.input).toMatchObject({
      direction: "upload",
      source: "/desktop/x.bin",
      target_dir: "/home/me",
    });
  });

  it("do nothing on this computer's pane", async () => {
    await show();
    await waitFor(() => expect(dropListeners).toHaveLength(1));
    document.elementFromPoint = vi.fn(() => screen.getByTestId("files-list-local"));
    drop(["/desktop/x.bin"]);
    await act(async () => {});
    expect(calls("sftp_start_transfer")).toEqual([]);
  });

  it("stop being listened for when the view goes", async () => {
    const { unmount } = await show();
    await waitFor(() => expect(dropListeners).toHaveLength(1));
    unmount();
    expect(unlisten).toHaveBeenCalled();
  });
});

describe("editing in place", () => {
  const session = {
    edit_id: "e1",
    name: "conf.txt",
    remote_path: "/home/me/conf.txt",
    temp_path: "/cache/e1/conf.txt",
    size: 5,
  };

  async function editing(overrides = {}) {
    answer({
      sftp_edit_open: () => session,
      sftp_edit_status: () => ({ modified: true, missing: false }),
      ...overrides,
    });
    await show();
    fireEvent.click(row("remote", "conf.txt"));
    fireEvent.click(screen.getByTestId("files-edit"));
    const panel = await screen.findByTestId("files-edit-panel");
    await waitFor(() => expect(screen.getByTestId("files-edit-save")).toBeEnabled());
    return panel;
  }

  it("names the temporary copy and opens the editor once", async () => {
    const panel = await editing();
    expect(panel).toHaveAttribute("data-temp-path", "/cache/e1/conf.txt");
    expect(panel).toHaveTextContent("/cache/e1/conf.txt");
    expect(calls("sftp_edit_launch")).toEqual([{ editId: "e1" }]);
    fireEvent.click(screen.getByTestId("files-edit-open-editor"));
    await waitFor(() => expect(calls("sftp_edit_launch")).toHaveLength(2));
  });

  it("uploads nothing until asked", async () => {
    await editing();
    expect(calls("sftp_edit_save")).toEqual([]);
    expect(screen.getByTestId("files-edit-status")).toHaveTextContent("not uploaded yet");
  });

  it("shows why no editor opened, and stays usable", async () => {
    await editing({
      sftp_edit_launch: () => {
        throw "No editor found; the copy is at /cache/e1/conf.txt";
      },
    });
    expect(await screen.findByTestId("files-edit-launch-error")).toHaveTextContent(
      "/cache/e1/conf.txt",
    );
    expect(screen.getByTestId("files-edit-save")).toBeEnabled();
  });

  it("asks before overwriting a change on the server", async () => {
    await editing({
      sftp_edit_save: ({ force }: { force: boolean }) =>
        force
          ? { outcome: "saved", size: 9 }
          : { outcome: "remote_changed", deleted: false, size: 7, modified: 200 },
    });
    fireEvent.click(screen.getByTestId("files-edit-save"));
    const conflict = await screen.findByTestId("files-edit-conflict");
    expect(conflict).toHaveTextContent("changed after you opened it");
    expect(screen.getByTestId("files-edit-conflict-cancel")).toHaveFocus();

    fireEvent.click(screen.getByTestId("files-edit-conflict-cancel"));
    await waitFor(() =>
      expect(screen.queryByTestId("files-edit-conflict")).not.toBeInTheDocument(),
    );
    expect(calls("sftp_edit_save")).toEqual([{ editId: "e1", force: false }]);

    fireEvent.click(screen.getByTestId("files-edit-save"));
    fireEvent.click(await screen.findByTestId("files-edit-conflict-confirm"));
    await waitFor(() =>
      expect(calls("sftp_edit_save")).toContainEqual({ editId: "e1", force: true }),
    );
  });

  it("says when the file was deleted on the server", async () => {
    await editing({
      sftp_edit_save: () => ({ outcome: "remote_changed", deleted: true, size: null, modified: null }),
    });
    fireEvent.click(screen.getByTestId("files-edit-save"));
    expect(await screen.findByTestId("files-edit-conflict")).toHaveTextContent(
      "deleted on the server",
    );
  });

  it("asks before dropping changes that were not uploaded", async () => {
    await editing();
    fireEvent.click(screen.getByTestId("files-edit-close"));
    await screen.findByTestId("files-edit-discard");
    expect(calls("sftp_edit_close")).toEqual([]);
    fireEvent.click(screen.getByTestId("files-edit-discard-cancel"));
    await waitFor(() => expect(screen.queryByTestId("files-edit-discard")).not.toBeInTheDocument());
    expect(screen.getByTestId("files-edit-panel")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("files-edit-close"));
    fireEvent.click(await screen.findByTestId("files-edit-discard-confirm"));
    await waitFor(() => expect(calls("sftp_edit_close")).toEqual([{ editId: "e1" }]));
    await waitFor(() => expect(screen.queryByTestId("files-edit-panel")).not.toBeInTheDocument());
  });

  it("asks about a change the last poll has not seen yet", async () => {
    let modified = false;
    answer({
      sftp_edit_open: () => session,
      sftp_edit_status: () => ({ modified, missing: false }),
    });
    await show();
    fireEvent.click(row("remote", "conf.txt"));
    fireEvent.click(screen.getByTestId("files-edit"));
    const close = await screen.findByTestId("files-edit-close");
    await waitFor(() => expect(calls("sftp_edit_status").length).toBeGreaterThan(0));
    expect(screen.getByTestId("files-edit-save")).toBeDisabled();

    modified = true;
    fireEvent.click(close);
    await screen.findByTestId("files-edit-discard");
    expect(calls("sftp_edit_close")).toEqual([]);
  });

  it("closes straight away with nothing to lose", async () => {
    answer({
      sftp_edit_open: () => session,
      sftp_edit_status: () => ({ modified: false, missing: false }),
    });
    await show();
    fireEvent.click(row("remote", "conf.txt"));
    fireEvent.click(screen.getByTestId("files-edit"));
    fireEvent.click(await screen.findByTestId("files-edit-close"));
    await waitFor(() => expect(calls("sftp_edit_close")).toEqual([{ editId: "e1" }]));
    expect(screen.queryByTestId("files-edit-discard")).not.toBeInTheDocument();
  });

  it("says when the temporary copy is gone", async () => {
    answer({
      sftp_edit_open: () => session,
      sftp_edit_status: () => ({ modified: false, missing: true }),
    });
    await show();
    fireEvent.click(row("remote", "conf.txt"));
    fireEvent.click(screen.getByTestId("files-edit"));
    await waitFor(() =>
      expect(screen.getByTestId("files-edit-status")).toHaveTextContent("temporary copy is gone"),
    );
    expect(screen.getByTestId("files-edit-save")).toBeDisabled();
  });

  it("shows a copy that could not be made", async () => {
    answer({
      sftp_edit_open: () => {
        throw "The file is too large to edit here";
      },
    });
    await show();
    fireEvent.click(row("remote", "conf.txt"));
    fireEvent.click(screen.getByTestId("files-edit"));
    expect(await screen.findByTestId("files-edit-open-error")).toHaveTextContent("too large");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("files-edit-open-error")).not.toBeInTheDocument();
  });
});
