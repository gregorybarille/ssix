import { create } from "zustand";
import { Connection, ConnectionInput } from "@/types";
import { invoke } from "@/lib/tauri";
import { runAsync, runAsyncRethrow } from "@/lib/asyncAction";

interface ConnectionsState {
  connections: Connection[];
  isLoading: boolean;
  error: string | null;
  fetchConnections: () => Promise<void>;
  addConnection: (input: ConnectionInput) => Promise<void>;
  updateConnection: (input: Connection) => Promise<void>;
  deleteConnection: (id: string) => Promise<void>;
  cloneConnection: (id: string, newName: string, overrides?: Partial<Connection>) => Promise<void>;
  getOrphanPrivateCredential: (connId: string) => Promise<string | null>;
}

// The store always holds the full, unfiltered list. Search is a pure
// client-side filter (`src/lib/search.ts`) over this list, so typing in
// the search bar never touches the backend or replaces the array.
export const useConnectionsStore = create<ConnectionsState>((set) => ({
  connections: [],
  isLoading: false,
  error: null,

  // Audit-4 Dup H1: all four mutating actions delegated to runAsyncRethrow
  // so callers (e.g. ConnectionForm) can `.catch()` to keep dialogs open
  // on validation errors. Fetches use runAsync (no rethrow) since their
  // callers (App.tsx mount effect) don't `.catch()`.
  fetchConnections: () =>
    runAsync(set, async () => {
      const connections = await invoke<Connection[]>("get_connections");
      set({ connections });
    }).then(() => undefined),

  addConnection: (input) =>
    runAsyncRethrow(set, async () => {
      const conn = await invoke<Connection>("add_connection", { input });
      set((state) => ({ connections: [...state.connections, conn] }));
    }),

  updateConnection: (input) =>
    runAsyncRethrow(set, async () => {
      const conn = await invoke<Connection>("update_connection", { input });
      set((state) => ({
        connections: state.connections.map((c) => (c.id === conn.id ? conn : c)),
      }));
    }),

  deleteConnection: (id) =>
    runAsyncRethrow(set, async () => {
      await invoke("delete_connection", { id });
      set((state) => ({ connections: state.connections.filter((c) => c.id !== id) }));
    }),

  cloneConnection: (id, newName, overrides) =>
    runAsyncRethrow(set, async () => {
      const conn = await invoke<Connection>("clone_connection", {
        input: { id, new_name: newName, ...overrides },
      });
      set((state) => ({ connections: [...state.connections, conn] }));
    }),

  // Errors propagate: silently answering "no orphan" would let a delete
  // proceed and leave a private credential's secrets behind.
  getOrphanPrivateCredential: (connId) =>
    invoke<string | null>("get_orphan_private_credential", { connId }),
}));
