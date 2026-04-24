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
export const useSettingsStore = create<SettingsState>((set) => ({
  settings: DEFAULT_SETTINGS,
  isLoading: false,
  error: null,

  fetchSettings: () =>
    runAsync(set, async () => {
      const settings = await invoke<AppSettings>("get_settings");
      set({ settings });
    }).then(() => undefined),

  saveSettings: (settings) =>
    runAsyncRethrow(set, async () => {
      const saved = await invoke<AppSettings>("save_settings", { settings });
      set({ settings: saved });
    }),
}));
