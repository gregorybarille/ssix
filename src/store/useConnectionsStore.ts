import { create } from "zustand";
import { Connection } from "@/types";
import { invoke } from "@/lib/tauri";

interface ConnectionsState {
  connections: Connection[];
  searchQuery: string;
  isLoading: boolean;
  error: string | null;
  fetchConnections: () => Promise<void>;
  addConnection: (input: Omit<Connection, "id">) => Promise<void>;
  updateConnection: (input: Connection) => Promise<void>;
  deleteConnection: (id: string) => Promise<void>;
  cloneConnection: (id: string, newName: string, overrides?: Partial<Connection>) => Promise<void>;
  searchConnections: (query: string) => Promise<void>;
  setSearchQuery: (q: string) => void;
  getOrphanPrivateCredential: (connId: string) => Promise<string | null>;
}

export const useConnectionsStore = create<ConnectionsState>((set) => ({
  connections: [],
  searchQuery: "",
  isLoading: false,
  error: null,

  fetchConnections: async () => {
    set({ isLoading: true, error: null });
    try {
      const connections = await invoke<Connection[]>("get_connections");
      set({ connections, isLoading: false });
    } catch (err) {
      set({ error: String(err), isLoading: false });
    }
  },

  addConnection: async (input) => {
    set({ isLoading: true, error: null });
    try {
      const conn = await invoke<Connection>("add_connection", { input });
      set((state) => ({
        connections: [...state.connections, conn],
        isLoading: false,
      }));
    } catch (err) {
      set({ error: String(err), isLoading: false });
      throw err;
    }
  },

  updateConnection: async (input) => {
    set({ isLoading: true, error: null });
    try {
      const conn = await invoke<Connection>("update_connection", { input });
      set((state) => ({
        connections: state.connections.map((c) => (c.id === conn.id ? conn : c)),
        isLoading: false,
      }));
    } catch (err) {
      set({ error: String(err), isLoading: false });
      throw err;
    }
  },

  deleteConnection: async (id) => {
    set({ isLoading: true, error: null });
    try {
      await invoke("delete_connection", { id });
      set((state) => ({
        connections: state.connections.filter((c) => c.id !== id),
        isLoading: false,
      }));
    } catch (err) {
      set({ error: String(err), isLoading: false });
      throw err;
    }
  },

  cloneConnection: async (id, newName, overrides) => {
    set({ isLoading: true, error: null });
    try {
      const conn = await invoke<Connection>("clone_connection", {
        input: { id, new_name: newName, ...overrides },
      });
      set((state) => ({
        connections: [...state.connections, conn],
        isLoading: false,
      }));
    } catch (err) {
      set({ error: String(err), isLoading: false });
      throw err;
    }
  },

  searchConnections: async (query) => {
    set({ isLoading: true, error: null, searchQuery: query });
    try {
      const connections = await invoke<Connection[]>("search_connections", { query });
      set({ connections, isLoading: false });
    } catch (err) {
      set({ error: String(err), isLoading: false });
    }
  },

  setSearchQuery: (q) => set({ searchQuery: q }),

  getOrphanPrivateCredential: async (connId) => {
    try {
      return await invoke<string | null>("get_orphan_private_credential", { connId });
    } catch {
      return null;
    }
  },
}));
