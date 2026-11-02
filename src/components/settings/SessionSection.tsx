import { parseKeepaliveSeconds, parseReconnectAttempts } from "@/lib/reconnect";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { NumberInput } from "../ui/number-input";
import { Separator } from "../ui/separator";
import { Switch } from "../ui/switch";
import type { SettingsSectionProps } from "./section";

/**
 * Keepalive, auto-reconnect and session logs for shell sessions. A connection
 * can override all but the attempts and the folder in its form; see
 * `docs/session-resilience.md`.
 */
export function SessionSection({
  form,
  applySettings,
  updateLocalSettings,
  commitTextSettings,
}: SettingsSectionProps) {
  return (
    <>
      <Separator />
      <div
        className="space-y-4"
        role="group"
        aria-labelledby="settings-session-heading"
        aria-describedby="settings-session-desc"
      >
        <h3 id="settings-session-heading" className="text-sm font-medium">Sessions</h3>
        <p id="settings-session-desc" className="text-xs text-muted-foreground">
          How shell sessions deal with a lost connection. Local forwards do not use these.
        </p>

        <div className="space-y-2">
          <Label htmlFor="keepalive-interval">Keepalive interval (seconds)</Label>
          <NumberInput
            id="keepalive-interval"
            min={0}
            max={3600}
            value={form.keepalive_interval}
            parse={parseKeepaliveSeconds}
            onCommit={(keepalive_interval) => commitTextSettings({ keepalive_interval })}
            aria-describedby="keepalive-interval-description"
            data-testid="settings-keepalive-interval"
          />
          <p id="keepalive-interval-description" className="text-xs text-muted-foreground-soft">
            A session counts as lost after three intervals without an answer
            from the server. 0 turns keepalives off.
          </p>
        </div>

        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor="auto-reconnect" className="cursor-pointer">
              Reconnect dropped sessions automatically
            </Label>
            <p id="auto-reconnect-description" className="text-xs text-muted-foreground-soft">
              Retries with growing delays in the same tab. Never retries a
              failed login or a changed host key.
            </p>
          </div>
          <Switch
            id="auto-reconnect"
            checked={form.auto_reconnect}
            onCheckedChange={(v) => applySettings({ auto_reconnect: v })}
            aria-describedby="auto-reconnect-description"
            data-testid="settings-auto-reconnect"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="reconnect-max-attempts">Reconnect attempts</Label>
          <NumberInput
            id="reconnect-max-attempts"
            min={1}
            max={20}
            value={form.reconnect_max_attempts}
            disabled={!form.auto_reconnect}
            parse={parseReconnectAttempts}
            onCommit={(reconnect_max_attempts) => commitTextSettings({ reconnect_max_attempts })}
            data-testid="settings-reconnect-max-attempts"
          />
        </div>

        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor="session-log-enabled" className="cursor-pointer">
              Log session output to a file
            </Label>
            <p id="session-log-enabled-description" className="text-xs text-muted-foreground-soft">
              Applies to sessions opened from now on. A log holds everything the
              remote prints, including any secret it echoes.
            </p>
          </div>
          <Switch
            id="session-log-enabled"
            checked={form.session_log_enabled}
            onCheckedChange={(v) => applySettings({ session_log_enabled: v })}
            aria-describedby="session-log-enabled-description"
            data-testid="settings-session-log-enabled"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="session-log-dir">Session log folder</Label>
          <Input
            id="session-log-dir"
            value={form.session_log_dir ?? ""}
            placeholder="session-logs in the SSIX data folder"
            onChange={(e) => updateLocalSettings({ session_log_dir: e.target.value })}
            onBlur={(e) =>
              commitTextSettings({ session_log_dir: e.target.value.trim() || undefined })
            }
            aria-describedby="session-log-dir-description"
            data-testid="settings-session-log-dir"
          />
          <p id="session-log-dir-description" className="text-xs text-muted-foreground-soft">
            An absolute path. Leave empty for the default.
          </p>
        </div>
      </div>
    </>
  );
}
