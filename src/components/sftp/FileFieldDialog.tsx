import { useActionState, useState, type ReactNode } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { useFieldErrors } from "@/hooks/useFieldErrors";
import { errorMessage } from "@/lib/errors";
import { submitWithoutReset } from "@/lib/formSubmit";

interface FileFieldDialogProps {
  /** Starts the ids and test ids: `<prefix>-dialog`, `-input`, `-submit`, `-error`, `-preview`. */
  idPrefix: string;
  title: string;
  description: string;
  label: string;
  submitLabel: string;
  initial?: string;
  inputClassName?: string;
  /** What the typed value means, shown under the field as it changes. */
  preview?: (value: string) => ReactNode;
  /** Apply the value; what it throws is shown under the field. */
  onSubmit: (value: string) => Promise<void>;
  onClose: () => void;
}

/** Asks for the one value a change to a file needs, and stays open if it is refused. */
export function FileFieldDialog({
  idPrefix,
  title,
  description,
  label,
  submitLabel,
  initial = "",
  inputClassName,
  preview,
  onSubmit,
  onClose,
}: FileFieldDialogProps) {
  const [value, setValue] = useState(initial);
  const { fieldErrors, setFieldErrors, clearFieldError } = useFieldErrors<"value">();

  const [, submitAction, isSubmitting] = useActionState<null>(async () => {
    try {
      await onSubmit(value);
      onClose();
    } catch (err) {
      setFieldErrors({ value: errorMessage(err) });
    }
    return null;
  }, null);

  const errorId = `${idPrefix}-error`;
  const previewId = `${idPrefix}-preview`;
  const describedBy = [fieldErrors.value && errorId, preview && previewId]
    .filter(Boolean)
    .join(" ");

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid={`${idPrefix}-dialog`}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="break-all">{description}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submitWithoutReset(submitAction)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-input`}>{label}</Label>
            <Input
              id={`${idPrefix}-input`}
              autoFocus
              className={inputClassName}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                clearFieldError("value");
              }}
              onFocus={(e) => e.target.select()}
              aria-required="true"
              aria-invalid={fieldErrors.value ? true : undefined}
              aria-describedby={describedBy || undefined}
              data-testid={`${idPrefix}-input`}
            />
            {preview && (
              <p
                id={previewId}
                className="text-xs font-mono text-muted-foreground"
                data-testid={previewId}
              >
                {preview(value)}
              </p>
            )}
            {fieldErrors.value && (
              <p id={errorId} role="alert" className="text-sm text-destructive break-words">
                {fieldErrors.value}
              </p>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting} data-testid={`${idPrefix}-submit`}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
