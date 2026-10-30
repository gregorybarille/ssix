import { useActionState, useEffect, useRef, useState } from "react";
import type { Script, ScriptInput } from "@/types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { useUnsavedChangesGuard } from "@/hooks/useUnsavedChangesGuard";
import { useFieldErrors } from "@/hooks/useFieldErrors";
import { submitWithoutReset } from "@/lib/formSubmit";
import { errorMessage } from "@/lib/errors";
import { DEFAULT_INTERPRETER, INTERPRETER_PRESETS } from "@/lib/scripts";
import type { FormSwitchGuard } from "@/store/useDialogsStore";

interface ScriptFormProps {
  /** The script to edit, or null for a new one. */
  script: Script | null;
  onSubmit: (input: ScriptInput) => Promise<Script>;
  onClose: () => void;
  /** Called with the form's guard while it is open, so the view can ask before replacing it. */
  onGuardChange: (guard: FormSwitchGuard | null) => void;
}

type FieldKey = "name" | "body";

/**
 * The script editor, in the side panel beside the scripts list. The view
 * mounts it once per editing session (keyed by script), so its state
 * starts fresh every time it opens.
 */
export function ScriptForm({ script, onSubmit, onClose, onGuardChange }: ScriptFormProps) {
  const [name, setName] = useState(script?.name ?? "");
  const [interpreter, setInterpreter] = useState(script?.interpreter ?? DEFAULT_INTERPRETER);
  const [body, setBody] = useState(script?.body ?? "");
  const { fieldErrors, setFieldErrors, clearFieldError } = useFieldErrors<FieldKey>();
  const firstFieldRef = useRef<HTMLInputElement | null>(null);

  const baseline = useRef(JSON.stringify([name, interpreter, body]));
  const dirty = JSON.stringify([name, interpreter, body]) !== baseline.current;
  const guard = useUnsavedChangesGuard(dirty);
  const requestClose = () => guard.requestClose(onClose);

  const { requestClose: guardRequestClose } = guard;
  useEffect(() => {
    onGuardChange((proceed) => guardRequestClose(proceed));
    return () => onGuardChange(null);
  }, [guardRequestClose, onGuardChange]);

  const [{ error }, submitAction, isSubmitting] = useActionState<{ error: string | null }>(
    async () => {
      const errors: Partial<Record<FieldKey, string>> = {};
      if (!name.trim()) errors.name = "Name is required";
      if (!body.trim()) errors.body = "The script is empty";
      if (Object.keys(errors).length > 0) {
        setFieldErrors(errors);
        return { error: "Please fix the highlighted fields" };
      }
      try {
        await onSubmit({ name, interpreter, body });
        guard.markSaved();
        onClose();
        return { error: null };
      } catch (err) {
        return { error: errorMessage(err) };
      }
    },
    { error: null },
  );

  return (
    <>
      <Dialog open onOpenChange={(o) => !o && requestClose()}>
        <DialogContent
          className="p-0 gap-0 overflow-hidden"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            firstFieldRef.current?.focus();
          }}
        >
          <DialogHeader className="px-6 pt-6 pb-3 shrink-0 border-b">
            <DialogTitle>{script ? "Edit Script" : "New Script"}</DialogTitle>
            <DialogDescription className="sr-only">
              Name the script, choose the remote interpreter that reads it, and write its body.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={submitWithoutReset(submitAction)}
            className="flex flex-col flex-1 min-h-0"
            data-testid="script-form"
          >
            <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="script-name">Name *</Label>
                <Input
                  id="script-name"
                  ref={firstFieldRef}
                  placeholder="disk-usage"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    clearFieldError("name");
                  }}
                  required
                  aria-required="true"
                  data-testid="script-form-name"
                  aria-invalid={fieldErrors.name ? true : undefined}
                  aria-describedby={fieldErrors.name ? "script-name-error" : undefined}
                />
                {fieldErrors.name && (
                  <p id="script-name-error" role="alert" className="text-xs text-destructive">
                    {fieldErrors.name}
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="script-interpreter">Interpreter</Label>
                <Input
                  id="script-interpreter"
                  className="font-mono"
                  placeholder={DEFAULT_INTERPRETER}
                  value={interpreter}
                  onChange={(e) => setInterpreter(e.target.value)}
                  data-testid="script-form-interpreter"
                  aria-describedby="script-interpreter-hint"
                />
                <div className="flex flex-wrap items-center gap-1.5">
                  {INTERPRETER_PRESETS.map((preset) => (
                    <Button
                      key={preset}
                      type="button"
                      size="sm"
                      variant={interpreter === preset ? "secondary" : "outline"}
                      className="h-6 px-2 font-mono text-xs"
                      aria-pressed={interpreter === preset}
                      onClick={() => setInterpreter(preset)}
                    >
                      {preset}
                    </Button>
                  ))}
                </div>
                <p id="script-interpreter-hint" className="text-xs text-muted-foreground">
                  The remote command that reads the script on its standard input. Blank means{" "}
                  <code>{DEFAULT_INTERPRETER}</code>.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="script-body">Script *</Label>
                <Textarea
                  id="script-body"
                  className="min-h-64 text-xs"
                  spellCheck={false}
                  placeholder={"df -h /\nuptime"}
                  value={body}
                  onChange={(e) => {
                    setBody(e.target.value);
                    clearFieldError("body");
                  }}
                  required
                  aria-required="true"
                  data-testid="script-form-body"
                  aria-invalid={fieldErrors.body ? true : undefined}
                  aria-describedby={fieldErrors.body ? "script-body-error" : undefined}
                />
                {fieldErrors.body && (
                  <p id="script-body-error" role="alert" className="text-xs text-destructive">
                    {fieldErrors.body}
                  </p>
                )}
              </div>
              {error && (
                <p
                  role="alert"
                  id="script-form-error"
                  data-testid="script-form-error"
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
                onClick={requestClose}
                disabled={isSubmitting}
                data-testid="script-form-cancel"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={isSubmitting}
                aria-busy={isSubmitting}
                data-testid="script-form-submit"
                aria-describedby={error ? "script-form-error" : undefined}
              >
                {isSubmitting ? "Saving..." : script ? "Update" : "Create"}
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
        description="You have unsaved changes to this script. Discard them and close the editor?"
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        variant="destructive"
        onConfirm={guard.confirmDiscard}
      />
    </>
  );
}
