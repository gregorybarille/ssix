import { create } from "zustand";
import { AppSettings } from "@/types";
import { invoke } from "@/lib/tauri";
import { runAsync, runAsyncRethrow } from "@/lib/asyncAction";

interface SettingsState {
  settings: AppSettings;
  isLoading: boolean;
  error: string | null;
  fetchSettings: () => Promise<void>;
  saveSettings: (settings: AppSettings) => Promise<void>;
}

const DEFAULT_SETTINGS: AppSettings = {
  font_size: 14,
  font_family: "JetBrains Mono",
  color_scheme: "blue",
  theme: "dark",
  connection_layout: "list",
  credential_layout: "list",
  tunnel_layout: "list",
  default_open_mode: "tab",
  auto_copy_selection: false,
  git_sync_repo_path: undefined,
  git_sync_remote: "origin",
  git_sync_branch: undefined,
};

// Audit-4 Dup H1: same async-action pattern as the other stores.
export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  isLoading: false,
  error: null,

  fetchSettings: () =>
    runAsync(set, async () => {
      const settings = await invoke<AppSettings>("get_settings");
      set({ settings });
    }).then(() => undefined),

  // Optimistic: the store reflects the new value at once, so a preview
  // (theme, font) does not flash back to the old value while the save is
  // in flight; a rejected save restores the previous settings.
  saveSettings: (settings) =>
    runAsyncRethrow(set, async () => {
      const previous = get().settings;
      set({ settings });
      try {
        const saved = await invoke<AppSettings>("save_settings", { settings });
        set({ settings: saved });
      } catch (err) {
        set({ settings: previous });
        throw err;
      }
    }),
}));
