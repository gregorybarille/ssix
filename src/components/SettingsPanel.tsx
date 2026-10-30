import React, { useEffect } from "react";
import { AppSettings, OPEN_COLORS, FONT_FAMILIES, FONT_SIZES, LayoutMode, OpenMode } from "@/types";
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
import { useDebouncedCallback } from "@/hooks/useDebouncedCallback";
import { BackupsList } from "./BackupsList";

/**
 * How long the panel waits after the last edit before writing to disk.
 * Rapid edits (toggling several switches, clicking through swatches,
 * blurring a text field and picking a select) coalesce into a single
 * `save_settings` call carrying the final form state.
 */
const SETTINGS_SAVE_DEBOUNCE_MS = 300;

/** How often automatic backups can run, in hours. */
const BACKUP_INTERVALS = [
  { hours: 1, label: "Every hour" },
  { hours: 6, label: "Every 6 hours" },
  { hours: 12, label: "Every 12 hours" },
  { hours: 24, label: "Every day" },
  { hours: 168, label: "Every week" },
];

/** The number typed in the "keep" field, held to what the backend accepts. */
function parseBackupKeep(text: string, fallback: number): number {
  const n = Number.parseInt(text, 10);
  return Number.isFinite(n) ? Math.min(100, Math.max(1, n)) : fallback;
}

interface SettingsPanelProps {
  settings: AppSettings;
  onSave: (settings: AppSettings) => Promise<void>;
  onPreview?: (settings: AppSettings) => void;
}

