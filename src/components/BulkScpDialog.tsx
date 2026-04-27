import { useEffect, useMemo, useState } from "react";
import type { Connection } from "@/types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Badge } from "./ui/badge";
import { cn } from "@/lib/utils";
import {
  isBulkActionable,
  planBulkDownload,
  planBulkUpload,
  runBulkScp,
  type BulkScpStep,
} from "@/lib/bulk-actions";
import { CheckCircle2, Circle, Loader2, MinusCircle, XCircle } from "lucide-react";

interface BulkScpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * The set of connections to operate on. Typically a tag group's
   * `.connections`, but the component is agnostic — pass any list.
   */
  connections: Connection[];
  /** User-facing label for the batch ("prod", "Untagged", etc.). */
  groupLabel: string;
}

/**
 * Bulk file transfer over a group of hosts.
 *
 * UX rules per the design discussion:
 *  - Upload: one local source + one remote target (same path on
 *    every host). The user types both paths.
 *  - Download: one remote source path + one LOCAL DIRECTORY. Each
 *    host's file is suffixed with `-<connection-name>` (sanitized
 *    for filesystem use) so multiple downloads to the same folder
 *    don't collide.
 *  - Recursive transfers are honoured; for downloads the suffix
 *    applies to the top-level directory name only.
 *  - Port-forward members are listed but greyed out — they can't
 *    do SCP and the SCP commands reject them server-side anyway.
 *  - Transfers run sequentially with a live per-host progress
 *    list. The dialog never closes itself; the user dismisses it
 *    when they're done reading the results.
 */
