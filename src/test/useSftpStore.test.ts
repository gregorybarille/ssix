import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@/lib/tauri";
import { browseFiles, useSftpStore, type FileDialog } from "@/store/useSftpStore";
import { useViewStore } from "@/store/useViewStore";
import type { Connection, FileEntry, FileListing, TransferEvent, TransferInput } from "@/types";

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);

const file = (path: string, patch: Partial<FileEntry> = {}): FileEntry => ({
  name: path.split("/").pop() ?? path,
  path,
  kind: "file",
  target_is_dir: false,
  size: 5,
  modified: 100,
  mode: 0o644,
  ...patch,
});

const listing = (path: string, entries: FileEntry[] = []): FileListing => ({
  path,
  parent: path === "/" ? null : "/",
  entries,
  omitted: 0,
  truncated: false,
});

type Handler = (args: Record<string, unknown>) => unknown;

/** Answer backend calls by command name; an unlisted one resolves to nothing. */
function backend(handlers: Record<string, Handler> = {}) {
  invokeMock.mockImplementation(async (command: string, args?: unknown) =>
    handlers[command]?.((args ?? {}) as Record<string, unknown>),
  );
}

const calls = (command: string) =>
  invokeMock.mock.calls.filter(([name]) => name === command).map(([, args]) => args as never);

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const initialState = useSftpStore.getState();

beforeEach(() => {
  invokeMock.mockReset();
  useSftpStore.setState(initialState, true);
});

async function connected() {
  backend({
    sftp_connect: () => ({ session_id: "s1", start_path: "/home/me", label: "me@host" }),
    sftp_list: ({ path }) => listing(path as string),
  });
  await useSftpStore.getState().connect("c1");
}

describe("connecting", () => {
  it("opens a session and lists where it starts", async () => {
    await connected();
    const state = useSftpStore.getState();
    expect(state.sessionId).toBe("s1");
    expect(state.label).toBe("me@host");
    expect(state.connecting).toBe(false);
    expect(state.remote.path).toBe("/home/me");
    expect(calls("sftp_list")).toEqual([{ target: { side: "remote", session_id: "s1" }, path: "/home/me" }]);
  });

  it("reports a failure without pretending to be connected", async () => {
    backend({
      sftp_connect: () => {
        throw "Authentication failed";
      },
    });
    await useSftpStore.getState().connect("c1");
    const state = useSftpStore.getState();
    expect(state.connectError).toBe("Authentication failed");
    expect(state.sessionId).toBeNull();
    expect(state.connecting).toBe(false);
  });

  it("closes the session a superseded connect opens", async () => {
    let answerFirst: (value: unknown) => void = () => {};
    let sessions = 0;
    invokeMock.mockImplementation(async (command: string, args?: unknown) => {
      if (command === "sftp_connect") {
        sessions += 1;
        if (sessions === 1) return new Promise((resolve) => (answerFirst = resolve)) as never;
        return { session_id: "s2", start_path: "/two", label: "two" } as never;
      }
      if (command === "sftp_list") return listing((args as { path: string }).path) as never;
      return undefined as never;
    });
    const first = useSftpStore.getState().connect("c1");
    await useSftpStore.getState().connect("c2");
    answerFirst({ session_id: "s1", start_path: "/one", label: "one" });
    await first;
    const state = useSftpStore.getState();
    expect(state.connectionId).toBe("c2");
    expect(state.sessionId).toBe("s2");
    expect(state.remote.path).toBe("/two");
    expect(calls("sftp_disconnect")).toEqual([{ sessionId: "s1" }]);
  });

  it("closes the previous session when moving to another connection", async () => {
    await connected();
    await useSftpStore.getState().connect("c2");
    expect(calls("sftp_disconnect")).toEqual([{ sessionId: "s1" }]);
  });

  it("disconnecting closes the session and empties the pane", async () => {
    await connected();
    useSftpStore.getState().disconnect();
    const state = useSftpStore.getState();
    expect(calls("sftp_disconnect")).toEqual([{ sessionId: "s1" }]);
    expect(state.sessionId).toBeNull();
    expect(state.connectionId).toBeNull();
    expect(state.remote.path).toBe("");
  });

  it("forgets the host key and connects again when asked to trust it", async () => {
    await connected();
    await useSftpStore.getState().trustHostKey("h", 2222);
    expect(calls("ssh_forget_host_key")).toEqual([{ host: "h", port: 2222 }]);
    expect(calls("sftp_connect")).toHaveLength(2);
  });

  it("does not connect again if the key could not be forgotten", async () => {
    await connected();
    backend({
      ssh_forget_host_key: () => {
        throw "disk full";
      },
    });
    await useSftpStore.getState().trustHostKey("h", 22);
    expect(useSftpStore.getState().connectError).toBe("disk full");
    expect(calls("sftp_connect")).toHaveLength(1);
  });

  it("the row action opens the Files view and connects once", async () => {
    await connected();
    const connection = { id: "c1", name: "web" } as Connection;
    browseFiles(connection);
    expect(useViewStore.getState().view).toBe("files");
    expect(calls("sftp_connect")).toHaveLength(1);

    browseFiles({ id: "c2", name: "db" } as Connection);
    expect(calls("sftp_connect")).toHaveLength(2);
    await flush();
  });
});

