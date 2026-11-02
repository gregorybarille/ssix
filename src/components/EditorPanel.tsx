import type { ReactNode, RefObject } from "react";
import type { EditorFormGuard } from "@/hooks/useEditorPanel";
import { submitWithoutReset } from "@/lib/formSubmit";
import { ConfirmDialog } from "./ConfirmDialog";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

interface EditorPanelProps {
  title: string;
  /** For screen readers: what the form is for. */
  description: string;
  /**
   * Test id prefix: `<prefix>-form`, `-form-cancel`, `-form-submit`,
   * `-form-error`, and `-discard` for the discard confirmation.
   */
  testIdPrefix: string;
  guard: EditorFormGuard;
  /** The form's `useActionState` action. */
  submitAction: () => void;
  isSubmitting: boolean;
  submitLabel: string;
  /** Why the last save failed. */
  error: string | null;
  /** Takes focus when the panel opens. */
  firstFieldRef: RefObject<HTMLElement | null>;
  /** The discard confirmation's question. */
  discardDescription: string;
  /** The fields. */
  children: ReactNode;
}

/**
 * The shell of a simple editor in the side panel: header, scrolling fields,
 * save error, the Cancel and save footer, and the discard confirmation.
 */
export function EditorPanel({
  title,
  description,
  testIdPrefix,
  guard,
  submitAction,
  isSubmitting,
  submitLabel,
  error,
  firstFieldRef,
  discardDescription,
  children,
}: EditorPanelProps) {
  const errorId = `${testIdPrefix}-form-error`;
  return (
    <>
      <Dialog open onOpenChange={(o) => !o && guard.closeForm()}>
        <DialogContent
          className="p-0 gap-0 overflow-hidden"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            firstFieldRef.current?.focus();
          }}
        >
          <DialogHeader className="px-6 pt-6 pb-3 shrink-0 border-b">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription className="sr-only">{description}</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={submitWithoutReset(submitAction)}
            className="flex flex-col flex-1 min-h-0"
            data-testid={`${testIdPrefix}-form`}
          >
            <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
              {children}
              {error && (
                <p
                  role="alert"
                  id={errorId}
                  data-testid={errorId}
                  className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md"
                >
                  {error}
                </p>
              )}
            </div>
            <DialogFooter className="px-6 py-3 border-t bg-background shrink-0 gap-2 sm:[&>button]:min-w-28">
              <Button
                type="button"
                variant="outline"
                onClick={guard.closeForm}
                disabled={isSubmitting}
                data-testid={`${testIdPrefix}-form-cancel`}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={isSubmitting}
                aria-busy={isSubmitting}
                data-testid={`${testIdPrefix}-form-submit`}
                aria-describedby={error ? errorId : undefined}
              >
                {isSubmitting ? "Saving..." : submitLabel}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={guard.confirmOpen}
        onOpenChange={(o) => {
          if (!o) guard.cancelDiscard();
        }}
        title="Discard unsaved changes?"
        description={discardDescription}
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        variant="destructive"
        onConfirm={guard.confirmDiscard}
        testId={`${testIdPrefix}-discard`}
      />
    </>
  );
}

interface EditorNameFieldProps {
  /** Its id is `<prefix>-name`, its test id `<prefix>-form-name`. */
  prefix: string;
  placeholder: string;
  value: string;
  error?: string;
  inputRef: RefObject<HTMLInputElement | null>;
  onChange: (value: string) => void;
}

/** The required name at the top of an editor, with its inline error. */
export function EditorNameField({
  prefix,
  placeholder,
  value,
  error,
  inputRef,
  onChange,
}: EditorNameFieldProps) {
  const id = `${prefix}-name`;
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Name *</Label>
      <Input
        id={id}
        ref={inputRef}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
        aria-required="true"
        data-testid={`${prefix}-form-name`}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
      />
      {error && (
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