export function BulkScpDialog({
  open,
  onOpenChange,
  connections,
  groupLabel,
}: BulkScpDialogProps) {
  const [mode, setMode] = useState<"upload" | "download">("upload");
  const [localPath, setLocalPath] = useState("");
  const [remotePath, setRemotePath] = useState("");
  const [recursive, setRecursive] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [steps, setSteps] = useState<BulkScpStep[]>([]);
  const [running, setRunning] = useState(false);

  const actionableCount = useMemo(
    () => connections.filter(isBulkActionable).length,
    [connections],
  );

  // Reset state every time the dialog re-opens or its target group
  // changes. Without this, switching from `prod` to `staging` would
  // carry over `prod`'s progress rows.
  useEffect(() => {
    if (!open) {
      setMode("upload");
      setLocalPath("");
      setRemotePath("");
      setRecursive(false);
      setSubmitted(false);
      setSteps([]);
      setRunning(false);
    }
  }, [open]);

  const localPathError =
    submitted && !localPath.trim()
      ? mode === "upload"
        ? "Local source path is required"
        : "Local destination directory is required"
      : null;
  const remotePathError =
    submitted && !remotePath.trim() ? "Remote path is required" : null;

  const handleStart = async () => {
    setSubmitted(true);
    if (!localPath.trim()) return;
    if (!remotePath.trim()) return;

    const planned =
      mode === "upload"
        ? planBulkUpload(connections, {
            localPath,
            remotePath,
            recursive,
          })
        : planBulkDownload(connections, {
            remotePath,
            localDir: localPath,
            recursive,
          });
    setSteps(planned);
    setRunning(true);
    await runBulkScp(planned, mode, recursive, (next) => setSteps(next));
    setRunning(false);
  };

  const completed = steps.filter(
    (s) => s.status === "success" || s.status === "error" || s.status === "skipped",
  ).length;
  const successCount = steps.filter((s) => s.status === "success").length;
  const errorCount = steps.filter((s) => s.status === "error").length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-[640px]"
        data-testid="bulk-scp-dialog"
      >
        <DialogHeader>
          <DialogTitle>
            Transfer files to{" "}
            <span className="font-mono text-sm">{groupLabel}</span>{" "}
            <Badge variant="secondary" className="ml-1">
              {actionableCount} host{actionableCount === 1 ? "" : "s"}
            </Badge>
          </DialogTitle>
          <DialogDescription>
            {mode === "upload"
              ? "Upload the same local file or directory to every host in this tag group."
              : "Download a remote path from every host. Each file is saved with a per-host suffix so they don't collide."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Tabs
            value={mode}
            onValueChange={(v) => {
              if (running) return;
              setMode(v as "upload" | "download");
              setSubmitted(false);
              setSteps([]);
            }}
          >
            <TabsList className="w-full">
              <TabsTrigger
                value="upload"
                className="flex-1"
                data-testid="bulk-scp-mode-upload"
                disabled={running}
              >
                Upload
              </TabsTrigger>
              <TabsTrigger
                value="download"
                className="flex-1"
                data-testid="bulk-scp-mode-download"
                disabled={running}
              >
                Download
              </TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="space-y-2">
            <Label htmlFor="bulk-scp-local">
              {mode === "upload"
                ? "Local source path *"
                : "Local destination directory *"}
            </Label>
            <Input
              id="bulk-scp-local"
              placeholder={
                mode === "upload"
                  ? "/Users/me/file.txt"
                  : "/Users/me/downloads/"
              }
              value={localPath}
              onChange={(e) => setLocalPath(e.target.value)}
              disabled={running}
              data-testid="bulk-scp-local-path"
              aria-invalid={!!localPathError}
              aria-describedby={
                localPathError ? "bulk-scp-local-error" : "bulk-scp-local-hint"
              }
              className={cn(localPathError && "border-destructive")}
            />
            {localPathError ? (
              <p
                id="bulk-scp-local-error"
                role="alert"
                className="text-xs text-destructive"
              >
                {localPathError}
              </p>
            ) : (
              <p
                id="bulk-scp-local-hint"
                className="text-xs text-muted-foreground"
              >
                {mode === "upload"
                  ? "The same file or directory is sent to every host."
                  : "Each download is saved as <basename>-<connection-name> inside this directory."}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="bulk-scp-remote">Remote path *</Label>
            <Input
              id="bulk-scp-remote"
              placeholder="/var/log/app.log"
              value={remotePath}
              onChange={(e) => setRemotePath(e.target.value)}
              disabled={running}
              data-testid="bulk-scp-remote-path"
              aria-invalid={!!remotePathError}
              aria-describedby={
                remotePathError ? "bulk-scp-remote-error" : "bulk-scp-remote-hint"
              }
              className={cn(remotePathError && "border-destructive")}
            />
            {remotePathError ? (
              <p
                id="bulk-scp-remote-error"
                role="alert"
                className="text-xs text-destructive"
              >
                {remotePathError}
              </p>
            ) : (
              <p
                id="bulk-scp-remote-hint"
                className="text-xs text-muted-foreground"
              >
                Used as-is on every host. Prefer absolute paths so per-host
                base directories don't shift the target.
              </p>
            )}
          </div>

          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <Checkbox
              checked={recursive}
              onCheckedChange={(v) => setRecursive(v === true)}
              disabled={running}
            />
            Transfer directories recursively
          </label>

          {steps.length > 0 && (
            <div
              className="rounded-md border max-h-64 overflow-y-auto"
              data-testid="bulk-scp-progress"
              role="status"
              aria-live="polite"
              aria-atomic="false"
            >
              <ul className="divide-y">
                {steps.map((step) => (
                  <li
                    key={step.connectionId}
                    className="flex items-start gap-2 px-3 py-2 text-xs"
                    data-testid={`bulk-scp-row-${step.connectionId}`}
                    data-status={step.status}
                  >
                    <StatusIcon status={step.status} />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-sm truncate">
                        {step.connectionName}
                      </div>
                      <div className="text-muted-foreground truncate font-mono">
                        {mode === "upload"
                          ? `${step.localPath} → ${step.remotePath || "(default)"}`
                          : `${step.remotePath} → ${step.localPath}`}
                      </div>
                      {step.status === "success" &&
                        typeof step.bytes === "number" && (
                          <div className="text-muted-foreground-soft">
                            {step.bytes} bytes
                            {step.entries
                              ? `, ${step.entries} item${step.entries === 1 ? "" : "s"}`
                              : ""}
                          </div>
                        )}
                      {step.error && (
                        <div className="text-destructive">{step.error}</div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {steps.length > 0 && !running && (
            <div
              className="text-xs text-muted-foreground"
              data-testid="bulk-scp-summary"
            >
              {completed}/{steps.length} done — {successCount} succeeded
              {errorCount > 0 ? `, ${errorCount} failed` : ""}.
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={running}
          >
            {steps.length > 0 ? "Close" : "Cancel"}
          </Button>
          <Button
            type="button"
            onClick={handleStart}
            disabled={running || actionableCount === 0}
            aria-busy={running}
            data-testid="bulk-scp-start"
          >
            {running
              ? "Transferring..."
              : steps.length > 0
                ? "Run again"
                : `Start ${mode}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StatusIcon({ status }: { status: BulkScpStep["status"] }) {
  const cls = "h-4 w-4 mt-0.5 shrink-0";
  switch (status) {
    case "pending":
      return (
        <Circle
          className={cn(cls, "text-muted-foreground-soft")}
          aria-label="Pending"
        />
      );
    case "running":
      return (
        <Loader2
          className={cn(cls, "text-foreground animate-spin")}
          aria-label="Running"
        />
      );
    case "success":
      return (
        <CheckCircle2
          className={cn(cls, "text-green-500")}
          aria-label="Success"
        />
      );
    case "error":
      return (
        <XCircle className={cn(cls, "text-destructive")} aria-label="Error" />
      );
    case "skipped":
      return (
        <MinusCircle
          className={cn(cls, "text-muted-foreground-soft")}
          aria-label="Skipped"
        />
      );
  }
}
