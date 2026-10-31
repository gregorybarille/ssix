import { useActionState, useEffect, useRef, useState } from "react";
import type { Script, ScriptInput, ScriptPlatform } from "@/types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group";
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
import { useLeaveViewGuard } from "@/hooks/useLeaveViewGuard";
import { useFieldErrors } from "@/hooks/useFieldErrors";
import { submitWithoutReset } from "@/lib/formSubmit";
import { errorMessage } from "@/lib/errors";
import {
  defaultInterpreter,
  INTERPRETER_PRESETS,
  interpreterForPlatform,
  PLATFORM_LABELS,
} from "@/lib/scripts";
import { cn } from "@/lib/utils";
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
  const [platform, setPlatform] = useState<ScriptPlatform>(script?.platform ?? "posix");
  const [interpreter, setInterpreter] = useState(script?.interpreter ?? defaultInterpreter("posix"));
  const [body, setBody] = useState(script?.body ?? "");
  const { fieldErrors, setFieldErrors, clearFieldError } = useFieldErrors<FieldKey>();
  const firstFieldRef = useRef<HTMLInputElement | null>(null);

  const baseline = useRef(JSON.stringify([name, platform, interpreter, body]));
  const dirty = JSON.stringify([name, platform, interpreter, body]) !== baseline.current;
  const guard = useUnsavedChangesGuard(dirty);
  const requestClose = () => guard.requestClose(onClose);

  const { requestClose: guardRequestClose } = guard;
  useEffect(() => {
    onGuardChange((proceed) => guardRequestClose(proceed));
    return () => onGuardChange(null);
  }, [guardRequestClose, onGuardChange]);
  useLeaveViewGuard(true, guardRequestClose, onClose);

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
        await onSubmit({ name, platform, interpreter, body });
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
              Name the script, choose the kind of host and the interpreter that runs it, and write its body.
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
                <Label id="script-platform-heading">Runs on</Label>
                <RadioGroup
                  aria-labelledby="script-platform-heading"
                  value={platform}
                  onValueChange={(v) => {
                    const next = v as ScriptPlatform;
                    setPlatform(next);
                    setInterpreter((current) => interpreterForPlatform(next, current));
                  }}
                  className="flex flex-wrap gap-2"
                >
                  {(Object.keys(PLATFORM_LABELS) as ScriptPlatform[]).map((value) => (
                    <RadioGroupItem
                      key={value}
                      value={value}
                      className={cn(
                        "px-3 py-1 text-sm rounded-md border transition-colors",
                        "data-[state=checked]:border-primary data-[state=checked]:bg-accent",
                        "data-[state=unchecked]:border-input data-[state=unchecked]:text-muted-foreground data-[state=unchecked]:hover:text-foreground",
                      )}
                      data-testid={`script-form-platform-${value}`}
                    >
                      {PLATFORM_LABELS[value]}
                    </RadioGroupItem>
                  ))}
                </RadioGroup>
              </div>
              <div className="space-y-2">
                <Label htmlFor="script-interpreter">
                  {platform === "windows" ? "PowerShell" : "Interpreter"}
                </Label>
                <Input
                  id="script-interpreter"
                  className="font-mono"
                  placeholder={defaultInterpreter(platform)}
                  value={interpreter}
                  onChange={(e) => setInterpreter(e.target.value)}
                  data-testid="script-form-interpreter"
                  aria-describedby="script-interpreter-hint"
                />
                <div className="flex flex-wrap items-center gap-1.5">
                  {INTERPRETER_PRESETS[platform].map((preset) => (
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
                  {platform === "windows" ? (
                    <>
                      The script is PowerShell. <code>powershell</code> is built into Windows;{" "}
                      <code>pwsh</code> is PowerShell 7. Blank means <code>powershell</code>.
                    </>
                  ) : (
                    <>
                      The remote command that reads the script on its standard input. Blank means{" "}
                      <code>{defaultInterpreter("posix")}</code>.
                    </>
                  )}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="script-body">Script *</Label>
                <Textarea
                  id="script-body"
                  className="min-h-64 text-xs"
                  spellCheck={false}
                  placeholder={platform === "windows" ? "Get-PSDrive C\nGet-Date" : "df -h /\nuptime"}
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
        testId="script-discard"
      />
    </>
  );
}
