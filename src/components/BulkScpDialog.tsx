import { useEffect, useMemo, useRef, useState } from "react";
import type { Connection } from "@/types";
import { invoke } from "@/lib/tauri";
import { Button } from "./ui/button";
import {
  type ScpMode,
  ScpModeTabs,
  ScpPathField,
  ScpRecursiveCheckbox,
  ScpStopButton,
} from "./ScpFields";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Badge } from "./ui/badge";
import {
  isBulkActionable,
  planBulkDownload,
  planBulkUpload,
  runBulkScp,
  type BulkScpStep,
} from "@/lib/bulk-actions";
import { StatusIcon } from "./ui/status-icon";
import { useHoldScpTarget } from "@/store/useDialogsStore";

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
 *  - Port forward members are listed but greyed out — they can't
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
  const [mode, setMode] = useState<ScpMode>("upload");
  const [localPath, setLocalPath] = useState("");
  const [remotePath, setRemotePath] = useState("");
  const [recursive, setRecursive] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [steps, setSteps] = useState<BulkScpStep[]>([]);
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  // Refs, since hosts change between renders: a stop must reach the one running now.
  const stopAsked = useRef(false);
  const currentHost = useRef<string | undefined>(undefined);
  useHoldScpTarget(running);

  const actionableCount = useMemo(
    () => connections.filter(isBulkActionable).length,
    [connections],
  );

  // Reset state when the dialog closes. The dialog is always
  // unmounted/remounted for each group, so there is no in-flight
  // state to carry over to a different group.
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
    setStopping(false);
    stopAsked.current = false;
    await runBulkScp(
      planned,
      mode,
      recursive,
      (next) => {
        currentHost.current = next.find((s) => s.status === "running")?.connectionId;
        setSteps(next);
      },
      () => stopAsked.current,
    );
    setRunning(false);
  };

  const stop = () => {
    stopAsked.current = true;
    setStopping(true);
    if (!currentHost.current) return;
    // Refused, this host runs on, but the hosts after it still will not start.
    invoke("scp_stop", { connectionId: currentHost.current }).catch(() => setStopping(false));
  };

  const completed = steps.filter(
    (s) => s.status === "success" || s.status === "error" || s.status === "skipped",
  ).length;
  const successCount = steps.filter((s) => s.status === "success").length;
  const errorCount = steps.filter((s) => s.status === "error").length;
  const stoppedCount = steps.filter((s) => s.status === "cancelled").length;
  const skippedCount = steps.filter((s) => s.status === "skipped").length;
  const wasStopped = steps.some((s) => s.note);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (running) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
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
          <ScpModeTabs
            mode={mode}
            onChange={(next) => {
              setMode(next);
              setSubmitted(false);
              setSteps([]);
            }}
            testIdPrefix="bulk-scp-mode"
            disabled={running}
          />

          <ScpPathField
            id="bulk-scp-local"
            testId="bulk-scp-local-path"
            label={mode === "upload" ? "Local source path *" : "Local destination directory *"}
            placeholder={mode === "upload" ? "/Users/me/file.txt" : "/Users/me/downloads/"}
            value={localPath}
            onChange={setLocalPath}
            error={localPathError}
            hint={
              mode === "upload"
                ? "The same file or directory is sent to every host."
                : "Each download is saved as <basename>-<connection-name> inside this directory."
            }
            disabled={running}
          />

          <ScpPathField
            id="bulk-scp-remote"
            testId="bulk-scp-remote-path"
            label="Remote path *"
            placeholder="/var/log/app.log"
            value={remotePath}
            onChange={setRemotePath}
            error={remotePathError}
            hint="Used as-is on every host. Prefer absolute paths so per-host base directories don't shift the target."
            disabled={running}
          />

          <ScpRecursiveCheckbox checked={recursive} onChange={setRecursive} disabled={running} />

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
                      {step.note && (
                        <div className="text-muted-foreground">{step.note}</div>
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
              {wasStopped
                ? `Transfer stopped — ${successCount} succeeded${
                    errorCount > 0 ? `, ${errorCount} failed` : ""
                  }, ${stoppedCount} stopped, ${skippedCount} skipped.`
                : `${completed}/${steps.length} done — ${successCount} succeeded${
                    errorCount > 0 ? `, ${errorCount} failed` : ""
                  }.`}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:[&>button]:min-w-28">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={running}
          >
            {steps.length > 0 ? "Close" : "Cancel"}
          </Button>
          {running && (
            <ScpStopButton stopping={stopping} onStop={stop} testId="bulk-scp-stop" />
          )}
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
