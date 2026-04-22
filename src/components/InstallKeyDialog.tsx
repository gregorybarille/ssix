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
  DialogFooter,
} from "./ui/dialog";

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
  const [port, setPort] = useState<number>(22);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setHost(defaultHost ?? "");
      setPort(defaultPort ?? 22);
      setUsername(defaultUsername ?? "");
      setPassword("");
      setError(null);
      setSuccess(false);
    }
  }, [open, defaultHost, defaultPort, defaultUsername]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    setIsSubmitting(true);
    try {
      if (!host.trim()) throw new Error("Host is required");
      if (!username.trim()) throw new Error("Username is required");
      if (!password) throw new Error("Password is required");
      await invoke("ssh_install_public_key_by_credential", {
        input: {
          credential_id: credentialId,
          host: host.trim(),
          port,
          username: username.trim(),
          password,
        },
      });
      setSuccess(true);
      onSuccess?.();
      // Auto-close shortly after success so the user sees confirmation.
      setTimeout(() => onOpenChange(false), 800);
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
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <p className="text-xs text-muted-foreground">
            Connects once with the password below to append this credential's
            public key to <code>~/.ssh/authorized_keys</code>. The password is
            not saved.
          </p>
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2 space-y-2">
              <Label htmlFor="install-host">Host *</Label>
              <Input
                id="install-host"
                placeholder="server.example.com"
                value={host}
                onChange={(e) => setHost(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="install-port">Port</Label>
              <Input
                id="install-port"
                type="number"
                value={port}
                onChange={(e) => setPort(Number(e.target.value) || 22)}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="install-user">Username *</Label>
            <Input
              id="install-user"
              placeholder="root"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
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
            <p className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
              {error}
            </p>
          )}
          {success && (
            <p className="text-sm text-green-600 bg-green-500/10 px-3 py-2 rounded-md">
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
              Close
            </Button>
            <Button type="submit" disabled={isSubmitting || success}>
              {isSubmitting ? "Installing..." : "Install"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
