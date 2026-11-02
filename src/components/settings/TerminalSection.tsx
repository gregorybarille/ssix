import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import type { SettingsSectionProps } from "./section";

/** Terminal behaviour. The terminal-ux stream (roadmap) adds its options here. */
export function TerminalSection({ form, applySettings }: SettingsSectionProps) {
  return (
    <div
      className="space-y-4"
      role="group"
      aria-labelledby="settings-terminal-heading"
    >
      <h3 id="settings-terminal-heading" className="text-sm font-medium">Terminal</h3>
      {/*
        P1#1: classic xterm "selecting copies to clipboard" behavior is
        opt-in (default off). Defaulting it ON would silently overwrite
        the user's clipboard the moment they highlight text in the
        terminal — a real privacy/UX foot-gun on macOS where the
        convention is explicit Cmd+C. Cmd/Ctrl+C copies the active
        selection regardless of this setting.
      */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Label htmlFor="auto-copy-selection" className="cursor-pointer">
            Copy selection to clipboard automatically
          </Label>
          <p id="auto-copy-selection-description" className="text-xs text-muted-foreground-soft">
            When on, highlighting text in a terminal copies it immediately
            (xterm-style). Off by default — Cmd/Ctrl+C still copies.
          </p>
        </div>
        <Switch
          id="auto-copy-selection"
          checked={form.auto_copy_selection}
          onCheckedChange={(v) => applySettings({ auto_copy_selection: v })}
          aria-describedby="auto-copy-selection-description"
        />
      </div>
    </div>
  );
}
