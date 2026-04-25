import React, { useActionState, useState, useEffect } from "react";
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

  const portParsed = parsePort(port);
  const portError =
    port === ""
      ? "Port is required"
      : portParsed.error;

  /*
   * React 19 useActionState owns both the form-level error and the
   * "installed successfully" flag, so all form-result state moves
   * through one channel. Field-level errors stay on local state
   * (per AGENTS.md / migration plan).
   *
   * successEpoch increments on every successful install so that a
   * second success after the user edits fields is always detectable,
   * even though useActionState preserves state across renders.
   */
  type InstallState = { error: string | null; successEpoch: number };
  const initialInstallState: InstallState = { error: null, successEpoch: 0 };
  const [{ error, successEpoch }, installAction, isSubmitting] =
    useActionState<InstallState>(async (prevState) => {
      try {
        if (portError || portParsed.value === null) {
          return { error: portError ?? "Port is required", successEpoch: prevState.successEpoch };
        }
        if (!host.trim()) return { error: "Host is required", successEpoch: prevState.successEpoch };
        if (!username.trim())
          return { error: "Username is required", successEpoch: prevState.successEpoch };
        if (!password) return { error: "Password is required", successEpoch: prevState.successEpoch };
        await invoke("ssh_install_public_key_by_credential", {
          input: {
            credential_id: credentialId,
            host: host.trim(),
            port: portParsed.value,
            username: username.trim(),
            password,
          },
        });
        onSuccess?.();
        // P2-A10: do NOT auto-close. The previous 800ms setTimeout
        // raced with the user reading the success message and
        // dismissed the dialog before assistive tech could finish
        // announcing it. The user closes via "Close" or "Done".
        return { error: null, successEpoch: prevState.successEpoch + 1 };
      } catch (err) {
        return { error: String(err), successEpoch: prevState.successEpoch };
      }
    }, initialInstallState);

  // Ref keeps the open-effect below from needing successEpoch in its
  // dependency array (which would re-run field resets after every install).
  const successEpochRef = React.useRef(successEpoch);
  useEffect(() => {
    successEpochRef.current = successEpoch;
  }, [successEpoch]);

  /*
   * Audit-3 follow-up P2#7: once an install succeeds we leave the
   * dialog open and disable the Install button (deliberate — the
   * user just performed an irreversible remote-side change and we
   * want them to read the success message before another action).
   * BUT if the user then edits Host / Port / Username they're
   * clearly preparing to install on a *different* target, and the
   * stale success state would lock them out. dismissedEpoch tracks
   * the last epoch the user dismissed; effectiveSuccess is only true
   * when a newer success epoch exists.
   */
  const [dismissedEpoch, setDismissedEpoch] = useState(0);
  const effectiveSuccess = successEpoch > dismissedEpoch;

  const clearSuccess = () => {
    setDismissedEpoch(successEpoch);
  };

  const editHost = (v: string) => {
    clearSuccess();
    setHost(v);
  };
  const editPort = (v: string) => {
    clearSuccess();
    setPort(v);
  };
  const editUsername = (v: string) => {
    clearSuccess();
    setUsername(v);
  };

  useEffect(() => {
    if (open) {
      setHost(defaultHost ?? "");
      setPort(String(defaultPort ?? 22));
      setUsername(defaultUsername ?? "");
      setPassword("");
      // Dismiss any stale success from a previous session so the dialog
      // opens clean even though useActionState state persists.
      setDismissedEpoch(successEpochRef.current);
    }
  }, [open, defaultHost, defaultPort, defaultUsername]);

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
        <form action={installAction} className="space-y-4">
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2 space-y-2">
              <Label htmlFor="install-host">Host *</Label>
              {/*
                P2#6: aria-required so screen readers announce
                'required' when focus enters the field. Visual '*'
                in the Label is decorative — AT doesn't reliably
                map asterisk-in-text to required-state. The blank-
                field check below feeds aria-invalid on submit.
              */}
              <Input
                id="install-host"
                placeholder="server.example.com"
                value={host}
                aria-required="true"
                aria-invalid={!!error && !host.trim()}
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
              aria-required="true"
              aria-invalid={!!error && !username.trim()}
              onChange={(e) => editUsername(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="install-pw">One-time Password *</Label>
            <PasswordInput
              id="install-pw"
              placeholder="••••••••"
              value={password}
              aria-required="true"
              aria-invalid={!!error && !password}
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
          {effectiveSuccess && (
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
              {effectiveSuccess ? "Done" : "Close"}
            </Button>
            <Button
              type="submit"
              disabled={isSubmitting || effectiveSuccess || !!portError}
              aria-busy={isSubmitting}
            >
              {isSubmitting
                ? "Installing..."
                : effectiveSuccess
                  ? "Installed"
                  : "Install"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
