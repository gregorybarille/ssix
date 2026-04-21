import { create } from "zustand";
import { Credential } from "@/types";
import { invoke } from "@/lib/tauri";

interface CredentialsState {
  credentials: Credential[];
  isLoading: boolean;
  error: string | null;
  fetchCredentials: () => Promise<void>;
  addCredential: (input: Omit<Credential, "id">) => Promise<Credential>;
  /** Creates a private (inline) credential without adding it to the visible store state. */
  addInlineCredential: (input: Omit<Credential, "id">) => Promise<Credential>;
  updateCredential: (input: Credential) => Promise<void>;
  deleteCredential: (id: string) => Promise<void>;
}

export const useCredentialsStore = create<CredentialsState>((set) => ({
  credentials: [],
  isLoading: false,
  error: null,

  fetchCredentials: async () => {
    set({ isLoading: true, error: null });
    try {
      const credentials = await invoke<Credential[]>("get_credentials");
      set({ credentials, isLoading: false });
    } catch (err) {
      set({ error: String(err), isLoading: false });
    }
  },

  addCredential: async (input) => {
    set({ isLoading: true, error: null });
    try {
      const cred = await invoke<Credential>("add_credential", { input });
      set((state) => ({
        credentials: [...state.credentials, cred],
        isLoading: false,
      }));
      return cred;
    } catch (err) {
      set({ error: String(err), isLoading: false });
      throw err;
    }
  },

  addInlineCredential: async (input) => {
    try {
      return await invoke<Credential>("add_credential", { input });
    } catch (err) {
      throw err;
    }
  },

  updateCredential: async (input) => {
    set({ isLoading: true, error: null });
    try {
      const cred = await invoke<Credential>("update_credential", { input });
      set((state) => ({
        credentials: state.credentials.map((c) => (c.id === cred.id ? cred : c)),
        isLoading: false,
      }));
    } catch (err) {
      set({ error: String(err), isLoading: false });
      throw err;
    }
  },

  deleteCredential: async (id) => {
    set({ isLoading: true, error: null });
    try {
      await invoke("delete_credential", { id });
      set((state) => ({
        credentials: state.credentials.filter((c) => c.id !== id),
        isLoading: false,
      }));
    } catch (err) {
      set({ error: String(err), isLoading: false });
      throw err;
    }
  },
}));
