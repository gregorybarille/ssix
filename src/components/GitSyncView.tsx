import React, { useEffect } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Separator } from "./ui/separator";
import { Badge } from "./ui/badge";
import { ConfirmDialog } from "./ConfirmDialog";
import { useGitSyncStore } from "@/store/useGitSyncStore";
import { GitBranch, RefreshCcw, Download, Upload, FileDiff, WandSparkles } from "lucide-react";

export function GitSyncView() {
  const [commitMessage, setCommitMessage] = React.useState("");
  const [confirmPullOpen, setConfirmPullOpen] = React.useState(false);
  const [confirmPushOpen, setConfirmPushOpen] = React.useState(false);
  const {
    status,
    diff,
    error,
    actionOutput,
    isLoading,
    fetchStatus,
    fetchDiff,
    exportSnapshot,
    fetchRemote,
    pullRemote,
    pushRemote,
    commitSnapshot,
    runSync,
  } = useGitSyncStore();

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <h1 className="text-lg font-semibold flex items-center gap-2">
          <GitBranch className="h-5 w-5" />
          Git Sync
        </h1>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => void runSync()} disabled={isLoading || !status.configured}>
            <WandSparkles className="h-4 w-4 mr-1" />
            Sync
          </Button>
          <Button size="sm" variant="outline" onClick={() => void fetchRemote()} disabled={isLoading}>
            <RefreshCcw className="h-4 w-4 mr-1" />
            Fetch
          </Button>
          <Button size="sm" variant="outline" onClick={() => setConfirmPullOpen(true)} disabled={isLoading || !status.configured}>
            <Download className="h-4 w-4 mr-1" />
            Pull
          </Button>
          <Button size="sm" onClick={() => setConfirmPushOpen(true)} disabled={isLoading || !status.configured}>
            <Upload className="h-4 w-4 mr-1" />
            Push
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {!status.configured ? (
          <div className="rounded-lg border p-4 text-sm text-muted-foreground">
            Configure `git_sync_repo_path` in Settings to enable sanitized sync.
          </div>
        ) : (
          <>
            <div className="rounded-lg border p-4 space-y-3">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <p className="text-sm font-medium">Repository</p>
                  <p className="text-xs text-muted-foreground">{status.repo_path}</p>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  {status.branch && <Badge variant="secondary">{status.branch}</Badge>}
                  {status.remote && <Badge variant="outline">{status.remote}</Badge>}
                  {status.has_local_changes && <Badge variant="secondary">Local changes</Badge>}
                  {status.has_remote_changes && <Badge variant="secondary">Remote updates</Badge>}
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Ahead {status.ahead} · Behind {status.behind}
              </p>
              <div className="flex gap-2 flex-wrap">
                <Button variant="outline" size="sm" onClick={() => void exportSnapshot()} disabled={isLoading}>
                  Export sanitized snapshot
                </Button>
                <Button variant="outline" size="sm" onClick={() => void fetchDiff()} disabled={isLoading}>
                  <FileDiff className="h-4 w-4 mr-1" />
                  Refresh diff
                </Button>
              </div>
              <div className="space-y-2">
                <Label htmlFor="git-commit-message" className="text-xs font-medium">
                  Commit message
                </Label>
                <div className="flex gap-2">
                  <Input
                    id="git-commit-message"
                    placeholder="sync ssx config snapshot"
                    value={commitMessage}
                    onChange={(e) => setCommitMessage(e.target.value)}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void commitSnapshot(commitMessage)}
                    disabled={isLoading || !commitMessage.trim()}
                  >
                    Commit
                  </Button>
                </div>
              </div>
            </div>

            <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
              <section className="rounded-lg border p-4 space-y-3">
                <h2 className="text-sm font-medium">Changed files</h2>
                {status.changed_files.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No local changes in the exported snapshot.</p>
                ) : (
                  <div className="space-y-1 text-xs font-mono">
                    {status.changed_files.map((file) => (
                      <div key={file}>{file}</div>
                    ))}
                  </div>
                )}
              </section>

              <section className="rounded-lg border overflow-hidden">
                <div className="px-4 py-3 border-b border-border">
                  <h2 className="text-sm font-medium">Exact diff</h2>
                  <p className="text-xs text-muted-foreground">
                    Tracks only the sanitized export under `.ssx-sync/`.
                  </p>
                </div>
                <div className="p-4 space-y-4">
                  {/*
                    Audit-3 P2#6: the diff is *text content meant to be
                    read and copied*, not an editable form field. The
                    previous <Textarea readOnly> still grabbed focus,
                    polluted the right-click menu with form-control
                    options ("Spelling and Grammar", "Substitutions"),
                    and was announced by AT as "edit text, read-only"
                    rather than as a code block. <pre> + role=region +
                    aria-label is the correct semantic, keeps text
                    selection + copy intact, and uses font-mono so
                    diffs align column-wise.

                    `tabIndex=0` keeps the block keyboard-reachable so
                    screen-reader users can land on it and have AT
                    announce its label and contents (a non-focusable
                    block is invisible to keyboard navigation).
                    `whitespace-pre` preserves diff column alignment
                    without wrapping; `overflow-auto` gives a horizontal
                    scrollbar for long lines instead of clipping.
                  */}
                  <div>
                    <p id="git-diff-unstaged-label" className="text-xs font-medium mb-2">
                      Unstaged
                    </p>
                    <pre
                      role="region"
                      aria-labelledby="git-diff-unstaged-label"
                      tabIndex={0}
                      className="min-h-[220px] max-h-[400px] overflow-auto rounded-md border border-input bg-background px-3 py-2 text-sm font-mono whitespace-pre focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    >
                      {diff.unstaged || "No unstaged changes."}
                    </pre>
                  </div>
                  <Separator />
                  <div>
                    <p id="git-diff-staged-label" className="text-xs font-medium mb-2">
                      Staged
                    </p>
                    <pre
                      role="region"
                      aria-labelledby="git-diff-staged-label"
                      tabIndex={0}
                      className="min-h-[220px] max-h-[400px] overflow-auto rounded-md border border-input bg-background px-3 py-2 text-sm font-mono whitespace-pre focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    >
                      {diff.staged || "No staged changes."}
                    </pre>
                  </div>
                </div>
              </section>
            </div>

            {actionOutput && (
              <div className="rounded-md border p-3 text-xs font-mono whitespace-pre-wrap">
                {actionOutput}
              </div>
            )}
          </>
        )}

        {error && (
          <div className="rounded-md bg-destructive/10 text-destructive text-sm px-3 py-2">
            {error}
          </div>
        )}
      </div>

      {/*
       * Pull and Push touch local OR remote git history with no
       * built-in undo. Gate them behind a confirmation so a misclick
       * on the Git Sync toolbar can't silently fast-forward, merge,
       * or overwrite. Pull is "default" variant (potentially data-
       * losing locally if there are uncommitted changes); Push is
       * "destructive" because it mutates the shared remote.
       */}
      <ConfirmDialog
        open={confirmPullOpen}
        onOpenChange={setConfirmPullOpen}
        title="Pull from remote?"
        description={
          <>
            This fetches{status.remote ? ` ${status.remote}` : " the remote"}
            {status.branch ? ` and merges into ${status.branch}` : ""}. Local
            uncommitted changes in the sanitized snapshot may be overwritten.
          </>
        }
        confirmLabel="Pull"
        onConfirm={() => pullRemote()}
      />
      <ConfirmDialog
        open={confirmPushOpen}
        onOpenChange={setConfirmPushOpen}
        title="Push to remote?"
        description={
          <>
            This publishes your local commits
            {status.remote ? ` to ${status.remote}` : ""}
            {status.branch ? ` (${status.branch})` : ""}. Other clones of this
            repository will pick up the change on their next pull.
          </>
        }
        confirmLabel="Push"
        variant="destructive"
        onConfirm={() => pushRemote()}
      />
    </div>
  );
}
