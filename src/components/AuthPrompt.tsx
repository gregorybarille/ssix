import { useActionState, useEffect, useRef } from "react";
import { KeyRound } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import type { AuthPromptRequest } from "@/lib/authPrompt";
import { errorMessage } from "@/lib/errors";
import { submitWithoutReset } from "@/lib/formSubmit";

interface AuthPromptProps {
  request: AuthPromptRequest;
  isVisible: boolean;
  /** The server is asking because a dropped shell is logging in again. */
  reconnecting?: boolean;
  onAnswer: (answers: string[]) => Promise<void>;
  onCancel: () => void;
}

/**
 * The questions a server asks during keyboard-interactive login (a password, a
 * one-time code), answered in the terminal pane that is connecting. Mount with
 * `key={request.prompt_id}`: each round starts from empty fields.
 *
 * A field the server marks hidden is a bare `type="password"` input, not
 * `<PasswordInput>`: the server said not to echo it, so there is no reveal
 * toggle. An empty answer is a valid one.
 *
 * The fields are uncontrolled on purpose. React mirrors a controlled input's
 * value into its `value` attribute, which would leave an answer in the DOM,
 * and the answers would sit in component state besides.
 */
export function AuthPrompt({
  request,
  isVisible,
  reconnecting = false,
  onAnswer,
  onCancel,
}: AuthPromptProps) {
  const fields = useRef<(HTMLInputElement | null)[]>([]);

  const [error, submit, isPending] = useActionState(async () => {
    const inputs = fields.current.slice(0, request.prompts.length);
    const answers = inputs.map((input) => input?.value ?? "");
    for (const input of inputs) {
      if (input) input.value = "";
    }
    try {
      await onAnswer(answers);
      return null;
    } catch (err) {
      return errorMessage(err);
    }
  }, null);

  useEffect(() => {
    if (isVisible) fields.current[0]?.focus();
  }, [isVisible]);

  return (
    <div
      className="absolute inset-0 flex items-center justify-center bg-background"
      style={{ display: isVisible ? "flex" : "none" }}
      data-testid="auth-prompt"
    >
      <form
        onSubmit={submitWithoutReset(submit)}
        className="flex flex-col items-center gap-4 max-w-md w-full max-h-full overflow-y-auto p-6"
      >
        <KeyRound aria-hidden="true" className="h-10 w-10 shrink-0 text-muted-foreground" />
        <div role="status" aria-live="polite" aria-atomic="true" className="w-full text-center">
          <p className="text-sm font-semibold text-foreground break-all">
            {request.username}@{request.host}
          </p>
          {reconnecting && (
            <p className="text-xs text-foreground mt-1" data-testid="auth-prompt-reconnecting">
              The connection was lost. Log in again to reconnect.
            </p>
          )}
          {request.instructions && (
            <p
              className="text-xs text-muted-foreground whitespace-pre-wrap break-words mt-1"
              data-testid="auth-prompt-text"
            >
              {request.instructions}
            </p>
          )}
        </div>
        {request.prompts.map((field, index) => (
          <div key={index} className="w-full space-y-2">
            <Label htmlFor={`auth-prompt-${request.prompt_id}-${index}`} className="whitespace-pre-wrap">
              {field.text || `Answer ${index + 1}`}
            </Label>
            <Input
              id={`auth-prompt-${request.prompt_id}-${index}`}
              ref={(input) => {
                fields.current[index] = input;
              }}
              type={field.echo ? "text" : "password"}
              disabled={isPending}
              data-testid={`auth-prompt-input-${index}`}
            />
          </div>
        ))}
        {error && (
          <p
            role="alert"
            className="w-full text-xs text-destructive break-words text-center"
            data-testid="auth-prompt-error"
          >
            {error}
          </p>
        )}
        <div className="flex gap-2 flex-wrap justify-center">
          <Button type="submit" size="sm" disabled={isPending} data-testid="auth-prompt-submit">
            Continue
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onCancel}
            data-testid="auth-prompt-cancel"
          >
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
