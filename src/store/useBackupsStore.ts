import { create } from "zustand";
import { BackupInfo, BackupList } from "@/types";
import { invoke } from "@/lib/tauri";
import { runAsync, runAsyncRethrow } from "@/lib/asyncAction";
import { useConnectionsStore } from "./useConnectionsStore";
import { useCredentialsStore } from "./useCredentialsStore";
import { useSettingsStore } from "./useSettingsStore";

interface BackupsState {
  dir: string;
  backups: BackupInfo[];
  isLoading: boolean;
  /** Why the last `fetchBackups` failed. Actions report to their caller. */
  error: string | null;
  fetchBackups: () => Promise<void>;
  createBackup: () => Promise<BackupInfo>;
  /**
   * Replace `~/.ssix` with the backup, then reload everything shown from
   * it. Resolves to the backup of the files it replaced, if any.
   */
  restoreBackup: (name: string) => Promise<BackupInfo | null>;
  deleteBackup: (name: string) => Promise<void>;
}

export const useBackupsStore = create<BackupsState>((set, get) => ({
  dir: "",
  backups: [],
  isLoading: false,
  error: null,

  fetchBackups: () =>
    runAsync(set, async () => {
      const list = await invoke<BackupList>("list_backups");
      set({ dir: list.dir, backups: list.backups });
    }).then(() => undefined),

  createBackup: () =>
    runAsyncRethrow(set, async () => {
      const created = await invoke<BackupInfo>("create_backup");
      await get().fetchBackups();
      return created;
    }, { recordError: false }),

  restoreBackup: (name) =>
    runAsyncRethrow(set, async () => {
      const previous = await invoke<BackupInfo | null>("restore_backup", { name });
      await Promise.all([
        get().fetchBackups(),
        useConnectionsStore.getState().fetchConnections(),
        useCredentialsStore.getState().fetchCredentials(),
        useSettingsStore.getState().fetchSettings(),
      ]);
      return previous;
    }, { recordError: false }),

  deleteBackup: (name) =>
    runAsyncRethrow(set, async () => {
      await invoke("delete_backup", { name });
      set((state) => ({ backups: state.backups.filter((b) => b.name !== name) }));
    }, { recordError: false }),
}));