describe("listing", () => {
  it("drops an answer about a folder the user has left", async () => {
    let answerSlow: (value: unknown) => void = () => {};
    invokeMock.mockImplementation(async (command: string, args?: unknown) => {
      const { path } = args as { path: string };
      if (command === "sftp_list" && path === "/slow") {
        return new Promise((resolve) => (answerSlow = resolve)) as never;
      }
      return listing(path) as never;
    });
    const slow = useSftpStore.getState().navigate("local", "/slow");
    await useSftpStore.getState().navigate("local", "/fast");
    answerSlow(listing("/slow"));
    await slow;
    expect(useSftpStore.getState().local.path).toBe("/fast");
    expect(useSftpStore.getState().local.loading).toBe(false);
  });

  it("uses no session for the local pane", async () => {
    backend({ sftp_list: ({ path }) => listing(path as string) });
    await useSftpStore.getState().navigate("local", "/tmp");
    expect(calls("sftp_list")).toEqual([{ target: { side: "local" }, path: "/tmp" }]);
  });

  it("does not ask the backend about a remote pane with no session", async () => {
    backend();
    await useSftpStore.getState().navigate("remote", "/x");
    expect(calls("sftp_list")).toEqual([]);
  });

  it("keeps the previous rows and shows why a load failed", async () => {
    backend({ sftp_list: ({ path }) => listing(path as string, [file("/a/f")]) });
    await useSftpStore.getState().navigate("local", "/a");
    backend({
      sftp_list: () => {
        throw "Permission denied";
      },
    });
    await useSftpStore.getState().navigate("local", "/secret");
    const { local } = useSftpStore.getState();
    expect(local.error).toBe("Permission denied");
    expect(local.path).toBe("/a");
    expect(local.entries).toHaveLength(1);
  });

  it("reconnects to the same folder when the session is lost", async () => {
    await connected();
    let lost = true;
    backend({
      sftp_connect: () => ({ session_id: "s2", start_path: "/home/me", label: "me@host" }),
      sftp_list: ({ path }) => {
        if (lost) {
          lost = false;
          throw "SFTP_SESSION_LOST The connection was lost";
        }
        return listing(path as string);
      },
    });
    await useSftpStore.getState().refresh("remote");
    await flush();
    const state = useSftpStore.getState();
    expect(state.sessionId).toBe("s2");
    expect(state.remote.path).toBe("/home/me");
    expect(state.remote.error).toBeNull();
  });

  it("stops reconnecting when the new session is lost as well, until asked again", async () => {
    await connected();
    backend({
      sftp_connect: () => ({ session_id: "s2", start_path: "/home/me", label: "me@host" }),
      sftp_list: () => {
        throw "SFTP_SESSION_LOST The connection was lost";
      },
    });
    invokeMock.mockClear();
    await useSftpStore.getState().refresh("remote");
    await flush();
    await flush();
    expect(calls("sftp_connect")).toHaveLength(1);
    expect(useSftpStore.getState().remote.error).toBe("The connection was lost");

    await useSftpStore.getState().refresh("remote");
    await flush();
    await flush();
    expect(calls("sftp_connect")).toHaveLength(2);
  });

  it("keeps the selection on a refresh, without what has gone", async () => {
    backend({ sftp_list: () => listing("/a", [file("/a/1"), file("/a/2")]) });
    await useSftpStore.getState().navigate("local", "/a");
    useSftpStore.getState().select("local", "/a/1", "replace");
    useSftpStore.getState().select("local", "/a/2", "toggle");
    backend({ sftp_list: () => listing("/a", [file("/a/2")]) });
    await useSftpStore.getState().refresh("local");
    expect(useSftpStore.getState().local.selected).toEqual(["/a/2"]);
  });

  it("clears the selection when moving to another folder", async () => {
    backend({ sftp_list: () => listing("/a", [file("/a/1")]) });
    await useSftpStore.getState().navigate("local", "/a");
    useSftpStore.getState().select("local", "/a/1", "replace");
    backend({ sftp_list: () => listing("/b", [file("/a/1")]) });
    await useSftpStore.getState().navigate("local", "/b");
    expect(useSftpStore.getState().local.selected).toEqual([]);
  });
});

