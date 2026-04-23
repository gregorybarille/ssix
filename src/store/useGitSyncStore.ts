import { create } from "zustand";
import { invoke } from "@/lib/tauri";
import { GitSyncDiff, GitSyncRunResult, GitSyncSnapshot, GitSyncStatus } from "@/types";

interface GitSyncState {
  status: GitSyncStatus;
  diff: GitSyncDiff;
  isLoading: boolean;
  actionOutput: string | null;
  error: string | null;
  fetchStatus: () => Promise<void>;
  fetchDiff: () => Promise<void>;
  exportSnapshot: () => Promise<GitSyncSnapshot>;
  fetchRemote: () => Promise<void>;
  pullRemote: () => Promise<void>;
  pushRemote: () => Promise<void>;
  commitSnapshot: (message: string) => Promise<void>;
  runSync: () => Promise<void>;
}

const DEFAULT_STATUS: GitSyncStatus = {
  configured: false,
  has_local_changes: false,
  has_remote_changes: false,
  ahead: 0,
  behind: 0,
  changed_files: [],
};

const DEFAULT_DIFF: GitSyncDiff = {
  staged: "",
  unstaged: "",
};

export const useGitSyncStore = create<GitSyncState>((set, get) => ({
  status: DEFAULT_STATUS,
  diff: DEFAULT_DIFF,
  isLoading: false,
  actionOutput: null,
  error: null,

  fetchStatus: async () => {
    set({ isLoading: true, error: null });
    try {
      const status = await invoke<GitSyncStatus>("git_sync_status");
      set({ status, isLoading: false });
    } catch (error) {
      set({ error: String(error), isLoading: false });
    }
  },

  fetchDiff: async () => {
    set({ isLoading: true, error: null });
    try {
      const diff = await invoke<GitSyncDiff>("git_sync_diff");
      set({ diff, isLoading: false });
      await get().fetchStatus();
    } catch (error) {
      set({ error: String(error), isLoading: false, diff: DEFAULT_DIFF });
    }
  },

  exportSnapshot: async () => {
    set({ isLoading: true, error: null, actionOutput: null });
    try {
      const snapshot = await invoke<GitSyncSnapshot>("git_sync_export_snapshot");
      set({
        isLoading: false,
        actionOutput: `Exported ${snapshot.exported_files.join(", ")} to ${snapshot.repo_path}`,
      });
      await Promise.all([get().fetchStatus(), get().fetchDiff()]);
      return snapshot;
    } catch (error) {
      set({ error: String(error), isLoading: false });
      throw error;
    }
  },

  fetchRemote: async () => {
    set({ isLoading: true, error: null, actionOutput: null });
    try {
      const result = await invoke<{ stdout: string; stderr: string }>("git_sync_fetch");
      set({ isLoading: false, actionOutput: [result.stdout, result.stderr].filter(Boolean).join("\n") || "Fetch complete." });
      await get().fetchStatus();
    } catch (error) {
      set({ error: String(error), isLoading: false });
      throw error;
    }
  },

  pullRemote: async () => {
    set({ isLoading: true, error: null, actionOutput: null });
    try {
      const result = await invoke<{ stdout: string; stderr: string }>("git_sync_pull");
      set({ isLoading: false, actionOutput: [result.stdout, result.stderr].filter(Boolean).join("\n") || "Pull complete." });
      await Promise.all([get().fetchStatus(), get().fetchDiff()]);
    } catch (error) {
      set({ error: String(error), isLoading: false });
      throw error;
    }
  },

  pushRemote: async () => {
    set({ isLoading: true, error: null, actionOutput: null });
    try {
      const result = await invoke<{ stdout: string; stderr: string }>("git_sync_push");
      set({ isLoading: false, actionOutput: [result.stdout, result.stderr].filter(Boolean).join("\n") || "Push complete." });
      await Promise.all([get().fetchStatus(), get().fetchDiff()]);
    } catch (error) {
      set({ error: String(error), isLoading: false });
      throw error;
    }
  },

  commitSnapshot: async (message) => {
    set({ isLoading: true, error: null, actionOutput: null });
    try {
      const result = await invoke<{ stdout: string; stderr: string }>("git_sync_commit", {
        input: { message },
      });
      set({ isLoading: false, actionOutput: [result.stdout, result.stderr].filter(Boolean).join("\n") || "Commit complete." });
      await Promise.all([get().fetchStatus(), get().fetchDiff()]);
    } catch (error) {
      set({ error: String(error), isLoading: false });
      throw error;
    }
  },

  runSync: async () => {
    set({ isLoading: true, error: null, actionOutput: null });
    try {
      const result = await invoke<GitSyncRunResult>("git_sync_run");
      set({
        isLoading: false,
        actionOutput: [...result.steps, result.output.stdout].filter(Boolean).join("\n"),
      });
      await Promise.all([get().fetchStatus(), get().fetchDiff()]);
    } catch (error) {
      set({ error: String(error), isLoading: false });
      throw error;
    }
  },
}));
