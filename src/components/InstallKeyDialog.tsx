import React, { useState, useEffect } from "react";
import { invoke } from "@/lib/tauri";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { PasswordInput } from "./ui/password-input";
import { Label } from "./ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import { parsePort } from "@/lib/port";
import { cn } from "@/lib/utils";

interface InstallKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The credential ID whose public key will be installed. Used to look up the public key on the backend. */
  credentialId: string;
  /** Pre-filled host (e.g. from a connection). User can still edit. */
  defaultHost?: string;
  defaultPort?: number;
  defaultUsername?: string;
  onSuccess?: () => void;
}

/**
 * Prompts for a one-time host/user/password and installs the credential's
 * public key on the remote `~/.ssh/authorized_keys`.
 *
 * The public key is derived on the backend from the stored credential (file or
 * inline). The supplied password is **not persisted**.
 */
export function InstallKeyDialog({
  open,
  onOpenChange,
  credentialId,
  defaultHost,
  defaultPort,
  defaultUsername,
  onSuccess,
}: InstallKeyDialogProps) {
  const [host, setHost] = useState("");
  // Port is held as a controlled string (per AGENTS.md "Port number
  // inputs MUST go through parsePort"). Coercing on every keystroke
  // with `Number(e) || 22` silently rewrote 2200 → 22 mid-typing and
  // hid out-of-range entries.
  const [port, setPort] = useState<string>("22");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  /*
   * Audit-3 follow-up P2#7: once an install succeeds we leave the
   * dialog open and disable the Install button (deliberate — the
   * user just performed an irreversible remote-side change and we
   * want them to read the success message before another action).
   * BUT if the user then edits Host / Port / Username they're
   * clearly preparing to install on a *different* target, and the
   * stale `success=true` would lock them out. Reset success on any
   * target-identity edit so the button re-enables. Wrapping the
   * setters keeps the contract local — handlers below call
   * editHost/editPort/editUsername instead of setHost/etc.
   */
  const editHost = (v: string) => {
    if (success) setSuccess(false);
    setHost(v);
  };
  const editPort = (v: string) => {
    if (success) setSuccess(false);
    setPort(v);
  };
  const editUsername = (v: string) => {
    if (success) setSuccess(false);
    setUsername(v);
  };

  useEffect(() => {
    if (open) {
      setHost(defaultHost ?? "");
      setPort(String(defaultPort ?? 22));
      setUsername(defaultUsername ?? "");
      setPassword("");
      setError(null);
      setSuccess(false);
    }
  }, [open, defaultHost, defaultPort, defaultUsername]);

  const portParsed = parsePort(port);
  const portError =
    port === ""
      ? "Port is required"
      : portParsed.error;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    if (portError || portParsed.value === null) {
      setError(portError ?? "Port is required");
      return;
    }
    setIsSubmitting(true);
    try {
      if (!host.trim()) throw new Error("Host is required");
      if (!username.trim()) throw new Error("Username is required");
      if (!password) throw new Error("Password is required");
      await invoke("ssh_install_public_key_by_credential", {
        input: {
          credential_id: credentialId,
          host: host.trim(),
          port: portParsed.value,
          username: username.trim(),
          password,
        },
      });
      setSuccess(true);
      onSuccess?.();
      // P2-A10: do NOT auto-close. The previous 800ms setTimeout
      // raced with the user reading the success message and
      // dismissed the dialog before assistive tech could finish
      // announcing it. The user closes via "Close" or "Done".
    } catch (err) {
      setError(String(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Install Public Key on Remote</DialogTitle>
          {/*
            Audit-3 follow-up P1#5: prose moved into DialogDescription
            so it's wired into the dialog's aria-describedby and
            announced when the dialog opens. Was a stand-alone <p>
            with no association.
          */}
          <DialogDescription className="text-xs">
            Connects once with the password below to append this credential's
            public key to <code>~/.ssh/authorized_keys</code>. The password is
            not saved.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2 space-y-2">
              <Label htmlFor="install-host">Host *</Label>
              <Input
                id="install-host"
                placeholder="server.example.com"
                value={host}
                onChange={(e) => editHost(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="install-port">Port</Label>
              <Input
                id="install-port"
                type="text"
                inputMode="numeric"
                value={port}
                aria-invalid={!!portError}
                aria-describedby={portError ? "install-port-error" : undefined}
                onChange={(e) => editPort(e.target.value)}
                className={cn(portError && "border-destructive")}
              />
              {portError && (
                <p
                  id="install-port-error"
                  role="alert"
                  className="text-xs text-destructive"
                >
                  {portError}
                </p>
              )}
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="install-user">Username *</Label>
            <Input
              id="install-user"
              placeholder="root"
              value={username}
              onChange={(e) => editUsername(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="install-pw">One-time Password *</Label>
            <PasswordInput
              id="install-pw"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {error && (
            <p
              role="alert"
              aria-live="assertive"
              className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md"
            >
              {error}
            </p>
          )}
          {success && (
            <p
              role="status"
              aria-live="polite"
              className="text-sm text-green-600 bg-green-500/10 px-3 py-2 rounded-md"
            >
              Public key installed successfully.
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              {success ? "Done" : "Close"}
            </Button>
            <Button
              type="submit"
              disabled={isSubmitting || success || !!portError}
              aria-busy={isSubmitting}
            >
              {isSubmitting ? "Installing..." : success ? "Installed" : "Install"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
