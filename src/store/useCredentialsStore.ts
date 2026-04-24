import { create } from "zustand";
import { Credential } from "@/types";
import { invoke } from "@/lib/tauri";
import { runAsync, runAsyncRethrow } from "@/lib/asyncAction";

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

// Audit-4 Dup H1: same async-action pattern as useConnectionsStore.
export const useCredentialsStore = create<CredentialsState>((set) => ({
  credentials: [],
  isLoading: false,
  error: null,

  fetchCredentials: () =>
    runAsync(set, async () => {
      const credentials = await invoke<Credential[]>("get_credentials");
      set({ credentials });
    }).then(() => undefined),

  addCredential: (input) =>
    runAsyncRethrow(set, async () => {
      const cred = await invoke<Credential>("add_credential", { input });
      set((state) => ({ credentials: [...state.credentials, cred] }));
      return cred;
    }),

  // Inline (private) credentials skip the store-level loading/error
  // tracking because they're an implementation detail of save_connection
  // — the connection's own loading state covers the user-visible flow.
  addInlineCredential: (input) => invoke<Credential>("add_credential", { input }),

  updateCredential: (input) =>
    runAsyncRethrow(set, async () => {
      const cred = await invoke<Credential>("update_credential", { input });
      set((state) => ({
        credentials: state.credentials.map((c) => (c.id === cred.id ? cred : c)),
      }));
    }),

  deleteCredential: (id) =>
    runAsyncRethrow(set, async () => {
      await invoke("delete_credential", { id });
      set((state) => ({ credentials: state.credentials.filter((c) => c.id !== id) }));
    }),
}));
