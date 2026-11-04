import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@/lib/tauri";
import { useGitSyncStore } from "@/store/useGitSyncStore";

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);

const STATUS = { configured: true, has_local_changes: true, has_remote_changes: true, ahead: 0, behind: 1, changed_files: [] };
const runResult = (discard_needed: string[]) => ({
  steps: discard_needed.length ? ["Fetched origin"] : ["Pulled 1 commit(s) from origin/main"],
  output: { stdout: "", stderr: "", status: 0 },
  discard_needed,
});

function answerRun(discard_needed: string[]) {
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "git_sync_run") return runResult(discard_needed);
    if (command === "git_sync_status") return STATUS;
    if (command === "git_sync_diff") return { staged: "", unstaged: "" };
    throw new Error(`unexpected ${command}`);
  });
}

const called = (command: string) => invokeMock.mock.calls.some(([name]) => name === command);

describe("useGitSyncStore.runSync", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useGitSyncStore.setState({ discardNeeded: [], actionOutput: null, error: null });
  });

  it("does not agree to a discard by itself", async () => {
    answerRun([]);
    await useGitSyncStore.getState().runSync();
    expect(invokeMock).toHaveBeenCalledWith("git_sync_run", { input: { discard_agreed: false } });
  });

  // git_sync_diff exports the snapshot, which writes over a hand edit.
  it("waits for an answer without exporting over the files in question", async () => {
    answerRun([".ssix-sync/README.md"]);
    await useGitSyncStore.getState().runSync();
    const state = useGitSyncStore.getState();
    expect(state.discardNeeded).toEqual([".ssix-sync/README.md"]);
    expect(state.actionOutput).toBeNull();
    expect(state.error).toBeNull();
    expect(called("git_sync_status")).toBe(true);
    expect(called("git_sync_diff")).toBe(false);
  });

  it("passes the agreement on and clears the question once synced", async () => {
    useGitSyncStore.setState({ discardNeeded: [".ssix-sync/README.md"] });
    answerRun([]);
    await useGitSyncStore.getState().runSync(true);
    expect(invokeMock).toHaveBeenCalledWith("git_sync_run", { input: { discard_agreed: true } });
    const state = useGitSyncStore.getState();
    expect(state.discardNeeded).toEqual([]);
    expect(state.actionOutput).toContain("Pulled 1 commit");
    expect(called("git_sync_diff")).toBe(true);
  });

  it("declining calls nothing", () => {
    useGitSyncStore.setState({ discardNeeded: [".ssix-sync/README.md"] });
    useGitSyncStore.getState().declineDiscard();
    expect(useGitSyncStore.getState().discardNeeded).toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
