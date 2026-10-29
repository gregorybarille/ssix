import React from "react";
import { Credential } from "@/types";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

/** Inline error line used by every field in the connection form. */
export function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-xs text-destructive">
      {message}
    </p>
  );
}

interface PortFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (raw: string) => void;
  error?: string;
  placeholder?: string;
  testId?: string;
  /** Rendered under the input while there is no error. */
  help?: React.ReactNode;
}

/**
 * A port input backed by a raw string so invalid text is reported rather
 * than silently coerced to 22 (see `parsePort`). The error paragraph id is
 * `<id>-error` and the help paragraph id is `<id>-help`.
 */
export function PortField({
  id,
  label,
  value,
  onChange,
  error,
  placeholder = "22",
  testId,
  help,
}: PortFieldProps) {
  const describedBy = error ? `${id}-error` : help ? `${id}-help` : undefined;
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="text"
        inputMode="numeric"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
      />
      {error ? (
        <FieldError id={`${id}-error`} message={error} />
      ) : (
        help && (
          <p id={`${id}-help`} className="text-xs text-muted-foreground">
            {help}
          </p>
        )
      )}
    </div>
  );
}

interface CredentialSelectProps {
  credentials: Credential[];
  value: string | undefined;
  onChange: (credentialId: string | undefined) => void;
  id?: string;
  testId?: string;
  error?: string;
  /** Id of the element describing an error, when the caller renders one. */
  errorId?: string;
}

/** Saved-credential picker with a "None" entry; `undefined` means none. */
export function CredentialSelect({
  credentials,
  value,
  onChange,
  id,
  testId,
  error,
  errorId,
}: CredentialSelectProps) {
  return (
    <Select
      value={value ?? "none"}
      onValueChange={(v) => onChange(v === "none" ? undefined : v)}
    >
      <SelectTrigger
        id={id}
        data-testid={testId}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
      >
        <SelectValue placeholder="Select credential..." />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="none" data-name="None">
          None
        </SelectItem>
        {credentials.map((cred) => (
          <SelectItem key={cred.id} value={cred.id} data-name={cred.name}>
            {cred.name} ({cred.username})
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
