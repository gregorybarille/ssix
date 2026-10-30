import { create } from "zustand";
import { Connection, ConnectionInput } from "@/types";
import { invoke } from "@/lib/tauri";
import { runAsync, runAsyncRethrow } from "@/lib/asyncAction";

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
  getOrphanPrivateCredential: (connId: string) => Promise<string | null>;
}

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
      set((state) => ({
        connections: state.connections.map((c) => (c.id === conn.id ? conn : c)),
      }));
    }, { recordError: false }),

  deleteConnection: (id) =>
    runAsyncRethrow(set, async () => {
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

  // Errors propagate: silently answering "no orphan" would let a delete
  // proceed and leave a private credential's secrets behind.
  getOrphanPrivateCredential: (connId) =>
    invoke<string | null>("get_orphan_private_credential", { connId }),
}));
