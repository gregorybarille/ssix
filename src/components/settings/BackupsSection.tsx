import { BackupsList } from "../BackupsList";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Switch } from "../ui/switch";
import type { SettingsSectionProps } from "./section";

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

/** Automatic backup schedule and the list of backups on this computer. */
export function BackupsSection({
  form,
  applySettings,
  updateLocalSettings,
  commitTextSettings,
}: SettingsSectionProps) {
  return (
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
          onCheckedChange={(v) => applySettings({ backup_enabled: v })}
          aria-describedby="backup-enabled-description"
          data-testid="settings-backup-enabled"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor="backup-interval">Frequency</Label>
          <Select
            value={String(form.backup_interval_hours)}
            onValueChange={(v) => applySettings({ backup_interval_hours: Number(v) })}
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
                backup_keep: parseBackupKeep(e.target.value, form.backup_keep),
              })
            }
            onBlur={(e) =>
              commitTextSettings({
                backup_keep: parseBackupKeep(e.target.value, form.backup_keep),
              })
            }
            data-testid="settings-backup-keep"
          />
        </div>
      </div>

      <BackupsList />
    </div>
  );
}
