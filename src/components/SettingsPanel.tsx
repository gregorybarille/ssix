import React, { useActionState, useEffect } from "react";
import { AppSettings, OPEN_COLORS, FONT_FAMILIES, FONT_SIZES, LayoutMode, OpenMode } from "@/types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Separator } from "./ui/separator";
import { Switch } from "./ui/switch";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group";
import { cn } from "@/lib/utils";
import { Check } from "lucide-react";
import { COLOR_VALUES } from "@/lib/colors";

interface SettingsPanelProps {
  settings: AppSettings;
  onSave: (settings: AppSettings) => Promise<void>;
}

export function SettingsPanel({ settings, onSave }: SettingsPanelProps) {
  const [form, setForm] = React.useState(settings);
  const [savedAt, setSavedAt] = React.useState(0);

  useEffect(() => {
    setForm(settings);
  }, [settings]);

  /*
   * React 19 useActionState replaces the prior trio of
   * `isSaving` / `saved` / `setTimeout` flags. The action runs
   * inside a transition so `isPending` is updated automatically
   * for the duration of the await. We bump `savedAt` after a
   * successful save so the polite live region can announce it
   * and auto-clear after 2s.
   */
  const [, saveAction, isSaving] = useActionState<null>(async () => {
    await onSave(form);
    setSavedAt(Date.now());
    return null;
  }, null);

  const [savedVisible, setSavedVisible] = React.useState(false);
  useEffect(() => {
    if (!savedAt) return;
    setSavedVisible(true);
    const id = setTimeout(() => setSavedVisible(false), 2000);
    return () => clearTimeout(id);
  }, [savedAt]);

  return (
    <form action={saveAction} className="space-y-6 p-6 max-w-lg">
      <div>
        <h2 className="text-lg font-semibold">Settings</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Customize the appearance of SSX
        </p>
      </div>
      <Separator />

      <div
        className="space-y-4"
        role="group"
        aria-labelledby="settings-font-heading"
      >
        <h3 id="settings-font-heading" className="text-sm font-medium">Font</h3>

        <div className="space-y-2">
          <Label htmlFor="font-family">Font Family</Label>
          <Select
            value={form.font_family}
            onValueChange={(v) => setForm({ ...form, font_family: v })}
          >
            <SelectTrigger id="font-family">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FONT_FAMILIES.map((f) => (
                <SelectItem key={f} value={f} style={{ fontFamily: f }}>
                  {f}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="font-size">Font Size</Label>
          <Select
            value={String(form.font_size)}
            onValueChange={(v) => setForm({ ...form, font_size: parseInt(v) })}
          >
            <SelectTrigger id="font-size">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FONT_SIZES.map((s) => (
                <SelectItem key={s} value={String(s)}>
                  {s}px
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <Separator />

      <div className="space-y-4">
        {/*
          Audit-3 P1#5: Color swatches were a hand-rolled <button> grid
          which screen readers announce as N unrelated buttons rather
          than as a single radio group with one selected option, and
          which gives keyboard users no arrow-key navigation. The
          shared <RadioGroup> primitive (Radix-backed) wires
          role=radiogroup + role=radio + aria-checked + arrow keys +
          roving tabindex automatically. The visible swatch is just
          the styled child of <RadioGroupItem>; data-state=checked
          drives the selected ring.
        */}
        <h3 id="settings-color-scheme-heading" className="text-sm font-medium">
          Color Scheme (Open Colors)
        </h3>
        <RadioGroup
          aria-labelledby="settings-color-scheme-heading"
          /*
            Audit-3 follow-up P1#2: NO `orientation` prop here. The
            swatches lay out in a 4-column grid (`grid-cols-4`), so
            keyboard users need BOTH ArrowLeft/Right (across a row)
            AND ArrowUp/Down (between rows). Radix RadioGroup's
            default omits the orientation context value, which makes
            its RovingFocusGroup accept all four arrow keys. Setting
            `orientation="horizontal"` would lock arrow nav to L/R
            only — fine for the theme picker (single row, line ~199)
            but broken for this 4-column grid. The connection-form
            color picker (ConnectionForm.tsx ~970) uses `flex-wrap`
            so visual rows are unpredictable; it also omits the
            orientation prop for the same reason.
          */
          value={form.color_scheme}
          onValueChange={(v) => setForm({ ...form, color_scheme: v })}
          className="grid grid-cols-4 gap-2"
        >
          {OPEN_COLORS.map((color) => (
            <RadioGroupItem
              key={color}
              value={color}
              aria-label={color}
              className={cn(
                "flex flex-col items-center gap-1.5 p-2 rounded-lg border transition-all",
                "data-[state=checked]:border-primary data-[state=checked]:bg-accent",
                "data-[state=unchecked]:border-transparent data-[state=unchecked]:hover:border-border",
              )}
            >
              <div
                className="w-6 h-6 rounded-full"
                style={{ backgroundColor: COLOR_VALUES[color] }}
                aria-hidden="true"
              />
              <span className="text-xs capitalize">{color}</span>
            </RadioGroupItem>
          ))}
        </RadioGroup>
      </div>

      <Separator />

      <div className="space-y-4">
        <h3 id="settings-theme-heading" className="text-sm font-medium">Theme</h3>
        <RadioGroup
          aria-labelledby="settings-theme-heading"
          orientation="horizontal"
          value={form.theme}
          onValueChange={(v) => setForm({ ...form, theme: v as "dark" | "light" })}
          className="flex gap-3"
        >
          {(["dark", "light"] as const).map((theme) => (
            <RadioGroupItem
              key={theme}
              value={theme}
              className={cn(
                "flex-1 py-2 px-4 rounded-lg border text-sm font-medium capitalize transition-all",
                "data-[state=checked]:border-primary data-[state=checked]:bg-accent data-[state=checked]:text-foreground",
                "data-[state=unchecked]:border-border data-[state=unchecked]:text-muted-foreground data-[state=unchecked]:hover:text-foreground",
              )}
            >
              {theme}
            </RadioGroupItem>
          ))}
        </RadioGroup>
      </div>

      <Separator />

      <div
        className="space-y-4"
        role="group"
        aria-labelledby="settings-layout-heading"
        aria-describedby="settings-layout-desc"
      >
        <h3 id="settings-layout-heading" className="text-sm font-medium">Layout</h3>
        <p
          id="settings-layout-desc"
          className="text-xs text-muted-foreground"
        >
          Choose how each list is displayed.
        </p>
        {([
          ["connection_layout", "Connections"],
          ["credential_layout", "Credentials"],
          ["tunnel_layout", "Tunnels"],
        ] as const).map(([key, label]) => (
          <div className="space-y-2" key={key}>
            <Label htmlFor={key}>{label}</Label>
            <Select
              value={form[key]}
              onValueChange={(v) => setForm({ ...form, [key]: v as LayoutMode })}
            >
              <SelectTrigger id={key}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="list">List</SelectItem>
                <SelectItem value="tile">Tiles</SelectItem>
                {/*
                 * "Tag groups" is a connections-only mode — tag
                 * grouping doesn't make sense for credentials or
                 * tunnels. Hiding it elsewhere keeps the user from
                 * picking a setting that would silently fall back
                 * to "tile" at render time.
                 */}
                {key === "connection_layout" && (
                  <SelectItem value="tags">Tag groups</SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>
        ))}

        <div className="space-y-2">
          <Label htmlFor="default-open-mode">Default open mode</Label>
          <Select
            value={form.default_open_mode}
            onValueChange={(v) =>
              setForm({ ...form, default_open_mode: v as OpenMode })
            }
          >
            <SelectTrigger id="default-open-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="tab">New tab</SelectItem>
              <SelectItem value="split_right">Split right</SelectItem>
              <SelectItem value="split_down">Split down</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <Separator />

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
            onCheckedChange={(v) => setForm({ ...form, auto_copy_selection: v })}
            aria-describedby="auto-copy-selection-description"
          />
        </div>
      </div>

      <Separator />

      <div
        className="space-y-4"
        role="group"
        aria-labelledby="settings-git-sync-heading"
        aria-describedby="settings-git-sync-desc"
      >
        <h3 id="settings-git-sync-heading" className="text-sm font-medium">Git Sync</h3>
        <p
          id="settings-git-sync-desc"
          className="text-xs text-muted-foreground"
        >
          Sync a sanitized copy of your SSX config to a git checkout. Secrets remain excluded.
        </p>

        <div className="space-y-2">
          <Label htmlFor="git-sync-repo-path">Repository path</Label>
          <Input
            id="git-sync-repo-path"
            value={form.git_sync_repo_path ?? ""}
            onChange={(e) => setForm({ ...form, git_sync_repo_path: e.target.value || undefined })}
            placeholder="/Users/me/config-repo"
            data-testid="settings-git-sync-repo-path"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="git-sync-remote">Remote name</Label>
          <Input
            id="git-sync-remote"
            value={form.git_sync_remote}
            onChange={(e) => setForm({ ...form, git_sync_remote: e.target.value || "origin" })}
            placeholder="origin"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="git-sync-branch">Branch override</Label>
          <Input
            id="git-sync-branch"
            value={form.git_sync_branch ?? ""}
            onChange={(e) => setForm({ ...form, git_sync_branch: e.target.value || undefined })}
            placeholder="main"
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={isSaving} aria-busy={isSaving} data-testid="settings-save">
          {isSaving ? "Saving..." : "Save Settings"}
        </Button>
        {/*
          P2-A11: announce save success to screen readers. role=status
          + aria-live=polite is the standard "transient confirmation"
          pattern; visual color alone is invisible to AT and to color-
          blind users on this background.

          Audit-3 follow-up P3#9: AGENTS.md mandates that color is
          supplementary — every status row must carry a glyph (or
          chip styling) so colorblind users get the same signal.
          The Check icon is rendered with aria-hidden because the
          status text already announces the meaning to AT.
        */}
        <span
          role="status"
          aria-live="polite"
          className="text-sm text-green-600 dark:text-green-400 inline-flex items-center gap-1.5"
        >
          {savedVisible && (
            <>
              <Check aria-hidden="true" className="h-3.5 w-3.5" />
              Settings saved!
            </>
          )}
        </span>
      </div>
    </form>
  );
}
