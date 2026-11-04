import type { ReactNode } from "react";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { cn } from "@/lib/utils";

export type ScpMode = "upload" | "download";

/** Shown while a transfer runs. A stop waits for the SFTP call in progress. */
export function ScpStopButton({
  stopping,
  onStop,
  testId,
}: {
  stopping: boolean;
  onStop: () => void;
  testId: string;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      onClick={onStop}
      disabled={stopping}
      aria-busy={stopping}
      data-testid={testId}
    >
      {stopping ? "Stopping..." : "Stop"}
    </Button>
  );
}

export function ScpModeTabs({
  mode,
  onChange,
  testIdPrefix,
  disabled,
}: {
  mode: ScpMode;
  onChange: (mode: ScpMode) => void;
  testIdPrefix: string;
  disabled?: boolean;
}) {
  return (
    <Tabs
      value={mode}
      onValueChange={(next) => {
        if (!disabled) onChange(next as ScpMode);
      }}
    >
      <TabsList className="w-full">
        <TabsTrigger value="upload" className="flex-1" data-testid={`${testIdPrefix}-upload`} disabled={disabled}>
          Upload
        </TabsTrigger>
        <TabsTrigger value="download" className="flex-1" data-testid={`${testIdPrefix}-download`} disabled={disabled}>
          Download
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

/** A path input. The hint stays beside an error: assistive tech needs both. */
export function ScpPathField({
  id,
  testId,
  label,
  placeholder,
  value,
  onChange,
  error,
  hint,
  disabled,
}: {
  id: string;
  testId: string;
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  error: string | null;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  const describedBy = [error && `${id}-error`, hint && `${id}-hint`].filter(Boolean).join(" ");
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        data-testid={testId}
        aria-invalid={!!error}
        aria-describedby={describedBy || undefined}
        className={cn(error && "border-destructive")}
      />
      {error && (
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

export function ScpRecursiveCheckbox({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center gap-2 text-sm cursor-pointer">
      <Checkbox checked={checked} onCheckedChange={(v) => onChange(v === true)} disabled={disabled} />
      Transfer directories recursively
    </label>
  );
}
