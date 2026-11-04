import { create } from "zustand";
import { invoke } from "@/lib/tauri";
import { GitSyncActionResult, GitSyncCommitInput, GitSyncDiff, GitSyncRunInput, GitSyncRunResult, GitSyncSnapshot, GitSyncStatus } from "@/types";
import { runAsync, runAsyncRethrow } from "@/lib/asyncAction";

interface GitSyncState {
  status: GitSyncStatus;
  diff: GitSyncDiff;
  isLoading: boolean;
  actionOutput: string | null;
  error: string | null;
  /** Files whose edits an action would lose: non-empty while it waits for the user's answer. */
  atRisk: string[];
  /** Reruns the action that stopped, with the user's agreement. */
  rerunAgreed: ((agreed: string[]) => Promise<unknown>) | null;
  fetchStatus: () => Promise<void>;
  fetchDiff: () => Promise<void>;
  /** `agreed`, here and below: the files the user agreed to lose edits in. */
  exportSnapshot: (agreed?: string[]) => Promise<GitSyncSnapshot>;
  commitSnapshot: (message: string, agreed?: string[]) => Promise<void>;
  runSync: (agreed?: string[]) => Promise<void>;
  confirmAtRisk: () => Promise<void>;
  declineAtRisk: () => void;
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
  at_risk: [],
};

function formatGitOutput(
  result: GitSyncActionResult,
  fallback: string,
): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n") || fallback;
}

/** Records the backend's answer; true when the action stopped to ask and changed nothing. */
async function stoppedToAsk(atRisk: string[], rerunAgreed: GitSyncState["rerunAgreed"]) {
  useGitSyncStore.setState({ atRisk, rerunAgreed });
  if (atRisk.length === 0) return false;
  // Not fetchDiff: it exports the files not in question, and Cancel promises nothing changed.
  await useGitSyncStore.getState().fetchStatus();
  return true;
}

export const useGitSyncStore = create<GitSyncState>((set, get) => ({
  status: DEFAULT_STATUS,
  diff: DEFAULT_DIFF,
  isLoading: false,
  actionOutput: null,
  error: null,
  atRisk: [],
  rerunAgreed: null,

  // Audit-4 Dup H1: actions that the caller awaits and reacts to
  // (commit, run, exportSnapshot) use
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

  exportSnapshot: (agreed = []) =>
    runAsyncRethrow(set, async () => {
      set({ actionOutput: null });
      const input: GitSyncRunInput = { agreed };
      const snapshot = await invoke<GitSyncSnapshot>("git_sync_export_snapshot", { input });
      if (await stoppedToAsk(snapshot.at_risk, get().exportSnapshot)) return snapshot;
      set({
        actionOutput: `Exported ${snapshot.exported_files.join(", ")} to ${snapshot.repo_path}`,
      });
      await Promise.all([get().fetchStatus(), get().fetchDiff()]);
      return snapshot;
    }),

  commitSnapshot: (message, agreed = []) =>
    runAsyncRethrow(set, async () => {
      set({ actionOutput: null });
      const input: GitSyncCommitInput = { message, agreed };
      const result = await invoke<GitSyncRunResult>("git_sync_commit", { input });
      const rerun = (nowAgreed: string[]) => get().commitSnapshot(message, nowAgreed);
      if (await stoppedToAsk(result.at_risk, rerun)) return;
      set({ actionOutput: formatGitOutput(result.output, "Commit complete.") });
      await Promise.all([get().fetchStatus(), get().fetchDiff()]);
    }),

  runSync: (agreed = []) =>
    runAsyncRethrow(set, async () => {
      set({ actionOutput: null });
      const input: GitSyncRunInput = { agreed };
      const result = await invoke<GitSyncRunResult>("git_sync_run", { input });
      if (await stoppedToAsk(result.at_risk, get().runSync)) return;
      set({
        actionOutput: [...result.steps, result.output.stdout].filter(Boolean).join("\n"),
      });
      await Promise.all([get().fetchStatus(), get().fetchDiff()]);
    }),

  confirmAtRisk: async () => {
    const { atRisk, rerunAgreed } = get();
    await rerunAgreed?.(atRisk);
  },

  declineAtRisk: () => set({ atRisk: [], rerunAgreed: null }),
}));
