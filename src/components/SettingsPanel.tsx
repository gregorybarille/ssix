import React, { useEffect } from "react";
import { AppSettings, OPEN_COLORS, FONT_FAMILIES, FONT_SIZES, LayoutMode, OpenMode } from "@/types";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Separator } from "./ui/separator";
import { cn } from "@/lib/utils";
import { COLOR_VALUES } from "@/lib/colors";

interface SettingsPanelProps {
  settings: AppSettings;
  onSave: (settings: AppSettings) => Promise<void>;
}

export function SettingsPanel({ settings, onSave }: SettingsPanelProps) {
  const [form, setForm] = React.useState(settings);
  const [isSaving, setIsSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);

  useEffect(() => {
    setForm(settings);
  }, [settings]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await onSave(form);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-6 p-6 max-w-lg">
      <div>
        <h2 className="text-lg font-semibold">Settings</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Customize the appearance of SSX
        </p>
      </div>
      <Separator />

      <div className="space-y-4">
        <h3 className="text-sm font-medium">Font</h3>

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
        <h3 className="text-sm font-medium">Color Scheme (Open Colors)</h3>
        <div className="grid grid-cols-4 gap-2">
          {OPEN_COLORS.map((color) => (
            <button
              key={color}
              className={cn(
                "flex flex-col items-center gap-1.5 p-2 rounded-lg border transition-all",
                form.color_scheme === color
                  ? "border-primary bg-accent"
                  : "border-transparent hover:border-border"
              )}
              onClick={() => setForm({ ...form, color_scheme: color })}
            >
              <div
                className="w-6 h-6 rounded-full"
                style={{ backgroundColor: COLOR_VALUES[color] }}
              />
              <span className="text-xs capitalize">{color}</span>
            </button>
          ))}
        </div>
      </div>

      <Separator />

      <div className="space-y-4">
        <h3 className="text-sm font-medium">Theme</h3>
        <div className="flex gap-3">
          {(["dark", "light"] as const).map((theme) => (
            <button
              key={theme}
              className={cn(
                "flex-1 py-2 px-4 rounded-lg border text-sm font-medium capitalize transition-all",
                form.theme === theme
                  ? "border-primary bg-accent text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground"
              )}
              onClick={() => setForm({ ...form, theme })}
            >
              {theme}
            </button>
          ))}
        </div>
      </div>

      <Separator />

      <div className="space-y-4">
        <h3 className="text-sm font-medium">Layout</h3>
        <p className="text-xs text-muted-foreground">
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

      <div className="space-y-4">
        <h3 className="text-sm font-medium">Git Sync</h3>
        <p className="text-xs text-muted-foreground">
          Sync a sanitized copy of your SSX config to a git checkout. Secrets remain excluded.
        </p>

        <div className="space-y-2">
          <Label htmlFor="git-sync-repo-path">Repository path</Label>
          <input
            id="git-sync-repo-path"
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={form.git_sync_repo_path ?? ""}
            onChange={(e) => setForm({ ...form, git_sync_repo_path: e.target.value || undefined })}
            placeholder="/Users/me/config-repo"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="git-sync-remote">Remote name</Label>
          <input
            id="git-sync-remote"
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={form.git_sync_remote}
            onChange={(e) => setForm({ ...form, git_sync_remote: e.target.value || "origin" })}
            placeholder="origin"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="git-sync-branch">Branch override</Label>
          <input
            id="git-sync-branch"
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={form.git_sync_branch ?? ""}
            onChange={(e) => setForm({ ...form, git_sync_branch: e.target.value || undefined })}
            placeholder="main"
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={handleSave} disabled={isSaving}>
          {isSaving ? "Saving..." : "Save Settings"}
        </Button>
        {saved && (
          <span className="text-sm text-green-500">Settings saved!</span>
        )}
      </div>
    </div>
  );
}
