import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@/lib/tauri";
import { useGitSyncStore } from "@/store/useGitSyncStore";

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);

const STATUS = { configured: true, has_local_changes: true, has_remote_changes: true, ahead: 0, behind: 1, changed_files: [] };
const runResult = (at_risk: string[]) => ({
  steps: at_risk.length ? ["Fetched origin"] : ["Pulled 1 commit(s) from origin/main"],
  output: { stdout: at_risk.length ? "" : "committed", stderr: "", status: 0 },
  at_risk,
});
const README = ".ssix-sync/README.md";

function answerRun(at_risk: string[]) {
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "git_sync_run" || command === "git_sync_commit") return runResult(at_risk);
    if (command === "git_sync_export_snapshot") {
      return { repo_path: "/repo", exported_files: at_risk.length ? [] : [README], at_risk };
    }
    if (command === "git_sync_status") return STATUS;
    if (command === "git_sync_diff") return { staged: "", unstaged: "", at_risk: [] };
    throw new Error(`unexpected ${command}`);
  });
}

const called = (command: string) => invokeMock.mock.calls.some(([name]) => name === command);

describe("useGitSyncStore agreement", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useGitSyncStore.setState({ atRisk: [], rerunAgreed: null, actionOutput: null, error: null });
  });

  // Each action that overwrites: the command it calls and its input, agreed or not.
  const ACTIONS = [
    {
      name: "Sync",
      start: () => useGitSyncStore.getState().runSync(),
      command: "git_sync_run",
      input: (agreed: string[]) => ({ agreed }),
    },
    {
      name: "Export",
      start: () => useGitSyncStore.getState().exportSnapshot(),
      command: "git_sync_export_snapshot",
      input: (agreed: string[]) => ({ agreed }),
    },
    {
      name: "Commit",
      start: () => useGitSyncStore.getState().commitSnapshot("my message"),
      command: "git_sync_commit",
      input: (agreed: string[]) => ({ message: "my message", agreed }),
    },
  ];

  describe.each(ACTIONS)("$name", ({ start, command, input }) => {
    it("does not agree to anything by itself", async () => {
      answerRun([]);
      await start();
      expect(invokeMock).toHaveBeenCalledWith(command, { input: input([]) });
    });

    // git_sync_diff exports the files not in question, and Cancel promises nothing changed.
    it("waits for an answer without exporting anything", async () => {
      answerRun([README]);
      await start();
      const state = useGitSyncStore.getState();
      expect(state.atRisk).toEqual([README]);
      expect(state.actionOutput).toBeNull();
      expect(state.error).toBeNull();
      expect(called("git_sync_status")).toBe(true);
      expect(called("git_sync_diff")).toBe(false);
    });

    it("confirming reruns the same action with the listed files, then clears the question", async () => {
      answerRun([README]);
      await start();
      answerRun([]);
      await useGitSyncStore.getState().confirmAtRisk();
      expect(invokeMock).toHaveBeenCalledWith(command, { input: input([README]) });
      const state = useGitSyncStore.getState();
      expect(state.atRisk).toEqual([]);
      expect(state.actionOutput).toBeTruthy();
      expect(called("git_sync_diff")).toBe(true);
    });

    it("a rerun that finds another file asks again about all of them", async () => {
      answerRun([README]);
      await start();
      answerRun([README, ".ssix-sync/data.json"]);
      await useGitSyncStore.getState().confirmAtRisk();
      expect(useGitSyncStore.getState().atRisk).toEqual([README, ".ssix-sync/data.json"]);
      expect(called("git_sync_diff")).toBe(false);
    });
  });

  it("declining calls nothing and leaves no question or error", () => {
    useGitSyncStore.setState({ atRisk: [README], rerunAgreed: vi.fn() });
    useGitSyncStore.getState().declineAtRisk();
    const state = useGitSyncStore.getState();
    expect(state.atRisk).toEqual([]);
    expect(state.rerunAgreed).toBeNull();
    expect(state.error).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("a refresh keeps what the backend held back, and asks nothing", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "git_sync_diff") return { staged: "", unstaged: "edit", at_risk: [README] };
      if (command === "git_sync_status") return STATUS;
      throw new Error(`unexpected ${command}`);
    });
    await useGitSyncStore.getState().fetchDiff();
    const state = useGitSyncStore.getState();
    expect(state.diff.at_risk).toEqual([README]);
    expect(state.atRisk).toEqual([]);
  });
});