describe("selecting", () => {
  beforeEach(async () => {
    backend({
      sftp_list: () => listing("/a", [file("/a/1"), file("/a/2"), file("/a/3"), file("/a/4")]),
    });
    await useSftpStore.getState().navigate("local", "/a");
  });
  const selected = () => useSftpStore.getState().local.selected;

  it("replaces, toggles and extends", () => {
    const { select } = useSftpStore.getState();
    select("local", "/a/2", "replace");
    expect(selected()).toEqual(["/a/2"]);
    select("local", "/a/4", "toggle");
    expect(selected()).toEqual(["/a/2", "/a/4"]);
    select("local", "/a/2", "toggle");
    expect(selected()).toEqual(["/a/4"]);
  });

  it("extends a range from the last row picked, in either direction", () => {
    const { select } = useSftpStore.getState();
    select("local", "/a/3", "replace");
    select("local", "/a/1", "range");
    expect(selected()).toEqual(["/a/1", "/a/2", "/a/3"]);
    select("local", "/a/4", "range");
    expect(selected()).toEqual(["/a/3", "/a/4"]);
  });

  it("treats a range with nothing to extend from as a plain pick", () => {
    useSftpStore.getState().select("local", "/a/2", "range");
    expect(selected()).toEqual(["/a/2"]);
  });
});