export function SettingsPanel({ settings, onSave, onPreview }: SettingsPanelProps) {
  const [form, setForm] = React.useState(settings);
  const [savedAt, setSavedAt] = React.useState(0);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const latestSaveVersionRef = React.useRef(0);
  const pendingSaveRef = React.useRef<AppSettings | null>(null);
  const isSavingRef = React.useRef(false);
  // Keys the user changed since the last successful save, and the latest
  // settings seen from the store. A save sends the store's current values
  // plus only our dirty keys, so a change made elsewhere during the
  // debounce window (a shortcut toggling the theme) is never overwritten
  // by our stale snapshot of the whole form.
  const dirtyKeysRef = React.useRef<Set<keyof AppSettings>>(new Set());
  const storeSettingsRef = React.useRef(settings);
  storeSettingsRef.current = settings;

  // Adopt settings from the store only while nothing of ours is in
  // flight or waiting on the debounce timer: each saved value echoes
  // back through this prop, and taking it while a newer edit is queued
  // would clobber what the user typed.
  useEffect(() => {
    if (isSavingRef.current || pendingSaveRef.current) return;
    setForm(settings);
  }, [settings]);

  const [savedVisible, setSavedVisible] = React.useState(false);
  useEffect(() => {
    if (!savedAt) return;
    setSavedVisible(true);
    const id = setTimeout(() => setSavedVisible(false), 2000);
    return () => clearTimeout(id);
  }, [savedAt]);

  const processSaveQueue = React.useCallback(async () => {
    while (pendingSaveRef.current) {
      const pending = pendingSaveRef.current;
      const saveVersion = latestSaveVersionRef.current;
      pendingSaveRef.current = null;
      const toSave = { ...storeSettingsRef.current };
      for (const key of dirtyKeysRef.current) {
        (toSave as Record<string, unknown>)[key] = pending[key];
      }
      try {
        await onSave(toSave);
        if (saveVersion === latestSaveVersionRef.current) {
          dirtyKeysRef.current.clear();
          setSavedAt(Date.now());
        }
      } catch (error) {
        if (saveVersion !== latestSaveVersionRef.current) continue;
        const message =
          error instanceof Error && error.message.trim()
            ? error.message.trim()
            : "Failed to save settings.";
        setSaveError(message);
      }
    }
    isSavingRef.current = false;
  }, [onSave]);

  // Kick the queue. While a save is in flight the loop in
  // processSaveQueue picks up pendingSaveRef by itself, so this is a
  // no-op; only the version check decides whose result is shown.
  const startSave = React.useCallback(() => {
    if (isSavingRef.current || !pendingSaveRef.current) return;
    isSavingRef.current = true;
    void processSaveQueue();
  }, [processSaveQueue]);

  // Debounced start. pendingSaveRef always holds the full, latest form
  // state, so whichever edit ends the burst is what gets persisted —
  // including a git remote/branch that fails backend validation, whose
  // error then surfaces for that final state. Unmount (closing the
  // panel) flushes synchronously so the last value is never lost.
  const scheduleSave = useDebouncedCallback(startSave, SETTINGS_SAVE_DEBOUNCE_MS, {
    onUnmount: "flush",
  });

  // Losing the window (another app, hide, quit) is a natural "I'm
  // done editing" point and cheap to hook; flush rather than wait.
  useEffect(() => {
    const flush = () => scheduleSave.flush();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("blur", flush);
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", flush);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [scheduleSave]);

  const queueSave = (next: AppSettings) => {
    latestSaveVersionRef.current += 1;
    for (const key of Object.keys(next) as (keyof AppSettings)[]) {
      if (next[key] !== storeSettingsRef.current[key]) dirtyKeysRef.current.add(key);
    }
    pendingSaveRef.current = next;
    setSaveError(null);
    scheduleSave();
  };

  const applySettings = (next: AppSettings) => {
    setForm(next);
    onPreview?.(next);
    queueSave(next);
  };

  const updateLocalSettings = (next: AppSettings) => {
    setForm(next);
  };

  const commitTextSettings = (next: AppSettings) => {
    setForm(next);
    queueSave(next);
  };

  return (
    <div className="space-y-6 p-6 max-w-lg">
      <div>
        <h2 className="text-lg font-semibold">Settings</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Customize the appearance of SSIX
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
            onValueChange={(v) => applySettings({ ...form, font_family: v })}
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
            onValueChange={(v) => applySettings({ ...form, font_size: Number(v) })}
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
          onValueChange={(v) => applySettings({ ...form, color_scheme: v })}
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
          onValueChange={(v) => {
            applySettings({ ...form, theme: v as "dark" | "light" });
          }}
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
          ["tunnel_layout", "Port forwards"],
        ] as const).map(([key, label]) => (
          <div className="space-y-2" key={key}>
            <Label htmlFor={key}>{label}</Label>
            <Select
              value={form[key]}
              onValueChange={(v) => applySettings({ ...form, [key]: v as LayoutMode })}
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
                 * port forwards. Hiding it elsewhere keeps the user from
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
              applySettings({ ...form, default_open_mode: v as OpenMode })
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
            onCheckedChange={(v) => applySettings({ ...form, auto_copy_selection: v })}
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
          Sync a sanitized copy of your SSIX config to a git checkout. Secrets remain excluded.
        </p>

        <div className="space-y-2">
          <Label htmlFor="git-sync-repo-path">Repository path</Label>
          <Input
            id="git-sync-repo-path"
            value={form.git_sync_repo_path ?? ""}
            onChange={(e) =>
              updateLocalSettings({
                ...form,
                git_sync_repo_path: e.target.value || undefined,
              })
            }
            onBlur={(e) =>
              commitTextSettings({
                ...form,
                git_sync_repo_path: e.target.value || undefined,
              })
            }
            placeholder="/Users/me/config-repo"
            data-testid="settings-git-sync-repo-path"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="git-sync-remote">Remote name</Label>
          <Input
            id="git-sync-remote"
            value={form.git_sync_remote}
            onChange={(e) =>
              updateLocalSettings({
                ...form,
                git_sync_remote: e.target.value,
              })
            }
            onBlur={(e) =>
              commitTextSettings({
                ...form,
                git_sync_remote: e.target.value || "origin",
              })
            }
            placeholder="origin"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="git-sync-branch">Branch override</Label>
          <Input
            id="git-sync-branch"
            value={form.git_sync_branch ?? ""}
            onChange={(e) =>
              updateLocalSettings({
                ...form,
                git_sync_branch: e.target.value || undefined,
              })
            }
            onBlur={(e) =>
              commitTextSettings({
                ...form,
                git_sync_branch: e.target.value || undefined,
              })
            }
            placeholder="main"
          />
        </div>
      </div>

      <Separator />

      <div
        className="space-y-4"
        role="group"
        aria-labelledby="settings-backups-heading"
        aria-describedby="settings-backups-desc"
      >
        <h3 id="settings-backups-heading" className="text-sm font-medium">Backups</h3>
        <p id="settings-backups-desc" className="text-xs text-muted-foreground">
          ZIP copies of your connections, credentials (with their passwords and
          keys), settings and known hosts. They stay on this computer, readable
          only by you.
        </p>

        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor="backup-enabled" className="cursor-pointer">
              Back up automatically
            </Label>
            <p id="backup-enabled-description" className="text-xs text-muted-foreground-soft">
              Skipped when nothing changed since the last backup.
            </p>
          </div>
          <Switch
            id="backup-enabled"
            checked={form.backup_enabled}
            onCheckedChange={(v) => applySettings({ ...form, backup_enabled: v })}
            aria-describedby="backup-enabled-description"
            data-testid="settings-backup-enabled"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="backup-interval">Frequency</Label>
            <Select
              value={String(form.backup_interval_hours)}
              onValueChange={(v) => applySettings({ ...form, backup_interval_hours: Number(v) })}
              disabled={!form.backup_enabled}
            >
              <SelectTrigger id="backup-interval" data-testid="settings-backup-interval">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BACKUP_INTERVALS.map((i) => (
                  <SelectItem key={i.hours} value={String(i.hours)} data-name={i.label}>
                    {i.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="backup-keep">Automatic backups kept</Label>
            <Input
              id="backup-keep"
              type="number"
              min={1}
              max={100}
              value={form.backup_keep}
              disabled={!form.backup_enabled}
              onChange={(e) =>
                updateLocalSettings({
                  ...form,
                  backup_keep: parseBackupKeep(e.target.value, form.backup_keep),
                })
              }
              onBlur={(e) =>
                commitTextSettings({
                  ...form,
                  backup_keep: parseBackupKeep(e.target.value, form.backup_keep),
                })
              }
              data-testid="settings-backup-keep"
            />
          </div>
        </div>

        <BackupsList />
      </div>

      {/*
        P2-A11: announce save success to screen readers. role=status
        + aria-live=polite is the standard "transient confirmation"
        pattern; visual color alone is invisible to AT and to color-
        blind users on this background.
      */}
      <span
        role="status"
        aria-live="polite"
        className="text-sm text-green-600 dark:text-green-400 inline-flex items-center gap-1.5"
        data-testid="settings-saved-status"
      >
        {savedVisible && (
          <>
            <Check aria-hidden="true" className="h-3.5 w-3.5" />
            Settings saved!
          </>
        )}
      </span>
      {saveError && (
        <p role="alert" className="text-sm text-destructive">
          {saveError}
        </p>
      )}
    </div>
  );
}
