import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "../ui/button";
import { ErrorBanner } from "../ui/error-banner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { ConfirmDialog } from "../ConfirmDialog";
import { formatModified, formatSize } from "@/lib/sftp";
import { useSftpStore, type EditState } from "@/store/useSftpStore";

/** How often to look at the temporary copy for the editor's changes. */
const POLL_MS = 2_000;

function statusLine(edit: EditState): string {
  if (edit.missing) return "The temporary copy is gone, so there is nothing left to upload.";
  if (edit.saving) return "Uploading…";
  if (edit.modified) return "Changed in your editor, not uploaded yet.";
  if (edit.savedAt) return "Uploaded. The server has your latest changes.";
  return "No changes yet.";
}

function remoteChangeText(change: NonNullable<EditState["remoteChange"]>): string {
  if (change.deleted) {
    return "The file was deleted on the server after you opened it. Overwriting creates it again from your copy.";
  }
  const when = formatModified(change.modified);
  const size = change.size === null ? "" : formatSize(change.size);
  const details = [when, size].filter(Boolean).join(", ");
  return `The file on the server changed after you opened it${details ? ` (${details})` : ""}. Overwriting loses those changes.`;
}

/**
 * A file being edited in the user's own editor. Saving there only changes
 * the temporary copy; nothing reaches the server until Upload, and an upload
 * over a file someone else changed asks first.
 */
export function EditPanel() {
  const {
    edit,
    pollEdit,
    launchEditor,
    saveEdit,
    closeEdit,
    closeEditUnlessModified,
    dismissRemoteChange,
  } = useSftpStore(
    useShallow((s) => ({
      edit: s.edit,
      pollEdit: s.pollEdit,
      launchEditor: s.launchEditor,
      saveEdit: s.saveEdit,
      closeEdit: s.closeEdit,
      closeEditUnlessModified: s.closeEditUnlessModified,
      dismissRemoteChange: s.dismissRemoteChange,
    })),
  );
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const editId = edit?.session.edit_id;
  useEffect(() => {
    if (!editId) return;
    void pollEdit();
    const timer = setInterval(() => void pollEdit(), POLL_MS);
    return () => clearInterval(timer);
  }, [editId, pollEdit]);

  if (!edit) return null;
  const { session } = edit;
  const requestClose = () => {
    void closeEditUnlessModified().then((ask) => {
      if (ask) setConfirmDiscard(true);
    });
  };

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && requestClose()}>
        <DialogContent data-testid="files-edit-panel" data-temp-path={session.temp_path}>
          <DialogHeader>
            <DialogTitle className="break-all">Editing {session.name}</DialogTitle>
            <DialogDescription className="break-all">{session.remote_path}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <p data-testid="files-edit-status" role="status" aria-live="polite">
              {statusLine(edit)}
            </p>
            <p className="text-xs text-muted-foreground">
              Your editor works on a private temporary copy, removed when you close this panel:
            </p>
            <p className="text-xs font-mono text-muted-foreground-soft break-all">
              {session.temp_path}
            </p>
          </div>
          {edit.launchError && (
            <ErrorBanner
              message={`Could not open an editor: ${edit.launchError}`}
              testId="files-edit-launch-error"
            />
          )}
          {edit.saveError && <ErrorBanner message={edit.saveError} testId="files-edit-error" />}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={edit.saving || edit.missing || !edit.modified}
              onClick={() => void saveEdit(false)}
              data-testid="files-edit-save"
            >
              Upload changes
            </Button>
            <Button
              variant="outline"
              disabled={edit.missing}
              onClick={() => void launchEditor()}
              data-testid="files-edit-open-editor"
            >
              Open in editor
            </Button>
            <Button variant="outline" onClick={requestClose} data-testid="files-edit-close">
              Close
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title="Discard your changes?"
        description={`Your changes to ${session.name} have not been uploaded, and closing removes the temporary copy.`}
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        variant="destructive"
        onConfirm={closeEdit}
        testId="files-edit-discard"
      />
      <ConfirmDialog
        open={edit.remoteChange !== null}
        onOpenChange={(open) => !open && dismissRemoteChange()}
        title={`${session.name} changed on the server`}
        description={edit.remoteChange ? remoteChangeText(edit.remoteChange) : ""}
        confirmLabel="Overwrite"
        cancelLabel="Keep editing"
        variant="destructive"
        onConfirm={() => saveEdit(true)}
        testId="files-edit-conflict"
      />
    </>
  );
}
