import React from "react";
import { Credential } from "@/types";
import { Checkbox } from "./ui/checkbox";
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
export function FieldError({
  id,
  message,
  testId,
}: {
  id: string;
  message?: string;
  testId?: string;
}) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-xs text-destructive" data-testid={testId}>
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
  /** Accessible name, for a picker that has no `<Label htmlFor>` of its own. */
  "aria-label"?: string;
  /** Marks the picker required for assistive tech; the caller rejects "None" on submit. */
  required?: boolean;
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
  "aria-label": ariaLabel,
  required,
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
        aria-label={ariaLabel}
        aria-required={required ? true : undefined}
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

interface SaveCredentialFieldsProps {
  /** Checkbox id; the credential name input uses `nameId`. */
  checkboxId: string;
  nameId: string;
  namePlaceholder: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  name: string;
  onNameChange: (name: string) => void;
  error?: string;
  /** Checkbox testid; the name input gets `${testId}-name`. */
  testId?: string;
}

/**
 * "Save as a named credential" toggle and, when ticked, the credential
 * name, shared by the connection form's Password and SSH Key tabs.
 */
export function SaveCredentialFields({
  checkboxId,
  nameId,
  namePlaceholder,
  checked,
  onCheckedChange,
  name,
  onNameChange,
  error,
  testId,
}: SaveCredentialFieldsProps) {
  const errorId = `${nameId}-error`;
  return (
    <>
      <div className="flex items-center gap-2">
        <Checkbox
          id={checkboxId}
          data-testid={testId}
          checked={checked}
          onCheckedChange={(v) => onCheckedChange(v === true)}
        />
        <Label
          htmlFor={checkboxId}
          className="text-xs text-muted-foreground font-normal cursor-pointer select-none"
        >
          Save as a named credential (visible in the Credentials list)
        </Label>
      </div>
      {checked && (
        <div className="space-y-2">
          <Label htmlFor={nameId}>Credential Name *</Label>
          <Input
            id={nameId}
            data-testid={testId ? `${testId}-name` : undefined}
            placeholder={namePlaceholder}
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            aria-required="true"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
          />
          <FieldError id={errorId} message={error} />
        </div>
      )}
    </>
  );
}
