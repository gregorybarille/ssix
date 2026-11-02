import { parseKeepaliveSeconds } from "@/lib/reconnect";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import type { ConnectionFormSectionProps } from "./advanced";

/** The choices of an on/off option that can defer to the app's settings. */
const OVERRIDE_CHOICES = [
  { value: "default", label: "Use app setting" },
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
];

function overrideChoice(value: boolean | undefined | null): string {
  if (value === undefined || value === null) return "default";
  return value ? "on" : "off";
}

function overrideValue(choice: string): boolean | undefined {
  return choice === "default" ? undefined : choice === "on";
}

function OverrideSelect({
  id,
  label,
  testId,
  value,
  onChange,
}: {
  id: string;
  label: string;
  testId: string;
  value: boolean | undefined | null;
  onChange: (value: boolean | undefined) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Select
        value={overrideChoice(value)}
        onValueChange={(choice) => onChange(overrideValue(choice))}
      >
        <SelectTrigger id={id} data-testid={testId}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {OVERRIDE_CHOICES.map((choice) => (
            <SelectItem key={choice.value} value={choice.value} data-name={choice.label}>
              {choice.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * Keepalive, auto-reconnect and session log of one connection. Anything left
 * unset follows Settings; see `docs/session-resilience.md`.
 */
export function SessionOptions({ advanced, onChange }: ConnectionFormSectionProps) {
  return (
    <div className="space-y-3" role="group" aria-labelledby="session-options-heading">
      <div className="space-y-1">
        <h3 id="session-options-heading" className="text-sm font-medium">
          Session
        </h3>
        <p className="text-xs text-muted-foreground">
          For shell sessions (direct and jump host). Local forwards do not use these.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="keepalive_interval">Keepalive interval (seconds)</Label>
        <Input
          id="keepalive_interval"
          type="number"
          min={0}
          max={3600}
          placeholder="Use app setting"
          value={advanced.keepalive_interval ?? ""}
          onChange={(e) =>
            onChange({ keepalive_interval: parseKeepaliveSeconds(e.target.value) })
          }
          aria-describedby="keepalive_interval-hint"
          data-testid="connection-form-keepalive"
        />
        <p id="keepalive_interval-hint" className="text-xs text-muted-foreground">
          0 turns keepalives off for this connection, so a dead connection can
          go unnoticed for a long time.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <OverrideSelect
          id="auto_reconnect"
          label="Auto-reconnect"
          testId="connection-form-auto-reconnect"
          value={advanced.auto_reconnect}
          onChange={(auto_reconnect) => onChange({ auto_reconnect })}
        />
        <OverrideSelect
          id="log_session"
          label="Session log"
          testId="connection-form-log-session"
          value={advanced.log_session}
          onChange={(log_session) => onChange({ log_session })}
        />
      </div>
    </div>
  );
}
