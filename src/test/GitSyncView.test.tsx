import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { GitSyncView } from "@/components/GitSyncView";
import { useGitSyncStore } from "@/store/useGitSyncStore";

describe("GitSyncView", () => {
  beforeEach(() => {
    useGitSyncStore.setState({
      status: {
        configured: true,
        repo_path: "/tmp/repo",
        branch: "main",
        remote: "origin",
        has_local_changes: true,
        has_remote_changes: true,
        ahead: 1,
        behind: 2,
        changed_files: [".ssx-sync/data.json"],
      },
      diff: { staged: "", unstaged: "diff --git a/.ssx-sync/data.json b/.ssx-sync/data.json" },
      isLoading: false,
      actionOutput: null,
      error: null,
      fetchStatus: vi.fn().mockResolvedValue(undefined),
      fetchDiff: vi.fn().mockResolvedValue(undefined),
      exportSnapshot: vi.fn().mockResolvedValue({ repo_path: "/tmp/repo", exported_files: [] }),
      fetchRemote: vi.fn().mockResolvedValue(undefined),
      pullRemote: vi.fn().mockResolvedValue(undefined),
      pushRemote: vi.fn().mockResolvedValue(undefined),
      commitSnapshot: vi.fn().mockResolvedValue(undefined),
      runSync: vi.fn().mockResolvedValue(undefined),
    });
  });

  it("renders repository status and diff", () => {
    render(<GitSyncView />);
    expect(screen.getByText("Git Sync")).toBeInTheDocument();
    expect(screen.getByText("Local changes")).toBeInTheDocument();
    expect(screen.getByDisplayValue(/diff --git/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/sync ssx config snapshot/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sync/i })).toBeInTheDocument();
  });
});
