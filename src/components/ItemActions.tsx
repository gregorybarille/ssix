import { Pencil, Trash2 } from "lucide-react";
import { ConfirmDialog } from "./ConfirmDialog";
import { Button } from "./ui/button";

interface ItemRowActionsProps {
  /** The item's name, for the buttons' accessible names. */
  name: string;
  /** Test ids are `<prefix>-row-edit` and `<prefix>-row-delete`. */
  testIdPrefix: string;
  onEdit: () => void;
  onDelete: () => void;
}

/** The Edit and Delete icon buttons at the end of a saved script's or snippet's row. */
export function ItemRowActions({ name, testIdPrefix, onEdit, onDelete }: ItemRowActionsProps) {
  return (
    <>
      <Button
        size="icon"
        variant="ghost"
        className="h-7 w-7 shrink-0"
        aria-label={`Edit ${name}`}
        onClick={onEdit}
        data-testid={`${testIdPrefix}-row-edit`}
      >
        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="h-7 w-7 shrink-0"
        aria-label={`Delete ${name}`}
        onClick={onDelete}
        data-testid={`${testIdPrefix}-row-delete`}
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
    </>
  );
}

interface DeleteItemDialogProps<T extends { name: string }> {
  /** The item to confirm deleting; the dialog is open while there is one. */
  item: T | null;
  /** "script", "snippet": names the title and the test id `<kind>-delete-dialog`. */
  kind: string;
  onClose: () => void;
  /** Rejecting keeps the dialog open and shows why. */
  onDelete: (item: T) => Promise<void>;
}

/** The confirmation before deleting a saved script or snippet. */
export function DeleteItemDialog<T extends { name: string }>({
  item,
  kind,
  onClose,
  onDelete,
}: DeleteItemDialogProps<T>) {
  return (
    <ConfirmDialog
      open={!!item}
      onOpenChange={(o) => !o && onClose()}
      title={`Delete ${kind}?`}
      description={
        <>
          Delete <strong>{item?.name}</strong>? This cannot be undone.
        </>
      }
      confirmLabel="Delete"
      variant="destructive"
      testId={`${kind}-delete-dialog`}
      onConfirm={async () => {
        if (item) await onDelete(item);
      }}
    />
  );
}
