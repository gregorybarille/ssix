import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
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

  it("requires confirmation before pulling from the remote", async () => {
    const pullRemote = vi.fn().mockResolvedValue(undefined);
    useGitSyncStore.setState({ pullRemote });
    render(<GitSyncView />);

    fireEvent.click(screen.getByRole("button", { name: /^pull$/i }));
    // The store action should NOT have fired yet — only the dialog opened.
    expect(pullRemote).not.toHaveBeenCalled();

    // Confirm dialog should be present with cancel focused (not pull).
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/pull from remote/i);
    expect(document.activeElement).toHaveTextContent(/cancel/i);

    // Confirm; the store action runs exactly once and the dialog closes.
    fireEvent.click(
      screen.getAllByRole("button", { name: /^pull$/i }).slice(-1)[0],
    );
    await waitFor(() => expect(pullRemote).toHaveBeenCalledTimes(1));
  });

  it("requires confirmation before pushing to the remote", async () => {
    const pushRemote = vi.fn().mockResolvedValue(undefined);
    useGitSyncStore.setState({ pushRemote });
    render(<GitSyncView />);

    fireEvent.click(screen.getByRole("button", { name: /^push$/i }));
    expect(pushRemote).not.toHaveBeenCalled();

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/push to remote/i);
    expect(document.activeElement).toHaveTextContent(/cancel/i);

    fireEvent.click(
      screen.getAllByRole("button", { name: /^push$/i }).slice(-1)[0],
    );
    await waitFor(() => expect(pushRemote).toHaveBeenCalledTimes(1));
  });

  it("cancelling the pull confirmation does not invoke the store action", async () => {
    const pullRemote = vi.fn().mockResolvedValue(undefined);
    useGitSyncStore.setState({ pullRemote });
    render(<GitSyncView />);

    fireEvent.click(screen.getByRole("button", { name: /^pull$/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      // The cancel button is the only "Cancel" labelled control.
      within(dialog).getByRole("button", { name: /cancel/i }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(pullRemote).not.toHaveBeenCalled();
  });

  /*
   * P2-A5: the commit-message field used a hand-rolled <input> with
   * its own className. Asserting against the shared <Input>'s
   * focus-visible:ring-2 class catches a future regression that
   * silently bypasses theme tokens / focus rings.
   */
  it("commit message field uses the shared <Input> primitive (focus-ring class present)", () => {
    render(<GitSyncView />);
    const field = screen.getByLabelText(/commit message/i);
    expect(field.className).toMatch(/focus-visible:ring-2/);
  });
});
