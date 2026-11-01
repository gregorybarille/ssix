import { Input } from "../ui/input";
import { Label } from "../ui/label";
import type { SettingsSectionProps } from "./section";

/** The git checkout and remote the Git Sync view exports to. */
export function GitSyncSection({
  form,
  updateLocalSettings,
  commitTextSettings,
}: SettingsSectionProps) {
  return (
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
              git_sync_repo_path: e.target.value || undefined,
            })
          }
          onBlur={(e) =>
            commitTextSettings({
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
              git_sync_remote: e.target.value,
            })
          }
          onBlur={(e) =>
            commitTextSettings({
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
              git_sync_branch: e.target.value || undefined,
            })
          }
          onBlur={(e) =>
            commitTextSettings({
              git_sync_branch: e.target.value || undefined,
            })
          }
          placeholder="main"
        />
      </div>
    </div>
  );
}