describe("changing files", () => {
  beforeEach(connected);

  it("refreshes the pane after a change", async () => {
    invokeMock.mockClear();
    await useSftpStore.getState().mkdir("remote", "new");
    expect(calls("sftp_mkdir")).toEqual([{ target: { side: "remote", session_id: "s1" }, dir: "/home/me", name: "new" }]);
    expect(calls("sftp_list")).toHaveLength(1);
  });

  it("passes rename and chmod through with the session of their side", async () => {
    const entry = file("/home/me/f");
    await useSftpStore.getState().rename("remote", entry, "g");
    await useSftpStore.getState().chmod("local", entry, 0o600);
    expect(calls("sftp_rename")).toEqual([{ target: { side: "remote", session_id: "s1" }, path: entry.path, newName: "g" }]);
    expect(calls("sftp_chmod")).toEqual([{ target: { side: "local" }, path: entry.path, mode: 0o600 }]);
  });

  describe("on the server's pane with no session", () => {
    const entry = file("/home/me/f");
    const refusals: [string, string, () => Promise<void>][] = [
      ["mkdir", "sftp_mkdir", () => useSftpStore.getState().mkdir("remote", "new")],
      ["rename", "sftp_rename", () => useSftpStore.getState().rename("remote", entry, "g")],
      ["chmod", "sftp_chmod", () => useSftpStore.getState().chmod("remote", entry, 0o600)],
      ["delete", "sftp_delete", () => useSftpStore.getState().remove("remote", [entry])],
    ];

    it.each(refusals)("%s fails without reaching the backend", async (_, command, change) => {
      useSftpStore.setState({ sessionId: null });
      invokeMock.mockClear();
      await expect(change()).rejects.toThrow("not connected");
      expect(calls(command)).toEqual([]);
    });

    it("the same goes while a connect is under way", async () => {
      let answer: (value: unknown) => void = () => {};
      invokeMock.mockImplementation(async (command: string) => {
        if (command === "sftp_connect") {
          return new Promise((resolve) => (answer = resolve)) as never;
        }
        return undefined as never;
      });
      const connecting = useSftpStore.getState().connect("c1", "/home/me");
      await expect(useSftpStore.getState().remove("remote", [entry])).rejects.toThrow(
        "not connected",
      );
      expect(calls("sftp_delete")).toEqual([]);
      answer({ session_id: "s2", start_path: "/home/me", label: "me@host" });
      await connecting;
    });
  });

  it("names the local side explicitly", async () => {
    await useSftpStore.getState().remove("local", [file("/work/f")]);
    expect(calls("sftp_delete")).toEqual([{ target: { side: "local" }, path: "/work/f" }]);
  });

  it("keeps one target for a whole delete, even if the session is replaced partway", async () => {
    backend({
      sftp_delete: ({ path, target }) => {
        if (path === "/home/me/a") useSftpStore.setState({ sessionId: "s2" });
        if ((target as { session_id: string }).session_id !== "s2") return;
        throw "SFTP_SESSION_LOST unexpected";
      },
      sftp_list: ({ path }) => listing(path as string),
    });
    await useSftpStore.getState().remove("remote", [file("/home/me/a"), file("/home/me/b")]);
    expect(calls("sftp_delete")).toEqual([
      { target: { side: "remote", session_id: "s1" }, path: "/home/me/a" },
      { target: { side: "remote", session_id: "s1" }, path: "/home/me/b" },
    ]);
  });

  it("hands a refusal to the dialog that asked, readably", async () => {
    backend({
      sftp_mkdir: () => {
        throw "Permission denied";
      },
    });
    useSftpStore.getState().setDialog({ kind: "mkdir", side: "remote" });
    await expect(useSftpStore.getState().mkdir("remote", "x")).rejects.toThrow("Permission denied");
    const state = useSftpStore.getState();
    expect(state.dialog).toEqual({ kind: "mkdir", side: "remote" });
    expect(state.changeError).toBeNull();
  });

  it("closes the dialog on a lost session, says the change did not finish and reconnects", async () => {
    backend({
      sftp_delete: () => {
        throw "SFTP_SESSION_LOST The connection was lost";
      },
      sftp_connect: () => ({ session_id: "s2", start_path: "/home/me", label: "me@host" }),
      sftp_list: ({ path }) => listing(path as string),
    });
    const entries = [file("/home/me/a")];
    useSftpStore.getState().setDialog({ kind: "delete", side: "remote", entries });
    await expect(useSftpStore.getState().remove("remote", entries)).rejects.toThrow(
      "The connection was lost",
    );
    await flush();
    const state = useSftpStore.getState();
    expect(state.sessionId).toBe("s2");
    expect(state.dialog).toBeNull();
    expect(state.changeError).toBe("That change did not finish. The connection was lost");

    state.dismissChangeError();
    expect(useSftpStore.getState().changeError).toBeNull();
  });

  it("stops deleting at the first failure, reports it and shows what is left", async () => {
    const deleted: unknown[] = [];
    backend({
      sftp_delete: ({ path }) => {
        if (path === "/home/me/b") throw "Permission denied";
        deleted.push(path);
      },
      sftp_list: () => listing("/home/me", [file("/home/me/b"), file("/home/me/c")]),
    });
    await expect(
      useSftpStore
        .getState()
        .remove("remote", [file("/home/me/a"), file("/home/me/b"), file("/home/me/c")]),
    ).rejects.toThrow("Permission denied");
    expect(deleted).toEqual(["/home/me/a"]);
    expect(useSftpStore.getState().remote.entries).toHaveLength(2);
  });
});

