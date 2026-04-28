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
    // Audit-3 P2#6: the diff is now a <pre> region (not a textarea),
    // so it's queried by region role + label.
    const unstaged = screen.getByRole("region", { name: /unstaged/i });
    expect(unstaged.textContent).toMatch(/diff --git/);
    expect(screen.getByPlaceholderText(/sync ssx config snapshot/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sync/i })).toBeInTheDocument();
  });

  it("invokes the consolidated runSync action when Sync is clicked", async () => {
    const runSync = vi.fn().mockResolvedValue(undefined);
    useGitSyncStore.setState({ runSync });
    render(<GitSyncView />);
    fireEvent.click(screen.getByRole("button", { name: /^sync$/i }));
    await waitFor(() => expect(runSync).toHaveBeenCalledTimes(1));
  });

  it("does not render separate Fetch / Pull / Push toolbar buttons", () => {
    // The toolbar collapses fetch + pull + push into a single Sync action.
    // Asserting their absence guards against accidental re-introduction.
    render(<GitSyncView />);
    expect(screen.queryByRole("button", { name: /^fetch$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^pull$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^push$/i })).toBeNull();
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
    // shadcn 4.5 (new-york-v4) uses arbitrary `ring-[3px]` for the
    // focus ring; this regex matches both the old `ring-2` and the
    // new `ring-[3px]` so the assertion still pins the shared Input.
    expect(field.className).toMatch(/focus-visible:ring-(?:2|\[3px\])/);
  });

  /*
   * Audit-3 P2#6: the diff blocks must be semantic <pre> regions, NOT
   * <textarea readOnly>. The textarea variant grabbed focus, polluted
   * the right-click menu with form-control options, and was announced
   * by AT as "edit text, read-only" rather than as a code block.
   * Tests pin: (a) <pre> tag, (b) role=region with labelled name,
   * (c) keyboard-focusable so screen-reader users can land on it,
   * (d) NO <textarea> survives anywhere in the diff section.
   */
  it("diff blocks are semantic <pre> regions, not textareas", () => {
    render(<GitSyncView />);
    const unstaged = screen.getByRole("region", { name: /unstaged/i });
    const staged = screen.getByRole("region", { name: /^staged$/i });
    expect(unstaged.tagName).toBe("PRE");
    expect(staged.tagName).toBe("PRE");
    // Keyboard-reachable so AT can announce label + content.
    expect(unstaged).toHaveAttribute("tabindex", "0");
    expect(staged).toHaveAttribute("tabindex", "0");
    // No <textarea> should remain in the document.
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("renders the empty-state placeholder when there is no diff text", () => {
    useGitSyncStore.setState({ diff: { staged: "", unstaged: "" } });
    render(<GitSyncView />);
    const unstaged = screen.getByRole("region", { name: /unstaged/i });
    const staged = screen.getByRole("region", { name: /^staged$/i });
    expect(unstaged.textContent).toMatch(/no unstaged changes/i);
    expect(staged.textContent).toMatch(/no staged changes/i);
  });

  /*
   * Audit-3 follow-up P1#3: every git operation runs against the
   * filesystem and possibly the network. AT users need:
   *  • A live region for the post-action info banner (actionOutput).
   *  • A separate live region for fatal errors that interrupts.
   *  • aria-busy on every toolbar button while isLoading.
   */
  it("actionOutput renders inside role=status + aria-live=polite", () => {
    useGitSyncStore.setState({ actionOutput: "Pulled 3 commits from origin/main" });
    render(<GitSyncView />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveAttribute("aria-atomic", "true");
    expect(status.textContent).toMatch(/Pulled 3 commits/);
  });

  it("error renders inside role=alert + aria-live=assertive", () => {
    useGitSyncStore.setState({ error: "remote: rejected" });
    render(<GitSyncView />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("aria-live", "assertive");
    expect(alert.textContent).toMatch(/remote: rejected/);
  });

  it("Sync toolbar button carries aria-busy while a sync is running", () => {
    // After collapsing the toolbar to a single bidirectional Sync action,
    // there is only one button to assert against — but the aria-busy
    // contract still matters: AT users need to know the action is in
    // flight before the result banner / error region updates.
    useGitSyncStore.setState({ isLoading: true });
    render(<GitSyncView />);
    const btn = screen.getByRole("button", { name: /^sync$/i });
    expect(btn).toHaveAttribute("aria-busy", "true");
  });
});
