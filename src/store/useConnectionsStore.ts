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
  searchConnections: (query: string) => Promise<void>;
  getOrphanPrivateCredential: (connId: string) => Promise<string | null>;
}

// Audit-4 Phase 4: removed `searchQuery` slice and `setSearchQuery`
// action — App.tsx owns its own search input state and never read the
// store's copy. Keeping a duplicate source of truth invited drift.
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

  searchConnections: (query) =>
    runAsync(set, async () => {
      const connections = await invoke<Connection[]>("search_connections", { query });
      set({ connections });
    }).then(() => undefined),

  getOrphanPrivateCredential: async (connId) => {
    try {
      return await invoke<string | null>("get_orphan_private_credential", { connId });
    } catch {
      return null;
    }
  },
}));
