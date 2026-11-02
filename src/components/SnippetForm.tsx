import { useRef, useState } from "react";
import type { Snippet, SnippetInput } from "@/types";
import { Label } from "./ui/label";
import { TagInput } from "./ui/tag-input";
import { Textarea } from "./ui/textarea";
import { EditorNameField, EditorPanel } from "./EditorPanel";
import { useEditorFormGuard, useEditorSubmit } from "@/hooks/useEditorPanel";
import { useFieldErrors } from "@/hooks/useFieldErrors";
import { snippetVariables } from "@/lib/snippets";
import type { FormSwitchGuard } from "@/store/useDialogsStore";

interface SnippetFormProps {
  /** The snippet to edit, or null for a new one. */
  snippet: Snippet | null;
  onSubmit: (input: SnippetInput) => Promise<Snippet>;
  onClose: () => void;
  /** Called with the form's guard while it is open, so the view can ask before replacing it. */
  onGuardChange: (guard: FormSwitchGuard | null) => void;
}

type FieldKey = "name" | "command";

/**
 * The snippet editor, in the side panel beside the list. The view mounts it
 * once per editing session (keyed by snippet), so its state starts fresh every
 * time it opens.
 */
export function SnippetForm({ snippet, onSubmit, onClose, onGuardChange }: SnippetFormProps) {
  const [name, setName] = useState(snippet?.name ?? "");
  const [command, setCommand] = useState(snippet?.command ?? "");
  const [tags, setTags] = useState<string[]>(snippet?.tags ?? []);
  const { fieldErrors, setFieldErrors, clearFieldError } = useFieldErrors<FieldKey>();
  const firstFieldRef = useRef<HTMLInputElement | null>(null);
  const guard = useEditorFormGuard([name, command, tags], onClose, onGuardChange);
  const variables = snippetVariables(command);

  const [{ error }, submitAction, isSubmitting] = useEditorSubmit<FieldKey>({
    validate: () => {
      const errors: Partial<Record<FieldKey, string>> = {};
      if (!name.trim()) errors.name = "Name is required";
      if (!command.trim()) errors.command = "Command is required";
      return errors;
    },
    setFieldErrors,
    save: () => onSubmit({ name, command, tags }),
    guard,
    onClose,
  });

  return (
    <EditorPanel
      title={snippet ? "Edit Snippet" : "New Snippet"}
      description="Name the snippet, write its command and add tags to find it by."
      testIdPrefix="snippet"
      guard={guard}
      submitAction={submitAction}
      isSubmitting={isSubmitting}
      submitLabel={snippet ? "Update" : "Create"}
      error={error}
      firstFieldRef={firstFieldRef}
      discardDescription="You have unsaved changes to this snippet. Discard them and close the editor?"
    >
      <EditorNameField
        prefix="snippet"
        placeholder="tail-app-log"
        value={name}
        error={fieldErrors.name}
        inputRef={firstFieldRef}
        onChange={(value) => {
          setName(value);
          clearFieldError("name");
        }}
      />
      <div className="space-y-2">
        <Label htmlFor="snippet-command">Command *</Label>
        <Textarea
          id="snippet-command"
          className="min-h-32 text-xs"
          spellCheck={false}
          placeholder="tail -f /var/log/{{service}}.log"
          value={command}
          onChange={(e) => {
            setCommand(e.target.value);
            clearFieldError("command");
          }}
          required
          aria-required="true"
          data-testid="snippet-form-command"
          aria-invalid={fieldErrors.command ? true : undefined}
          aria-describedby={
            fieldErrors.command
              ? "snippet-command-error snippet-command-hint"
              : "snippet-command-hint"
          }
        />
        {fieldErrors.command && (
          <p id="snippet-command-error" role="alert" className="text-xs text-destructive">
            {fieldErrors.command}
          </p>
        )}
        <p id="snippet-command-hint" className="text-xs text-muted-foreground">
          Write <code>{"{{name}}"}</code> for a value to ask for when you paste it, and{" "}
          <code>{"\\{{name}}"}</code> to keep those braces as they are.
        </p>
        {variables.length > 0 && (
          <p className="text-xs text-muted-foreground" data-testid="snippet-form-variables">
            Asks for: <span className="font-mono">{variables.join(", ")}</span>
          </p>
        )}
        <p
          id="snippet-git-sync-notice"
          className="text-xs text-muted-foreground"
          data-testid="snippet-form-git-sync-notice"
        >
          Git Sync exports snippets exactly as written, like scripts. Keep passwords and tokens out
          of them: use a variable instead.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="snippet-tags">Tags</Label>
        <TagInput id="snippet-tags" value={tags} onChange={setTags} placeholder="ops, logs" />
      </div>
    </EditorPanel>
  );
}