describe("dialogs and connections", () => {
  const entry = file("/home/me/f");
  const dialogs: FileDialog[] = [
    { kind: "mkdir", side: "remote" },
    { kind: "rename", side: "remote", entry },
    { kind: "chmod", side: "remote", entry },
    { kind: "delete", side: "remote", entries: [entry] },
    { kind: "delete", side: "local", entries: [entry] },
  ];

  it.each(dialogs)("disconnecting closes a $kind dialog on the $side side", async (dialog) => {
    await connected();
    useSftpStore.getState().setDialog(dialog);
    expect(useSftpStore.getState().dialog).toEqual(dialog);
    useSftpStore.getState().disconnect();
    expect(useSftpStore.getState().dialog).toBeNull();
  });

  it.each(dialogs)("moving to another connection closes a $kind dialog", async (dialog) => {
    await connected();
    useSftpStore.getState().setDialog(dialog);
    const moving = useSftpStore.getState().connect("c2");
    expect(useSftpStore.getState().dialog).toBeNull();
    await moving;
    expect(useSftpStore.getState().dialog).toBeNull();
  });

  it("a replaced session closes the dialog too, on the same connection", async () => {
    await connected();
    useSftpStore.getState().setDialog({ kind: "rename", side: "remote", entry });
    await useSftpStore.getState().connect("c1", "/home/me");
    expect(useSftpStore.getState().dialog).toBeNull();
  });

  it("opens no dialog for the server's pane without a session", () => {
    useSftpStore.getState().setDialog({ kind: "delete", side: "remote", entries: [entry] });
    expect(useSftpStore.getState().dialog).toBeNull();
    useSftpStore.getState().setDialog({ kind: "delete", side: "local", entries: [entry] });
    expect(useSftpStore.getState().dialog).not.toBeNull();
  });
});

