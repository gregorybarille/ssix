import { create } from "zustand";
import type { Snippet, SnippetInput } from "@/types";
import { invoke } from "@/lib/tauri";
import { runAsync, runAsyncRethrow } from "@/lib/asyncAction";
import { useTerminalsStore } from "./useTerminalsStore";
import { useViewStore } from "./useViewStore";

interface SnippetsState {
  snippets: Snippet[];
  isLoading: boolean;
  /** Why the last `fetchSnippets` failed. Mutations report to their caller. */
  error: string | null;
  paletteOpen: boolean;
  fetchSnippets: () => Promise<void>;
  addSnippet: (input: SnippetInput) => Promise<Snippet>;
  updateSnippet: (id: string, input: SnippetInput) => Promise<Snippet>;
  deleteSnippet: (id: string) => Promise<void>;
  /**
   * Open the palette. Terminals are mounted only on their own view, so with
   * a tab open this goes there: a paste needs a live pane, and it shows where
   * the text lands. An editor with unsaved changes asks first, as it does for
   * any change of view.
   */
  openPalette: () => void;
  closePalette: () => void;
}

export const useSnippetsStore = create<SnippetsState>((set) => ({
  snippets: [],
  isLoading: false,
  error: null,
  paletteOpen: false,

  fetchSnippets: () =>
    runAsync(set, async () => {
      const snippets = await invoke<Snippet[]>("get_snippets");
      set({ snippets });
    }).then(() => undefined),

  addSnippet: (input) =>
    runAsyncRethrow(set, async () => {
      const snippet = await invoke<Snippet>("add_snippet", { input });
      set((state) => ({ snippets: [...state.snippets, snippet] }));
      return snippet;
    }, { recordError: false }),

  updateSnippet: (id, input) =>
    runAsyncRethrow(set, async () => {
      const snippet = await invoke<Snippet>("update_snippet", { id, input });
      set((state) => ({ snippets: state.snippets.map((s) => (s.id === id ? snippet : s)) }));
      return snippet;
    }, { recordError: false }),

  deleteSnippet: (id) =>
    runAsyncRethrow(set, async () => {
      await invoke("delete_snippet", { id });
      set((state) => ({ snippets: state.snippets.filter((s) => s.id !== id) }));
    }, { recordError: false }),

  openPalette: () => {
    if (useTerminalsStore.getState().tabs.length > 0) {
      useViewStore.getState().setView("terminals");
    }
    set({ paletteOpen: true });
  },

  closePalette: () => set({ paletteOpen: false }),
}));
