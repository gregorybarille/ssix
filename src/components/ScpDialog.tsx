import { useActionState, useEffect, useState } from "react";
import { Connection, ScpResult } from "@/types";
import { invoke } from "@/lib/tauri";
import { Button } from "./ui/button";
import {
  type ScpMode,
  ScpModeTabs,
  ScpPathField,
  ScpRecursiveCheckbox,
  ScpStopButton,
} from "./ScpFields";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { submitWithoutReset } from "@/lib/formSubmit";
import { useHoldScpTarget } from "@/store/useDialogsStore";

interface ScpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connection: Connection | null;
}

export function ScpDialog({ open, onOpenChange, connection }: ScpDialogProps) {
  const [mode, setMode] = useState<ScpMode>("upload");
  const [localPath, setLocalPath] = useState("");
  const [remotePath, setRemotePath] = useState("");
  const [recursive, setRecursive] = useState(false);
  // Per-field errors only show after the user attempts submit, so we
  // don't shout at them while they're still typing the first character.
  const [submitted, setSubmitted] = useState(false);
  // Bumped every time the dialog is (re)opened or retargeted. The dialog is
  // mounted once at the App root, so the action state outlives a close; a
  // result is only shown for the opening that produced it.
  const [opening, setOpening] = useState(0);
  const [stopping, setStopping] = useState(false);

  /*
   * React 19: form-level error + result live in useActionState so
   * pending state, error, and the success payload all flow through
   * one channel. Field-level validation (`localPath`, `remotePath`)
   * remains in plain state — per AGENTS.md / migration plan.
   */
  // `mode` and `opening` record which transfer produced the result so a
  // stale status is never shown for another mode, another connection, or a
  // later opening of the dialog.
  type ScpState = {
    error: string | null;
    result: ScpResult | null;
    mode: ScpMode | null;
    opening: number;
  };
  const initialScpState: ScpState = { error: null, result: null, mode: null, opening: -1 };
  const [state, scpAction, isSubmitting] =
    useActionState<ScpState>(async () => {
      if (!connection) {
        return { error: null, result: null, mode, opening };
      }
      setSubmitted(true);
      // Mirror previous guard: bail without invoking when required
      // fields are blank. The local-state-driven errors above
      // (`localPathError` / `remotePathError`) handle the visible
      // alert; we just refuse to fire the IPC.
      if (!localPath.trim()) return { error: null, result: null, mode, opening };
      if (mode === "download" && !remotePath.trim())
        return { error: null, result: null, mode, opening };
      try {
        const next =
          mode === "upload"
            ? await invoke<ScpResult>("scp_upload", {
                input: {
                  connection_id: connection.id,
                  local_path: localPath,
                  remote_path: remotePath || undefined,
                  recursive,
                },
              })
            : await invoke<ScpResult>("scp_download", {
                input: {
                  connection_id: connection.id,
                  local_path: localPath,
                  remote_path: remotePath,
                  recursive,
                },
              });
        return { error: null, result: next, mode, opening };
      } catch (err) {
        return { error: String(err), result: null, mode, opening };
      }
    }, initialScpState);
  // Only surface the outcome of the transfer kind currently selected, from
  // this opening of the dialog, and never while a transfer is in flight.
  useHoldScpTarget(isSubmitting);
  const showOutcome = !isSubmitting && state.mode === mode && state.opening === opening;
  const result = showOutcome ? state.result : null;
  const error = showOutcome ? state.error : null;
  const outcomeText =
    result &&
    (result.stopped ??
      `Transferred ${result.bytes} bytes${
        result.entries ? ` across ${result.entries} item${result.entries === 1 ? "" : "s"}` : ""
      } between ${result.local_path} and ${result.remote_path}.`);

  const stop = () => {
    if (!connection) return;
    setStopping(true);
    // Refused, nothing will stop: the button comes back.
    invoke("scp_stop", { connectionId: connection.id }).catch(() => setStopping(false));
  };

  // Here and not in the action, whose updates only land once it has ended.
  useEffect(() => {
    if (!isSubmitting) setStopping(false);
  }, [isSubmitting]);

  // Reset on every open (and on close) so the remote path always comes
  // from the connection the dialog was opened for, never from the one it
  // last showed.
  useEffect(() => {
    setMode("upload");
    setLocalPath("");
    setRemotePath(connection?.remote_path ?? "");
    setRecursive(false);
    setSubmitted(false);
    setOpening((n) => n + 1);
  }, [open, connection]);

  // Reset the "submitted" flag whenever the user switches mode so the
  // download-required hint doesn't linger after toggling back to upload.
  useEffect(() => {
    setSubmitted(false);
  }, [mode]);

  const localPathError =
    submitted && !localPath.trim() ? "Local path is required" : null;
  const remotePathError =
    submitted && mode === "download" && !remotePath.trim()
      ? "Remote path is required for downloads"
      : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Escape too: closing now would lose the transfer's outcome.
        if (!isSubmitting) onOpenChange(next);
      }}
    >
      <DialogContent data-testid="scp-dialog">
        <DialogHeader>
          <DialogTitle>SCP {connection ? `for ${connection.name}` : ""}</DialogTitle>
          {/* P1#5: sr-only description so the dialog has a wired aria-describedby. */}
          <DialogDescription className="sr-only">
            Transfer files between your machine and the remote host over SSH/SCP.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submitWithoutReset(scpAction)} className="space-y-4" noValidate>
          <ScpModeTabs mode={mode} onChange={setMode} testIdPrefix="scp-mode" />

          <ScpPathField
            id="scp-local-path"
            testId="scp-local-path"
            label="Local path *"
            placeholder={mode === "upload" ? "/Users/me/file.txt" : "/Users/me/downloads/file.txt"}
            value={localPath}
            onChange={setLocalPath}
            error={localPathError}
          />

          <ScpPathField
            id="scp-remote-path"
            testId="scp-remote-path"
            label={`Remote path ${mode === "download" ? "*" : "(optional)"}`}
            placeholder={connection?.remote_path || "/tmp/ or relative/file.txt"}
            value={remotePath}
            onChange={setRemotePath}
            error={remotePathError}
            hint="Uses the connection remote path as the base directory when possible. Directory transfers require recursive mode."
          />

          <ScpRecursiveCheckbox checked={recursive} onChange={setRecursive} />

          {/*
            Audit-3 P2#8: progress and success must be announced to
            screen readers. Previously the only feedback was:
              (a) the submit button's label flipping to 'Transferring...'
                  — but AT does not reliably re-announce a button's
                  accessible name when it changes mid-operation, and
              (b) a static `<div>Transferred N bytes</div>` that
                  appeared after success — which AT also does not
                  announce because the node was being mounted, not
                  added to a live region.

            A single role=status + aria-live=polite region that's
            ALWAYS mounted (so AT is subscribed before the text
            arrives) carries both messages. Polite (vs assertive) is
            correct here because the user initiated the action and
            isn't reading something that needs interrupting; assertive
            is reserved for the error path below.

            `aria-atomic=true` ensures the entire message is
            re-announced when content changes (e.g. busy → success),
            not just the diff.
          */}
          <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="sr-only"
          >
            {isSubmitting
              ? stopping
                ? "Stopping the transfer — please wait."
                : `${mode === "upload" ? "Uploading" : "Downloading"} — please wait.`
              : (outcomeText ?? "")}
          </div>

          {outcomeText && (
            <div
              className="rounded-md border p-3 text-xs"
              data-testid="scp-status"
            >
              {outcomeText}
            </div>
          )}

          {error && (
            <div
              role="alert"
              aria-live="assertive"
              data-testid="scp-error"
              className="rounded-md bg-destructive/10 text-destructive text-sm px-3 py-2"
            >
              {error}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              Close
            </Button>
            {isSubmitting && (
              <ScpStopButton stopping={stopping} onStop={stop} testId="scp-stop" />
            )}
            <Button
              type="submit"
              disabled={isSubmitting || !connection}
              aria-busy={isSubmitting}
              data-testid={mode === "upload" ? "scp-upload" : "scp-download"}
            >
              {isSubmitting ? "Transferring..." : mode === "upload" ? "Upload" : "Download"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
