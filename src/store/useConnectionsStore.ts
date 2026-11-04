import { create } from "zustand";
import { Connection, ConnectionInput } from "@/types";
import { invoke } from "@/lib/tauri";
import { runAsync, runAsyncRethrow } from "@/lib/asyncAction";
import { usePortForwardsStore } from "./usePortForwardsStore";

interface ConnectionsState {
  connections: Connection[];
  isLoading: boolean;
  /**
   * Why the last `fetchConnections` failed, shown as a banner in the
   * Connections view. Mutations report their failures to the caller (the
   * form or confirm dialog that triggered them) and leave this untouched.
   */
  error: string | null;
  fetchConnections: () => Promise<void>;
  addConnection: (input: ConnectionInput) => Promise<void>;
  updateConnection: (input: Connection) => Promise<void>;
  deleteConnection: (id: string) => Promise<void>;
  /** Save the clone form's connection as a new one; `id` is the original's. */
  cloneConnection: (id: string, input: ConnectionInput) => Promise<void>;
  /** File a connection under `folder`; null takes it out of any folder. */
  moveConnectionToFolder: (id: string, folder: string | null) => Promise<void>;
  /** Rename a folder, which moves every connection in or under it. */
  renameFolder: (from: string, to: string) => Promise<void>;
  /** Remove a folder: what it holds moves up a level. Deletes no connection. */
  deleteFolder: (path: string) => Promise<void>;
}

const withReplaced = (connections: Connection[], conn: Connection) =>
  connections.map((c) => (c.id === conn.id ? conn : c));

// The store always holds the full, unfiltered list. Search is a pure
// client-side filter (`src/lib/search.ts`) over this list, so typing in
// the search bar never touches the backend or replaces the array.
export const useConnectionsStore = create<ConnectionsState>((set) => ({
  connections: [],
  isLoading: false,
  error: null,

  // Mutations use runAsyncRethrow so callers (ConnectionForm, the delete
  // confirm) can `.catch()`, keep their dialog open and show the error
  // themselves; `recordError: false` keeps that error out of `error`,
  // which only reflects the last load. Fetches use runAsync (no rethrow)
  // and record into `error` for the view's load-error banner.
  fetchConnections: () =>
    runAsync(set, async () => {
      const connections = await invoke<Connection[]>("get_connections");
      set({ connections });
    }).then(() => undefined),

  addConnection: (input) =>
    runAsyncRethrow(set, async () => {
      const conn = await invoke<Connection>("add_connection", { input });
      set((state) => ({ connections: [...state.connections, conn] }));
    }, { recordError: false }),

  updateConnection: (input) =>
    runAsyncRethrow(set, async () => {
      const conn = await invoke<Connection>("update_connection", { input });
      set((state) => ({ connections: withReplaced(state.connections, conn) }));
    }, { recordError: false }),

  deleteConnection: (id) =>
    runAsyncRethrow(set, async () => {
      // Its row holds the only Stop button, so a forward left running could
      // not be stopped any more.
      await usePortForwardsStore.getState().stopForwardsOf(id);
      await invoke("delete_connection", { id });
      set((state) => ({ connections: state.connections.filter((c) => c.id !== id) }));
    }, { recordError: false }),

  cloneConnection: (id, input) =>
    runAsyncRethrow(set, async () => {
      const conn = await invoke<Connection>("clone_connection", {
        input: { ...input, id },
      });
      set((state) => ({ connections: [...state.connections, conn] }));
    }, { recordError: false }),

  moveConnectionToFolder: (id, folder) =>
    runAsyncRethrow(set, async () => {
      const conn = await invoke<Connection>("move_connection_to_folder", { id, folder });
      set((state) => ({ connections: withReplaced(state.connections, conn) }));
    }, { recordError: false }),

  // Both answer with every connection: one call can touch many of them.
  renameFolder: (from, to) =>
    runAsyncRethrow(set, async () => {
      set({ connections: await invoke<Connection[]>("rename_folder", { from, to }) });
    }, { recordError: false }),

  deleteFolder: (path) =>
    runAsyncRethrow(set, async () => {
      set({ connections: await invoke<Connection[]>("delete_folder", { path }) });
    }, { recordError: false }),
}));
