import React, { useEffect, useState } from "react";
import { Connection, ScpResult } from "@/types";
import { invoke } from "@/lib/tauri";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { cn } from "@/lib/utils";

interface ScpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connection: Connection | null;
}

export function ScpDialog({ open, onOpenChange, connection }: ScpDialogProps) {
  const [mode, setMode] = useState<"upload" | "download">("upload");
  const [localPath, setLocalPath] = useState("");
  const [remotePath, setRemotePath] = useState("");
  const [recursive, setRecursive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ScpResult | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Per-field errors only show after the user attempts submit, so we
  // don't shout at them while they're still typing the first character.
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!open) {
      setMode("upload");
      setLocalPath("");
      setRemotePath(connection?.remote_path ?? "");
      setRecursive(false);
      setError(null);
      setResult(null);
      setSubmitted(false);
    }
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!connection) return;
    setSubmitted(true);
    setError(null);
    setResult(null);
    if (!localPath.trim()) return;
    if (mode === "download" && !remotePath.trim()) return;
    setIsSubmitting(true);
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
      setResult(next);
    } catch (err) {
      setError(String(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>SCP {connection ? `for ${connection.name}` : ""}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <Tabs value={mode} onValueChange={(v) => setMode(v as "upload" | "download")}>
            <TabsList className="w-full">
              <TabsTrigger value="upload" className="flex-1">Upload</TabsTrigger>
              <TabsTrigger value="download" className="flex-1">Download</TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="space-y-2">
            <Label htmlFor="scp-local-path">Local path *</Label>
            <Input
              id="scp-local-path"
              placeholder={mode === "upload" ? "/Users/me/file.txt" : "/Users/me/downloads/file.txt"}
              value={localPath}
              onChange={(e) => setLocalPath(e.target.value)}
              aria-invalid={!!localPathError}
              aria-describedby={
                localPathError ? "scp-local-path-error" : undefined
              }
              className={cn(localPathError && "border-destructive")}
            />
            {localPathError && (
              <p
                id="scp-local-path-error"
                role="alert"
                className="text-xs text-destructive"
              >
                {localPathError}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="scp-remote-path">Remote path {mode === "download" ? "*" : "(optional)"}</Label>
            <Input
              id="scp-remote-path"
              placeholder={connection?.remote_path || "/tmp/ or relative/file.txt"}
              value={remotePath}
              onChange={(e) => setRemotePath(e.target.value)}
              aria-invalid={!!remotePathError}
              aria-describedby={
                remotePathError ? "scp-remote-path-error" : undefined
              }
              className={cn(remotePathError && "border-destructive")}
            />
            {remotePathError && (
              <p
                id="scp-remote-path-error"
                role="alert"
                className="text-xs text-destructive"
              >
                {remotePathError}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Uses the connection remote path as the base directory when possible. Directory transfers require recursive mode.
            </p>
          </div>

          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={recursive}
              onChange={(e) => setRecursive(e.target.checked)}
              className="accent-primary"
            />
            Transfer directories recursively
          </label>

          {result && (
            <div className="rounded-md border p-3 text-xs">
              Transferred {result.bytes} bytes
              {result.entries ? ` across ${result.entries} item${result.entries === 1 ? "" : "s"}` : ""}
              {` between ${result.local_path} and ${result.remote_path}.`}
            </div>
          )}

          {error && (
            <div
              role="alert"
              aria-live="assertive"
              className="rounded-md bg-destructive/10 text-destructive text-sm px-3 py-2"
            >
              {error}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              Close
            </Button>
            <Button type="submit" disabled={isSubmitting || !connection}>
              {isSubmitting ? "Transferring..." : mode === "upload" ? "Upload" : "Download"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
