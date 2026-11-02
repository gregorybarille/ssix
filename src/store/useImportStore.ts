import { create } from "zustand";
import type { ImportPreview, ImportResult } from "@/types";
import { invoke } from "@/lib/tauri";
import { errorMessage } from "@/lib/errors";
import { useConnectionsStore } from "./useConnectionsStore";
import { useCredentialsStore } from "./useCredentialsStore";

interface ImportState {
  /** The last preview loaded. Dropped when the dialog closes. */
  preview: ImportPreview | null;
  isLoading: boolean;
  /**
   * An import is being stored. Kept apart from `isLoading`, and through `reset`:
   * it cannot be stopped, and a panel opened meanwhile must not start another.
   */
  isApplying: boolean;
  /** Why the last preview could not be loaded; apply failures go to the caller. */
  error: string | null;
  /** Read the config at `path` (blank means `~/.ssh/config`); saves nothing. */
  loadPreview: (path: string) => Promise<void>;
  /**
   * Store the picked items of the preview of `path`. Rejects, saving nothing,
   * when the config changed since the preview; then load it again.
   */
  applyImport: (path: string, keys: string[]) => Promise<ImportResult>;
  reset: () => void;
}

/** Blank means the backend's default, `~/.ssh/config`. */
const pathArgument = (path: string) => path.trim() || null;

// Each load has a number so that a preview for a path the user has moved on
// from (or a dialog they closed) can never overwrite the current one, and only
// the latest load ends the busy state: `runAsync` would end it for whichever
// answers first, and Import would come back while a newer read is running.
let latestLoad = 0;

export const useImportStore = create<ImportState>((set) => ({
  preview: null,
  isLoading: false,
  isApplying: false,
  error: null,

  loadPreview: async (path) => {
    const load = ++latestLoad;
    set({ isLoading: true, error: null });
    try {
      const preview = await invoke<ImportPreview>("import_ssh_config_preview", {
        path: pathArgument(path),
      });
      if (load === latestLoad) set({ preview, isLoading: false });
    } catch (err) {
      // A file that can no longer be read has no preview to act on.
      if (load === latestLoad) set({ preview: null, error: errorMessage(err), isLoading: false });
    }
  },

  applyImport: async (path, keys) => {
    set({ isApplying: true });
    try {
      const result = await invoke<ImportResult>("import_ssh_config_apply", {
        input: { path: pathArgument(path), keys },
      });
      await Promise.all([
        useConnectionsStore.getState().fetchConnections(),
        useCredentialsStore.getState().fetchCredentials(),
      ]);
      return result;
    } finally {
      set({ isApplying: false });
    }
  },

  reset: () => {
    latestLoad++;
    set({ preview: null, isLoading: false, error: null });
  },
}));
