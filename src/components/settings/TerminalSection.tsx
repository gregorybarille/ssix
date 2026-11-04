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
        the user's clipboard the moment they highlight text — a real
        privacy/UX foot-gun on macOS where the convention is explicit
        Cmd+C. The copy keys copy the active selection regardless of this
        setting. It covers the whole app, here because it began with the
        terminal and that is still where it is used most.
      */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Label htmlFor="auto-copy-selection" className="cursor-pointer">
            Copy selection to clipboard automatically
          </Label>
          <p id="auto-copy-selection-description" className="text-xs text-muted-foreground-soft">
            When on, selecting text anywhere in the app, terminals included,
            copies it immediately. Text in fields you can type in is never
            copied this way. Off by default — Cmd+C on macOS, or Ctrl+Shift+C
            in a terminal elsewhere, still copies.
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