describe("transfers", () => {
  const event = (channel: unknown, payload: TransferEvent) =>
    (channel as { onmessage: (e: TransferEvent) => void }).onmessage(payload);

  /** The channel and input of every started transfer, by call. */
  const started = () =>
    calls("sftp_start_transfer") as { input: TransferInput; onEvent: unknown }[];

  async function ready() {
    backend({
      sftp_connect: () => ({ session_id: "s1", start_path: "/home/me", label: "me@host" }),
      sftp_list: ({ path }) => listing(path as string),
      sftp_start_transfer: () => "t1",
    });
    await useSftpStore.getState().navigate("local", "/work");
    await useSftpStore.getState().connect("c1");
  }
  const row = (id = "t1") => useSftpStore.getState().transfers.find((t) => t.id === id);

  it("uploads to the folder the other pane shows", async () => {
    await ready();
    await useSftpStore.getState().transfer("local", [file("/work/a.txt")]);
    expect(started()[0].input).toEqual({
      connection_id: "c1",
      direction: "upload",
      source: "/work/a.txt",
      target_dir: "/home/me",
      overwrite: false,
    });
    expect(row()?.status).toBe("running");
    expect(row()?.name).toBe("a.txt");
  });

  it("downloads the same way, and a drop can name its own folder", async () => {
    await ready();
    await useSftpStore.getState().transfer("remote", [file("/home/me/b")], "/work/sub");
    expect(started()[0].input).toMatchObject({
      direction: "download",
      source: "/home/me/b",
      target_dir: "/work/sub",
    });
  });

  it("does nothing without a connection", async () => {
    backend();
    await useSftpStore.getState().transfer("local", [file("/work/a")]);
    expect(started()).toEqual([]);
  });

  it("starts many one at a time, in the order picked", async () => {
    await ready();
    const answers: ((id: string) => void)[] = [];
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "sftp_start_transfer") {
        return new Promise((resolve) => answers.push(resolve)) as never;
      }
      return undefined as never;
    });
    const starting = useSftpStore
      .getState()
      .transfer("local", [file("/work/a"), file("/work/b"), file("/work/c")]);
    for (let i = 0; i < 3; i += 1) {
      await flush();
      expect(started()).toHaveLength(i + 1);
      answers[i](`t${i}`);
    }
    await starting;
    expect(started().map((s) => s.input.source)).toEqual(["/work/a", "/work/b", "/work/c"]);
  });

  it("transfers ending together share a listing, and one more after it", async () => {
    await ready();
    await useSftpStore
      .getState()
      .transfer("local", [file("/work/a"), file("/work/b"), file("/work/c")]);
    const [first, second, third] = started().map((s) => s.onEvent);
    const done = (id: string) =>
      ({ type: "done", id, bytes: 1, files: 1, skipped: 0, target: "/home/me/x" }) as const;

    let answerList: (value: unknown) => void = () => {};
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "sftp_list") {
        return new Promise((resolve) => (answerList = resolve)) as never;
      }
      return undefined as never;
    });
    event(first, done("t1"));
    event(second, done("t2"));
    event(third, done("t3"));
    await flush();
    expect(calls("sftp_list")).toHaveLength(1);

    answerList(listing("/home/me"));
    await flush();
    expect(calls("sftp_list")).toHaveLength(2);
    answerList(listing("/home/me"));
    await flush();
    expect(calls("sftp_list")).toHaveLength(2);
  });

  it("follows progress and refreshes the target when it ends", async () => {
    await ready();
    await useSftpStore.getState().transfer("local", [file("/work/a")]);
    const { onEvent } = started()[0];
    event(onEvent, {
      type: "progress",
      id: "t1",
      bytes_done: 5,
      bytes_total: 10,
      files_done: 0,
      files_total: 1,
      current: "a",
    });
    expect(row()).toMatchObject({ bytesDone: 5, bytesTotal: 10, filesTotal: 1, current: "a" });

    invokeMock.mockClear();
    event(onEvent, { type: "done", id: "t1", bytes: 10, files: 1, skipped: 2, target: "/home/me/a" });
    await flush();
    expect(row()).toMatchObject({ status: "done", bytesDone: 10, skipped: 2 });
    expect(calls("sftp_list")).toEqual([{ target: { side: "remote", session_id: "s1" }, path: "/home/me" }]);
  });

  it("keeps a row whose events arrive before the start call answers", async () => {
    let answer: (id: string) => void = () => {};
    await ready();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "sftp_start_transfer") {
        return new Promise((resolve) => (answer = resolve)) as never;
      }
      return undefined as never;
    });
    const starting = useSftpStore.getState().transfer("local", [file("/work/a")]);
    await flush();
    event(started()[0].onEvent, { type: "failed", id: "t1", error: "disk full" });
    expect(row()).toMatchObject({ status: "failed", error: "disk full" });
    answer("t1");
    await starting;
    expect(useSftpStore.getState().transfers).toHaveLength(1);
    expect(row()).toMatchObject({ status: "failed", error: "disk full" });
  });

  it("shows a refused start as a failed row", async () => {
    await ready();
    backend({
      sftp_start_transfer: () => {
        throw "Connection not found";
      },
    });
    await useSftpStore.getState().transfer("local", [file("/work/a"), file("/work/b")]);
    const { transfers } = useSftpStore.getState();
    expect(transfers).toHaveLength(2);
    expect(transfers.every((t) => t.status === "failed")).toBe(true);
    expect(new Set(transfers.map((t) => t.id)).size).toBe(2);
  });

  it("asks the backend to stop and marks the row until it does", async () => {
    await ready();
    await useSftpStore.getState().transfer("local", [file("/work/a")]);
    await useSftpStore.getState().cancelTransfer("t1");
    expect(calls("sftp_cancel_transfer")).toEqual([{ id: "t1" }]);
    expect(row()).toMatchObject({ status: "running", cancelling: true });
    event(started()[0].onEvent, { type: "cancelled", id: "t1" });
    expect(row()?.status).toBe("cancelled");
  });

  it("starts again with overwrite once a conflict is answered yes", async () => {
    await ready();
    await useSftpStore.getState().transfer("local", [file("/work/a")]);
    event(started()[0].onEvent, {
      type: "conflict",
      id: "t1",
      target: "/home/me/a",
      target_is_dir: false,
    });
    expect(row()).toMatchObject({
      status: "conflict",
      conflict: { target: "/home/me/a", targetIsDir: false },
    });
    invokeMock.mockClear();
    await useSftpStore.getState().resolveConflict("t1", true);
    expect(started()[0].input.overwrite).toBe(true);
  });

  it("answering no writes nothing and removes the row", async () => {
    await ready();
    await useSftpStore.getState().transfer("local", [file("/work/a")]);
    event(started()[0].onEvent, {
      type: "conflict",
      id: "t1",
      target: "/home/me/a",
      target_is_dir: false,
    });
    invokeMock.mockClear();
    await useSftpStore.getState().resolveConflict("t1", false);
    expect(started()).toEqual([]);
    expect(row()).toBeUndefined();
  });

  it("clearing finished leaves what is running or waiting", async () => {
    await ready();
    useSftpStore.setState({
      transfers: (["running", "conflict", "done", "failed", "cancelled"] as const).map(
        (status) => ({ ...baseTransfer, id: status, status }),
      ),
    });
    useSftpStore.getState().clearFinished();
    expect(useSftpStore.getState().transfers.map((t) => t.id)).toEqual(["running", "conflict"]);
  });

  const baseTransfer = {
    input: {
      connection_id: "c1",
      direction: "upload" as const,
      source: "/a",
      target_dir: "/b",
      overwrite: false,
    },
    name: "a",
    cancelling: false,
    bytesDone: 0,
    bytesTotal: 0,
    filesDone: 0,
    filesTotal: 0,
    current: "",
    skipped: 0,
    error: null,
    conflict: null,
  };
});

