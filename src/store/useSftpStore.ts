import { create } from "zustand";
import { invoke } from "@/lib/tauri";
import { errorMessage } from "@/lib/errors";
import { useViewStore } from "@/store/useViewStore";
import {
  baseName,
  createTransferChannel,
  isSessionLost,
  readableSftpError,
} from "@/lib/sftp";
import type {
  Connection,
  EditSaveOutcome,
  EditSession,
  EditStatus,
  FileEntry,
  FileListing,
  PaneTarget,
  SftpSessionInfo,
  TransferDirection,
  TransferEvent,
  TransferInput,
} from "@/types";

export type PaneSide = "local" | "remote";

export interface PaneState {
  path: string;
  parent: string | null;
  entries: FileEntry[];
  /** Selected rows by path, in the order they were picked. */
  selected: string[];
  /** The row a shift-click extends from. */
  anchor: string | null;
  loading: boolean;
  /** Why the last load failed; the entries are then the previous folder's. */
  error: string | null;
  omitted: number;
  truncated: boolean;
}

export type TransferStatus = "running" | "done" | "failed" | "cancelled" | "conflict";

export interface Transfer {
  id: string;
  input: TransferInput;
  name: string;
  status: TransferStatus;
  cancelling: boolean;
  bytesDone: number;
  bytesTotal: number;
  filesDone: number;
  filesTotal: number;
  current: string;
  skipped: number;
  error: string | null;
  conflict: { target: string; targetIsDir: boolean } | null;
}

export interface EditState {
  session: EditSession;
  connectionId: string;
  modified: boolean;
  missing: boolean;
  launchError: string | null;
  saving: boolean;
  saveError: string | null;
  /** The last save stopped because the server's file changed. */
  remoteChange: { deleted: boolean; size: number | null; modified: number | null } | null;
  /** When the copy last reached the server. */
  savedAt: number | null;
}

/** The dialog or confirmation the view shows, opened from a pane. */
export type FileDialog =
  | { kind: "mkdir"; side: PaneSide }
  | { kind: "rename"; side: PaneSide; entry: FileEntry }
  | { kind: "chmod"; side: PaneSide; entry: FileEntry }
  | { kind: "delete"; side: PaneSide; entries: FileEntry[] };

export type SelectMode = "replace" | "toggle" | "range";

interface SftpState {
  connectionId: string | null;
  sessionId: string | null;
  label: string | null;
  connecting: boolean;
  connectError: string | null;
  local: PaneState;
  remote: PaneState;
  transfers: Transfer[];
  edit: EditState | null;
  editOpening: boolean;
  editError: string | null;
  dialog: FileDialog | null;
  /** A change the lost session stopped, whose dialog closed with that session. */
  changeError: string | null;

  initLocal: () => Promise<void>;
  /** Open a session to the connection and show `path`, or where it starts. */
  connect: (connectionId: string, path?: string) => Promise<void>;
  disconnect: () => void;
  /** Try the failed connection again; picking it in the list again would change nothing. */
  retryConnect: () => Promise<void>;
  /** Accept the host key a connection now presents, and connect again. */
  trustHostKey: (host: string, port: number) => Promise<void>;
  navigate: (side: PaneSide, path: string) => Promise<void>;
  refresh: (side: PaneSide) => Promise<void>;
  select: (side: PaneSide, path: string, mode: SelectMode) => void;
  setDialog: (dialog: FileDialog | null) => void;
  mkdir: (side: PaneSide, name: string) => Promise<void>;
  rename: (side: PaneSide, entry: FileEntry, newName: string) => Promise<void>;
  chmod: (side: PaneSide, entry: FileEntry, mode: number) => Promise<void>;
  remove: (side: PaneSide, entries: FileEntry[]) => Promise<void>;
  /** Copy entries from `side` to the other pane's folder, or `targetDir`. */
  transfer: (
    side: PaneSide,
    entries: Pick<FileEntry, "path">[],
    targetDir?: string,
  ) => Promise<void>;
  uploadPaths: (paths: string[], targetDir?: string) => Promise<void>;
  cancelTransfer: (id: string) => Promise<void>;
  dismissTransfer: (id: string) => void;
  clearFinished: () => void;
  /** Answer a transfer's "replace it?": `overwrite` starts it again. */
  resolveConflict: (id: string, overwrite: boolean) => Promise<void>;
  openEdit: (entry: FileEntry) => Promise<void>;
  launchEditor: () => Promise<void>;
  pollEdit: () => Promise<void>;
  saveEdit: (force: boolean) => Promise<void>;
  closeEdit: () => Promise<void>;
  /** Close the edit unless its copy has changes to lose; true means ask first. */
  closeEditUnlessModified: () => Promise<boolean>;
  dismissRemoteChange: () => void;
  dismissEditError: () => void;
  dismissChangeError: () => void;
}

