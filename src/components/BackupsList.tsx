import React, { useEffect } from "react";
import { History, Trash2 } from "lucide-react";
import { BackupInfo, BackupReason } from "@/types";
import { useBackupsStore } from "@/store/useBackupsStore";
import { errorMessage } from "@/lib/errors";
import { Button } from "./ui/button";
import { ConfirmDialog } from "./ConfirmDialog";
import { ErrorBanner } from "./ui/error-banner";

const REASON_LABELS: Record<BackupReason, string> = {
  manual: "Manual",
  automatic: "Automatic",
  before_restore: "Before restore",
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString();
}

/**
 * The archives in `~/.ssix/backups`, newest first, with "Back up now",
 * restore and delete. Restore and delete always go through a confirm.
 */
export function BackupsList() {
  const { dir, backups, error, fetchBackups, createBackup, restoreBackup, deleteBackup } =
    useBackupsStore();
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [restoring, setRestoring] = React.useState<BackupInfo | null>(null);
  const [deleting, setDeleting] = React.useState<BackupInfo | null>(null);

  useEffect(() => {
    void fetchBackups();
  }, [fetchBackups]);

  const backUpNow = async () => {
    setBusy(true);
    setNotice(null);
    setActionError(null);
    try {
      const created = await createBackup();
      setNotice(`Backed up as ${created.name}.`);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const confirmRestore = async () => {
    if (!restoring) return;
    const previous = await restoreBackup(restoring.name);
    setActionError(null);
    setNotice(
      previous
        ? `Restored the backup from ${formatDate(restoring.created_at)}. What it replaced is saved as ${previous.name}.`
        : `Restored the backup from ${formatDate(restoring.created_at)}.`,
    );
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    await deleteBackup(deleting.name);
    setNotice(null);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={backUpNow}
          disabled={busy}
          data-testid="backup-create"
        >
          <History aria-hidden="true" className="h-3.5 w-3.5" />
          {busy ? "Backing up…" : "Back up now"}
        </Button>
        {notice && (
          <p role="status" className="text-xs text-muted-foreground" data-testid="backup-notice">
            {notice}
          </p>
        )}
      </div>
      {actionError && (
        <p role="alert" className="text-sm text-destructive" data-testid="backup-error">
          {actionError}
        </p>
      )}
      {error && <ErrorBanner message={error} onRetry={fetchBackups} />}
      {dir && (
        <p className="text-xs text-muted-foreground-soft break-all">
          Stored in <code>{dir}</code>
        </p>
      )}

      {backups.length === 0 ? (
        <p className="text-xs text-muted-foreground">No backups yet.</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border" aria-label="Backups">
          {backups.map((backup) => (
            <li
              key={backup.name}
              className="flex items-center justify-between gap-3 px-3 py-2"
              data-testid="backup-row"
              data-name={backup.name}
              data-reason={backup.reason ?? ""}
            >
              <div className="min-w-0 space-y-0.5">
                <div className="text-sm">{formatDate(backup.created_at)}</div>
                {backup.error ? (
                  <div className="text-xs text-destructive">{backup.error}</div>
                ) : (
                  <div className="text-xs text-muted-foreground-soft">
                    {backup.reason ? REASON_LABELS[backup.reason] : "Unknown"} ·{" "}
                    {formatSize(backup.size)}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {!backup.error && (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => setRestoring(backup)}
                    data-testid="backup-restore"
                    aria-label={`Restore the backup from ${formatDate(backup.created_at)}`}
                  >
                    Restore
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-destructive hover:text-destructive"
                  onClick={() => setDeleting(backup)}
                  data-testid="backup-delete"
                  aria-label={`Delete the backup from ${formatDate(backup.created_at)}`}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={!!restoring}
        onOpenChange={(open) => !open && setRestoring(null)}
        title="Restore this backup?"
        description={
          restoring && (
            <>
              Your connections, credentials, settings and known hosts are replaced
              by the ones saved on {formatDate(restoring.created_at)}. What they
              replace is backed up first, so you can restore it from this list.
            </>
          )
        }
        confirmLabel="Restore"
        onConfirm={confirmRestore}
        testId="backup-restore-dialog"
      />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete this backup?"
        description={deleting && <>The backup from {formatDate(deleting.created_at)} is deleted for good.</>}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={confirmDelete}
        testId="backup-delete-dialog"
      />
    </div>
  );
}
