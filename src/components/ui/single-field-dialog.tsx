import { useActionState, useState, type ComponentProps, type ReactNode } from "react";
import { Button } from "./button";
import { Input } from "./input";
import { Label } from "./label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./dialog";
import { useFieldErrors } from "@/hooks/useFieldErrors";
import { errorMessage } from "@/lib/errors";
import { submitWithoutReset } from "@/lib/formSubmit";

/** The props a custom field gets; `onChange` takes the new text. */
export interface SingleFieldInputProps
  extends Omit<ComponentProps<typeof Input>, "value" | "onChange"> {
  value: string;
  onChange: (value: string) => void;
  "data-testid"?: string;
}

interface SingleFieldDialogProps {
  /** Starts the ids and test ids: `<prefix>-dialog`, `-input`, `-submit`, `-error`, `-preview`. */
  idPrefix: string;
  title: string;
  description: string;
  label: string;
  submitLabel: string;
  initial?: string;
  inputClassName?: string;
  /** Whether a blank value is an answer. Defaults to required. */
  required?: boolean;
  /** What the typed value means, shown under the field as it changes. */
  preview?: (value: string) => ReactNode;
  /** The field itself, when a plain `<Input>` will not do. */
  renderInput?: (props: SingleFieldInputProps) => ReactNode;
  /** Apply the value; what it throws is shown under the field. */
  onSubmit: (value: string) => Promise<void>;
  onClose: () => void;
  /** Where focus goes once it closed; see `DialogContent`. */
  onCloseAutoFocus?: (event: Event) => void;
}

/** Asks for the one value a change needs, and stays open if it is refused. */
export function SingleFieldDialog({
  idPrefix,
  title,
  description,
  label,
  submitLabel,
  initial = "",
  inputClassName,
  required = true,
  preview,
  renderInput,
  onSubmit,
  onClose,
  onCloseAutoFocus,
}: SingleFieldDialogProps) {
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

  const inputProps: SingleFieldInputProps = {
    id: `${idPrefix}-input`,
    autoFocus: true,
    className: inputClassName,
    value,
    onChange: (next) => {
      setValue(next);
      clearFieldError("value");
    },
    onFocus: (e) => e.target.select(),
    "aria-required": required ? "true" : undefined,
    "aria-invalid": fieldErrors.value ? true : undefined,
    "aria-describedby": describedBy || undefined,
    "data-testid": `${idPrefix}-input`,
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid={`${idPrefix}-dialog`} onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="break-all">{description}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submitWithoutReset(submitAction)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-input`}>{label}</Label>
            {renderInput ? (
              renderInput(inputProps)
            ) : (
              <Input {...inputProps} onChange={(e) => inputProps.onChange(e.target.value)} />
            )}
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
              <p
                id={errorId}
                role="alert"
                className="text-sm text-destructive break-words"
                data-testid={errorId}
              >
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