const emptyPane = (): PaneState => ({
  path: "",
  parent: null,
  entries: [],
  selected: [],
  anchor: null,
  loading: false,
  error: null,
  omitted: 0,
  truncated: false,
});

// A newer request replaces an older one: an answer that arrives after it is
// about a folder or connection the user has left.
const paneRequests: Record<PaneSide, number> = { local: 0, remote: 0 };
let connectRequests = 0;
/** The session was replaced and no folder has been listed on the new one yet. */
let justReconnected = false;
/** Numbers rows for transfers the backend refused, which have no id from it. */
let refusedTransfers = 0;
/** Transfers ending together share a listing, and one more if any ended during it. */
const targetRefresh: Record<PaneSide, { running: boolean; again: boolean }> = {
  local: { running: false, again: false },
  remote: { running: false, again: false },
};

export const useSftpStore = create<SftpState>((set, get) => {
  /**
   * Where a command for this pane runs. A remote pane with no session has
   * nowhere to run anything, and must never fall back to this computer.
   */
  const paneTarget = (side: PaneSide): PaneTarget => {
    if (side === "local") return { side };
    const { sessionId } = get();
    if (!sessionId) throw new Error("The server is not connected, so nothing was changed.");
    return { side, session_id: sessionId };
  };

  const patchPane = (side: PaneSide, patch: Partial<PaneState>) =>
    set((state) => ({ [side]: { ...state[side], ...patch } }) as Partial<SftpState>);

  /** Patch this edit if it is still the open one: an answer can outlive it. */
  const patchEdit = (editId: string, patch: Partial<EditState>) =>
    set((state) =>
      state.edit?.session.edit_id === editId ? { edit: { ...state.edit, ...patch } } : {},
    );

  /**
   * A lost session is replaced in the background; the caller reports the
   * error. A folder that takes the new session down too must not loop, so
   * that error stays on screen and the next try is the user's.
   */
  const reconnectIfLost = (message: string) => {
    const { connectionId, remote } = get();
    if (!isSessionLost(message) || !connectionId) return;
    if (justReconnected) {
      justReconnected = false;
      return;
    }
    justReconnected = true;
    void get().connect(connectionId, remote.path);
  };

  /** Run a change made through a dialog: its error is the dialog's to show. */
  const mutate = async (side: PaneSide, change: () => Promise<unknown>) => {
    try {
      await change();
    } catch (err) {
      const message = errorMessage(err);
      const readable = readableSftpError(message);
      if (side === "remote") {
        reconnectIfLost(message);
        // Reconnecting closes the dialog that would have shown this.
        if (get().dialog === null && isSessionLost(message)) {
          set({ changeError: `That change did not finish. ${readable}` });
        }
      }
      throw new Error(readable);
    }
    await get().refresh(side);
  };

  const patchTransfer = (id: string, base: Transfer, patch: Partial<Transfer>) =>
    set((state) =>
      state.transfers.some((t) => t.id === id)
        ? { transfers: state.transfers.map((t) => (t.id === id ? { ...t, ...patch } : t)) }
        : { transfers: [...state.transfers, { ...base, id, ...patch }] },
    );

  const refreshAfterTransfer = async (side: PaneSide) => {
    const state = targetRefresh[side];
    if (state.running) {
      state.again = true;
      return;
    }
    state.running = true;
    do {
      state.again = false;
      await get().refresh(side);
    } while (state.again);
    state.running = false;
  };

  const refreshTargetOf = ({ input }: Transfer) => {
    const { connectionId, local, remote } = get();
    if (input.direction === "download") {
      if (local.path === input.target_dir) void refreshAfterTransfer("local");
    } else if (connectionId === input.connection_id && remote.path === input.target_dir) {
      void refreshAfterTransfer("remote");
    }
  };

  const applyEvent = (base: Transfer, event: TransferEvent) => {
    const { id } = event;
    switch (event.type) {
      case "progress":
        patchTransfer(id, base, {
          bytesDone: event.bytes_done,
          bytesTotal: event.bytes_total,
          filesDone: event.files_done,
          filesTotal: event.files_total,
          current: event.current,
        });
        return;
      case "conflict":
        patchTransfer(id, base, {
          status: "conflict",
          conflict: { target: event.target, targetIsDir: event.target_is_dir },
        });
        return;
      case "done":
        patchTransfer(id, base, {
          status: "done",
          bytesDone: event.bytes,
          filesDone: event.files,
          skipped: event.skipped,
        });
        break;
      case "cancelled":
        patchTransfer(id, base, { status: "cancelled" });
        break;
      case "failed":
        patchTransfer(id, base, { status: "failed", error: readableSftpError(event.error) });
        break;
    }
    // Finished one way or another: a folder may be partly there.
    refreshTargetOf(base);
  };

  const startTransfer = async (input: TransferInput) => {
    const base: Transfer = {
      id: "",
      input,
      name: baseName(input.source),
      status: "running",
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
    try {
      const channel = await createTransferChannel((event) => applyEvent(base, event));
      const id = await invoke<string>("sftp_start_transfer", { input, onEvent: channel });
      // Events may have added the row already; this only adds what they did not.
      patchTransfer(id, base, {});
    } catch (err) {
      refusedTransfers += 1;
      patchTransfer(`refused-${refusedTransfers}`, base, {
        status: "failed",
        error: readableSftpError(errorMessage(err)),
      });
    }
  };

  return {
    connectionId: null,
    sessionId: null,
    label: null,
    connecting: false,
    connectError: null,
    local: emptyPane(),
    remote: emptyPane(),
    transfers: [],
    edit: null,
    editOpening: false,
    editError: null,
    dialog: null,
    changeError: null,

    initLocal: async () => {
      if (get().local.path) return;
      try {
        await get().navigate("local", await invoke<string>("sftp_local_home"));
      } catch (err) {
        patchPane("local", { error: errorMessage(err) });
      }
    },

    connect: async (connectionId, path) => {
      const request = ++connectRequests;
      paneRequests.remote += 1;
      const previous = get().sessionId;
      if (previous) invoke("sftp_disconnect", { sessionId: previous }).catch(() => {});
      set({
        connectionId,
        sessionId: null,
        label: null,
        connecting: true,
        connectError: null,
        // An open dialog holds paths from the session this one replaces.
        dialog: null,
        changeError: null,
        // Reconnecting to the same folder keeps the rows until the new ones arrive.
        remote: path ? { ...get().remote, error: null } : emptyPane(),
      });
      try {
        const info = await invoke<SftpSessionInfo>("sftp_connect", { connectionId });
        if (request !== connectRequests) {
          invoke("sftp_disconnect", { sessionId: info.session_id }).catch(() => {});
          return;
        }
        set({ sessionId: info.session_id, label: info.label, connecting: false });
        await get().navigate("remote", path || info.start_path);
      } catch (err) {
        if (request === connectRequests) {
          set({ connecting: false, connectError: errorMessage(err) });
        }
      }
    },

    disconnect: () => {
      connectRequests += 1;
      paneRequests.remote += 1;
      const { sessionId } = get();
      if (sessionId) invoke("sftp_disconnect", { sessionId }).catch(() => {});
      set({
        connectionId: null,
        sessionId: null,
        label: null,
        connecting: false,
        connectError: null,
        dialog: null,
        changeError: null,
        remote: emptyPane(),
      });
    },

    retryConnect: async () => {
      const { connectionId } = get();
      if (connectionId) await get().connect(connectionId);
    },

    trustHostKey: async (host, port) => {
      const { connectionId } = get();
      if (!connectionId) return;
      try {
        await invoke("ssh_forget_host_key", { host, port });
      } catch (err) {
        set({ connectError: errorMessage(err) });
        return;
      }
      await get().connect(connectionId);
    },

    navigate: async (side, path) => {
      if (side === "remote" && !get().sessionId) return;
      const request = ++paneRequests[side];
      patchPane(side, { loading: true, error: null });
      try {
        const listing = await invoke<FileListing>("sftp_list", {
          target: paneTarget(side),
          path,
        });
        if (request !== paneRequests[side]) return;
        if (side === "remote") justReconnected = false;
        const pane = get()[side];
        const stay = listing.path === pane.path;
        const exists = new Set(listing.entries.map((e) => e.path));
        patchPane(side, {
          path: listing.path,
          parent: listing.parent,
          entries: listing.entries,
          omitted: listing.omitted,
          truncated: listing.truncated,
          selected: stay ? pane.selected.filter((p) => exists.has(p)) : [],
          anchor: stay ? pane.anchor : null,
          loading: false,
        });
      } catch (err) {
        if (request !== paneRequests[side]) return;
        const message = errorMessage(err);
        patchPane(side, { loading: false, error: readableSftpError(message) });
        if (side === "remote") reconnectIfLost(message);
      }
    },

    refresh: (side) => get().navigate(side, get()[side].path),

    select: (side, path, mode) => {
      const pane = get()[side];
      if (mode === "toggle") {
        const on = pane.selected.includes(path);
        patchPane(side, {
          selected: on ? pane.selected.filter((p) => p !== path) : [...pane.selected, path],
          anchor: path,
        });
        return;
      }
      if (mode === "range" && pane.anchor) {
        const order = pane.entries.map((e) => e.path);
        const [from, to] = [order.indexOf(pane.anchor), order.indexOf(path)];
        if (from >= 0 && to >= 0) {
          patchPane(side, {
            selected: order.slice(Math.min(from, to), Math.max(from, to) + 1),
          });
          return;
        }
      }
      patchPane(side, { selected: [path], anchor: path });
    },

    setDialog: (dialog) => {
      // What is listed without a session may be gone, and has nowhere to run.
      if (dialog?.side === "remote" && !get().sessionId) return;
      set({ dialog });
    },

    mkdir: (side, name) =>
      mutate(side, () =>
        invoke("sftp_mkdir", { target: paneTarget(side), dir: get()[side].path, name }),
      ),

    rename: (side, entry, newName) =>
      mutate(side, () =>
        invoke("sftp_rename", { target: paneTarget(side), path: entry.path, newName }),
      ),

    chmod: (side, entry, mode) =>
      mutate(side, () =>
        invoke("sftp_chmod", { target: paneTarget(side), path: entry.path, mode }),
      ),

    // One at a time, so the first failure stops the rest and is reported. The
    // target is settled once: a session replaced partway must end the run.
    remove: async (side, entries) => {
      try {
        await mutate(side, async () => {
          const target = paneTarget(side);
          for (const entry of entries) {
            await invoke("sftp_delete", { target, path: entry.path });
          }
        });
      } catch (err) {
        // What went before the failure is gone; the pane must not show it.
        await get().refresh(side);
        throw err;
      }
    },

    transfer: async (side, entries, targetDir) => {
      const { connectionId, local, remote } = get();
      if (!connectionId) return;
      const direction: TransferDirection = side === "local" ? "upload" : "download";
      const target_dir = targetDir ?? (side === "local" ? remote.path : local.path);
      if (!target_dir) return;
      // In order and one at a time: each start is a blocking call in the
      // backend, and thousands at once would take a thread each.
      for (const { path } of entries) {
        await startTransfer({
          connection_id: connectionId,
          direction,
          source: path,
          target_dir,
          overwrite: false,
        });
      }
    },

    uploadPaths: (paths, targetDir) =>
      get().transfer(
        "local",
        paths.map((path) => ({ path })),
        targetDir,
      ),

    cancelTransfer: async (id) => {
      set((state) => ({
        transfers: state.transfers.map((t) => (t.id === id ? { ...t, cancelling: true } : t)),
      }));
      await invoke("sftp_cancel_transfer", { id }).catch(() => {});
    },

    dismissTransfer: (id) =>
      set((state) => ({ transfers: state.transfers.filter((t) => t.id !== id) })),

    clearFinished: () =>
      set((state) => ({
        transfers: state.transfers.filter(
          (t) => t.status === "running" || t.status === "conflict",
        ),
      })),

    resolveConflict: async (id, overwrite) => {
      const transfer = get().transfers.find((t) => t.id === id);
      if (!transfer) return;
      get().dismissTransfer(id);
      if (overwrite) await startTransfer({ ...transfer.input, overwrite: true });
    },

    openEdit: async (entry) => {
      const { connectionId, edit, editOpening } = get();
      if (!connectionId || edit || editOpening) return;
      set({ editOpening: true, editError: null });
      try {
        const session = await invoke<EditSession>("sftp_edit_open", {
          connectionId,
          remotePath: entry.path,
        });
        set({
          editOpening: false,
          edit: {
            session,
            connectionId,
            modified: false,
            missing: false,
            launchError: null,
            saving: false,
            saveError: null,
            remoteChange: null,
            savedAt: null,
          },
        });
        await get().launchEditor();
      } catch (err) {
        set({ editOpening: false, editError: readableSftpError(errorMessage(err)) });
      }
    },

    launchEditor: async () => {
      const editId = get().edit?.session.edit_id;
      if (!editId) return;
      try {
        await invoke("sftp_edit_launch", { editId });
        patchEdit(editId, { launchError: null });
      } catch (err) {
        patchEdit(editId, { launchError: errorMessage(err) });
      }
    },

    pollEdit: async () => {
      const editId = get().edit?.session.edit_id;
      if (!editId) return;
      try {
        patchEdit(editId, await invoke<EditStatus>("sftp_edit_status", { editId }));
      } catch {
        // The next poll tries again; saving reports anything that lasts.
      }
    },

    saveEdit: async (force) => {
      const edit = get().edit;
      if (!edit || edit.saving) return;
      const editId = edit.session.edit_id;
      patchEdit(editId, { saving: true, saveError: null, remoteChange: null });
      try {
        const result = await invoke<EditSaveOutcome>("sftp_edit_save", { editId, force });
        if (result.outcome === "saved") {
          patchEdit(editId, { saving: false, modified: false, savedAt: Date.now() });
          const { connectionId, remote } = get();
          if (connectionId === edit.connectionId && remote.path) await get().refresh("remote");
        } else {
          patchEdit(editId, {
            saving: false,
            remoteChange: {
              deleted: result.deleted,
              size: result.size,
              modified: result.modified,
            },
          });
        }
      } catch (err) {
        patchEdit(editId, { saving: false, saveError: readableSftpError(errorMessage(err)) });
      }
    },

    closeEdit: async () => {
      const edit = get().edit;
      if (!edit) return;
      set({ edit: null });
      await invoke("sftp_edit_close", { editId: edit.session.edit_id }).catch((err) => {
        set({ editError: errorMessage(err) });
      });
    },

    closeEditUnlessModified: async () => {
      const editId = get().edit?.session.edit_id;
      if (!editId) return false;
      // The last poll is up to two seconds old, and the editor may have saved
      // since. A copy that cannot be read may hold the only version of the work.
      let unsaved = true;
      try {
        const status = await invoke<EditStatus>("sftp_edit_status", { editId });
        patchEdit(editId, status);
        unsaved = status.modified && !status.missing;
      } catch {
        // Stays unsaved, so the user decides.
      }
      if (get().edit?.session.edit_id !== editId) return false;
      if (unsaved) return true;
      await get().closeEdit();
      return false;
    },

    dismissRemoteChange: () => {
      const editId = get().edit?.session.edit_id;
      if (editId) patchEdit(editId, { remoteChange: null });
    },

    dismissEditError: () => set({ editError: null }),

    dismissChangeError: () => set({ changeError: null }),
  };
});

/** The Browse-files row action: show a connection's files in the Files view. */
export function browseFiles(connection: Connection): void {
  const { connectionId, sessionId, connecting, connect } = useSftpStore.getState();
  const alreadyOpen = connectionId === connection.id && (sessionId !== null || connecting);
  if (!alreadyOpen) void connect(connection.id);
  useViewStore.getState().setView("files");
}
