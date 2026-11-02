import { useShallow } from "zustand/react/shallow";
import { ConfirmDialog } from "../ConfirmDialog";
import { SingleFieldDialog } from "../ui/single-field-dialog";
import { formatModeOctal, formatModeSymbolic, parseMode } from "@/lib/sftp";
import { useSftpStore, type PaneSide } from "@/store/useSftpStore";
import type { FileEntry } from "@/types";

function whereLabel(side: PaneSide): string {
  return side === "local" ? "this computer" : "the server";
}

function deleteTitle(entries: FileEntry[]): string {
  return entries.length === 1 ? `Delete ${entries[0].name}?` : `Delete ${entries.length} items?`;
}

/** The name typed into a dialog; the backend checks the rest of what makes it safe. */
function requireName(text: string): string {
  const name = text.trim();
  if (!name) throw new Error("Name is required");
  return name;
}

function requireMode(text: string): number {
  const mode = parseMode(text);
  if (mode === null) throw new Error("Enter 3 or 4 octal digits, like 644 or 0755");
  return mode;
}

/** The dialogs the panes open, and the question a conflicting transfer asks. */
export function FileDialogs() {
  const { dialog, setDialog, mkdir, rename, chmod, remove, resolveConflict } = useSftpStore(
    useShallow((s) => ({
      dialog: s.dialog,
      setDialog: s.setDialog,
      mkdir: s.mkdir,
      rename: s.rename,
      chmod: s.chmod,
      remove: s.remove,
      resolveConflict: s.resolveConflict,
    })),
  );
  // One question at a time: answering this one brings up the next.
  const conflicted = useSftpStore((s) => s.transfers.find((t) => t.status === "conflict"));
  const close = () => setDialog(null);

  return (
    <>
      {dialog?.kind === "mkdir" && (
        <SingleFieldDialog
          idPrefix="files-name"
          title="New folder"
          description={`Create a folder in the folder shown for ${whereLabel(dialog.side)}.`}
          label="Name"
          submitLabel="Create"
          onSubmit={(text) => mkdir(dialog.side, requireName(text))}
          onClose={close}
        />
      )}
      {dialog?.kind === "rename" && (
        <SingleFieldDialog
          key={dialog.entry.path}
          idPrefix="files-name"
          title="Rename"
          description={`Choose a new name for ${dialog.entry.name}.`}
          label="Name"
          submitLabel="Rename"
          initial={dialog.entry.name}
          onSubmit={(text) => rename(dialog.side, dialog.entry, requireName(text))}
          onClose={close}
        />
      )}
      {dialog?.kind === "chmod" && (
        <SingleFieldDialog
          key={dialog.entry.path}
          idPrefix="files-chmod"
          title="Permissions"
          description={`Set who can read, write and run ${dialog.entry.name}.`}
          label="Mode"
          submitLabel="Apply"
          initial={formatModeOctal(dialog.entry.mode)}
          inputClassName="font-mono"
          preview={(text) => formatModeSymbolic(parseMode(text))}
          onSubmit={(text) => chmod(dialog.side, dialog.entry, requireMode(text))}
          onClose={close}
        />
      )}
      {dialog?.kind === "delete" && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && close()}
          title={deleteTitle(dialog.entries)}
          description={`This permanently deletes it from ${whereLabel(dialog.side)}, with everything inside any folder. Symbolic links are removed, not what they point to.`}
          confirmLabel="Delete"
          variant="destructive"
          onConfirm={() => remove(dialog.side, dialog.entries)}
          testId="files-delete-confirm"
        />
      )}
      {conflicted?.conflict && (
        <ConfirmDialog
          key={conflicted.id}
          open
          onOpenChange={(open) => {
            if (!open) void resolveConflict(conflicted.id, false);
          }}
          title={`Replace ${conflicted.name}?`}
          description={
            conflicted.conflict.targetIsDir
              ? `The folder ${conflicted.conflict.target} already exists. Files with the same name are replaced; the others stay.`
              : `${conflicted.conflict.target} already exists and is replaced by this copy.`
          }
          confirmLabel="Replace"
          variant="destructive"
          onConfirm={() => resolveConflict(conflicted.id, true)}
          testId="files-overwrite-confirm"
        />
      )}
    </>
  );
}