describe("editing in place", () => {
  const session = {
    edit_id: "e1",
    name: "f.txt",
    remote_path: "/home/me/f.txt",
    temp_path: "/cache/e1/f.txt",
    size: 5,
  };

  async function editing() {
    await connected();
    backend({
      sftp_edit_open: () => session,
      sftp_list: ({ path }) => listing(path as string),
    });
    await useSftpStore.getState().openEdit(file("/home/me/f.txt"));
  }
  const edit = () => useSftpStore.getState().edit;

  it("opens a copy and launches the editor", async () => {
    await editing();
    expect(calls("sftp_edit_open")).toEqual([{ connectionId: "c1", remotePath: "/home/me/f.txt" }]);
    expect(calls("sftp_edit_launch")).toEqual([{ editId: "e1" }]);
    expect(edit()?.session).toEqual(session);
  });

  it("stays open when no editor can be launched, with the reason", async () => {
    await connected();
    backend({
      sftp_edit_open: () => session,
      sftp_edit_launch: () => {
        throw "No editor";
      },
    });
    await useSftpStore.getState().openEdit(file("/home/me/f.txt"));
    expect(edit()?.launchError).toBe("No editor");
  });

  it("reports a copy that could not be made", async () => {
    await connected();
    backend({
      sftp_edit_open: () => {
        throw "Too large";
      },
    });
    await useSftpStore.getState().openEdit(file("/home/me/f.txt"));
    expect(edit()).toBeNull();
    expect(useSftpStore.getState().editError).toBe("Too large");
    expect(useSftpStore.getState().editOpening).toBe(false);
  });

  it("opens one file at a time", async () => {
    await editing();
    invokeMock.mockClear();
    await useSftpStore.getState().openEdit(file("/home/me/other"));
    expect(calls("sftp_edit_open")).toEqual([]);
  });

  it("follows the copy's status", async () => {
    await editing();
    backend({ sftp_edit_status: () => ({ modified: true, missing: false }) });
    await useSftpStore.getState().pollEdit();
    expect(edit()?.modified).toBe(true);
  });

  it("saves without forcing and refreshes the pane", async () => {
    await editing();
    backend({
      sftp_edit_save: () => ({ outcome: "saved", size: 9 }),
      sftp_list: ({ path }) => listing(path as string),
    });
    useSftpStore.setState((s) => ({ edit: s.edit && { ...s.edit, modified: true } }));
    invokeMock.mockClear();
    await useSftpStore.getState().saveEdit(false);
    expect(calls("sftp_edit_save")).toEqual([{ editId: "e1", force: false }]);
    expect(edit()).toMatchObject({ saving: false, modified: false });
    expect(edit()?.savedAt).not.toBeNull();
    expect(calls("sftp_list")).toHaveLength(1);
  });

  it("asks instead of overwriting a file changed on the server", async () => {
    await editing();
    backend({
      sftp_edit_save: () => ({ outcome: "remote_changed", deleted: false, size: 7, modified: 200 }),
    });
    useSftpStore.setState((s) => ({ edit: s.edit && { ...s.edit, modified: true } }));
    await useSftpStore.getState().saveEdit(false);
    expect(edit()?.remoteChange).toEqual({ deleted: false, size: 7, modified: 200 });
    expect(edit()?.savedAt).toBeNull();
    expect(edit()?.modified).toBe(true);

    useSftpStore.getState().dismissRemoteChange();
    expect(edit()?.remoteChange).toBeNull();
    expect(edit()?.modified).toBe(true);
  });

  it("forces only when told to", async () => {
    await editing();
    backend({ sftp_edit_save: () => ({ outcome: "saved", size: 9 }) });
    await useSftpStore.getState().saveEdit(true);
    expect(calls("sftp_edit_save")).toEqual([{ editId: "e1", force: true }]);
  });

  it("shows a failed save and keeps the edit", async () => {
    await editing();
    backend({
      sftp_edit_save: () => {
        throw "Permission denied";
      },
    });
    await useSftpStore.getState().saveEdit(false);
    expect(edit()).toMatchObject({ saving: false, saveError: "Permission denied" });
  });

  describe("an answer about an edit that has since closed", () => {
    const later = { ...session, edit_id: "e2", name: "g.txt" };

    /** With the edit open and `command` unanswered, move on to another edit. */
    async function replacedWhile(command: string, start: () => Promise<void>) {
      await editing();
      let answer: { resolve: (value: unknown) => void; reject: (why: unknown) => void } = {
        resolve: () => {},
        reject: () => {},
      };
      invokeMock.mockImplementation(async (name: string) => {
        if (name === command) {
          return new Promise((resolve, reject) => (answer = { resolve, reject })) as never;
        }
        if (name === "sftp_edit_open") return later as never;
        return undefined as never;
      });
      const pending = start();
      await flush();
      await useSftpStore.getState().closeEdit();
      backend({ sftp_edit_open: () => later });
      await useSftpStore.getState().openEdit(file("/home/me/g.txt"));
      expect(edit()?.session.edit_id).toBe("e2");
      return { answer, pending };
    }

    const untouched = () =>
      expect(edit()).toMatchObject({
        saving: false,
        saveError: null,
        remoteChange: null,
        savedAt: null,
        launchError: null,
        modified: false,
      });

    it("a finished save leaves the new edit alone", async () => {
      const { answer, pending } = await replacedWhile("sftp_edit_save", () =>
        useSftpStore.getState().saveEdit(false),
      );
      answer.resolve({ outcome: "saved", size: 9 });
      await pending;
      untouched();
    });

    it("a change on the server leaves the new edit alone", async () => {
      const { answer, pending } = await replacedWhile("sftp_edit_save", () =>
        useSftpStore.getState().saveEdit(false),
      );
      answer.resolve({ outcome: "remote_changed", deleted: true, size: null, modified: null });
      await pending;
      untouched();
    });

    it("a failed save leaves the new edit alone", async () => {
      const { answer, pending } = await replacedWhile("sftp_edit_save", () =>
        useSftpStore.getState().saveEdit(false),
      );
      answer.reject("Permission denied");
      await pending;
      untouched();
    });

    it("a failed launch leaves the new edit alone", async () => {
      const { answer, pending } = await replacedWhile("sftp_edit_launch", () =>
        useSftpStore.getState().launchEditor(),
      );
      answer.reject("No editor");
      await pending;
      untouched();
    });
  });

  describe("closing unless modified", () => {
    const close = () => useSftpStore.getState().closeEditUnlessModified();

    it("asks when the copy changed after the last poll", async () => {
      await editing();
      expect(edit()?.modified).toBe(false);
      backend({ sftp_edit_status: () => ({ modified: true, missing: false }) });
      expect(await close()).toBe(true);
      expect(calls("sftp_edit_close")).toEqual([]);
      expect(edit()?.modified).toBe(true);
    });

    it("closes when the copy has gone back to what the server holds", async () => {
      await editing();
      useSftpStore.setState((s) => ({ edit: s.edit && { ...s.edit, modified: true } }));
      backend({ sftp_edit_status: () => ({ modified: false, missing: false }) });
      expect(await close()).toBe(false);
      expect(calls("sftp_edit_close")).toEqual([{ editId: "e1" }]);
      expect(edit()).toBeNull();
    });

    it("treats a status that cannot be read as modified", async () => {
      await editing();
      backend({
        sftp_edit_status: () => {
          throw "Could not read the copy";
        },
      });
      expect(await close()).toBe(true);
      expect(calls("sftp_edit_close")).toEqual([]);
      expect(edit()).not.toBeNull();
    });

    it("closes when the copy is gone, with nothing left to lose", async () => {
      await editing();
      backend({ sftp_edit_status: () => ({ modified: false, missing: true }) });
      expect(await close()).toBe(false);
      expect(edit()).toBeNull();
    });
  });

  it("closing removes the copy", async () => {
    await editing();
    await useSftpStore.getState().closeEdit();
    expect(edit()).toBeNull();
    expect(calls("sftp_edit_close")).toEqual([{ editId: "e1" }]);
  });
});
