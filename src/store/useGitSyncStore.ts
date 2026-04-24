import { create } from "zustand";
import { invoke } from "@/lib/tauri";
import { GitSyncActionResult, GitSyncDiff, GitSyncRunResult, GitSyncSnapshot, GitSyncStatus } from "@/types";
import { runAsync, runAsyncRethrow } from "@/lib/asyncAction";

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

/**
 * Audit-4 Dup H1: collapse the duplicated stdout/stderr formatting that
 * appeared in fetchRemote/pullRemote/pushRemote/commitSnapshot.
 */
function formatGitOutput(
  result: GitSyncActionResult,
  fallback: string,
): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n") || fallback;
}

export const useGitSyncStore = create<GitSyncState>((set, get) => ({
  status: DEFAULT_STATUS,
  diff: DEFAULT_DIFF,
  isLoading: false,
  actionOutput: null,
  error: null,

  // Audit-4 Dup H1: actions that the caller awaits and reacts to
  // (fetchRemote, pull, push, commit, run, exportSnapshot) use
  // runAsyncRethrow. Pure refresh actions (fetchStatus, fetchDiff)
  // use runAsync.
  fetchStatus: () =>
    runAsync(set, async () => {
      const status = await invoke<GitSyncStatus>("git_sync_status");
      set({ status });
    }).then(() => undefined),

  fetchDiff: () =>
    runAsync(set, async () => {
      const diff = await invoke<GitSyncDiff>("git_sync_diff");
      set({ diff });
      await get().fetchStatus();
    }).then(() => undefined),

  exportSnapshot: () =>
    runAsyncRethrow(set, async () => {
      set({ actionOutput: null });
      const snapshot = await invoke<GitSyncSnapshot>("git_sync_export_snapshot");
      set({
        actionOutput: `Exported ${snapshot.exported_files.join(", ")} to ${snapshot.repo_path}`,
      });
      await Promise.all([get().fetchStatus(), get().fetchDiff()]);
      return snapshot;
    }),

  fetchRemote: () =>
    runAsyncRethrow(set, async () => {
      set({ actionOutput: null });
      const result = await invoke<GitSyncActionResult>("git_sync_fetch");
      set({ actionOutput: formatGitOutput(result, "Fetch complete.") });
      await get().fetchStatus();
    }),

  pullRemote: () =>
    runAsyncRethrow(set, async () => {
      set({ actionOutput: null });
      const result = await invoke<GitSyncActionResult>("git_sync_pull");
      set({ actionOutput: formatGitOutput(result, "Pull complete.") });
      await Promise.all([get().fetchStatus(), get().fetchDiff()]);
    }),

  pushRemote: () =>
    runAsyncRethrow(set, async () => {
      set({ actionOutput: null });
      const result = await invoke<GitSyncActionResult>("git_sync_push");
      set({ actionOutput: formatGitOutput(result, "Push complete.") });
      await Promise.all([get().fetchStatus(), get().fetchDiff()]);
    }),

  commitSnapshot: (message) =>
    runAsyncRethrow(set, async () => {
      set({ actionOutput: null });
      const result = await invoke<GitSyncActionResult>("git_sync_commit", {
        input: { message },
      });
      set({ actionOutput: formatGitOutput(result, "Commit complete.") });
      await Promise.all([get().fetchStatus(), get().fetchDiff()]);
    }),

  runSync: () =>
    runAsyncRethrow(set, async () => {
      set({ actionOutput: null });
      const result = await invoke<GitSyncRunResult>("git_sync_run");
      set({
        actionOutput: [...result.steps, result.output.stdout].filter(Boolean).join("\n"),
      });
      await Promise.all([get().fetchStatus(), get().fetchDiff()]);
    }),
}));
