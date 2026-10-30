import { useState } from "react";
import { AlertCircle, RefreshCw, Pencil, ShieldAlert } from "lucide-react";
import { Button } from "./ui/button";
import { Connection } from "@/types";
import { invoke } from "@/lib/tauri";
import { parseHostKeyMismatch } from "@/lib/hostKey";

interface FailedTerminalProps {
  connectionName: string;
  error?: string;
  connection?: Connection;
  isVisible: boolean;
  retrying?: boolean;
  onRetry: (conn: Connection) => void;
  onEdit: (conn: Connection) => void;
  onClose: () => void;
}

export function FailedTerminal({
  connectionName,
  error,
  connection,
  isVisible,
  retrying = false,
  onRetry,
  onEdit,
  onClose,
}: FailedTerminalProps) {
  const mismatch = parseHostKeyMismatch(error);
  const [trusting, setTrusting] = useState(false);
  const [trustError, setTrustError] = useState<string | null>(null);

  const trustNewHostKey = async () => {
    if (!mismatch || !connection) return;
    setTrusting(true);
    setTrustError(null);
    try {
      await invoke("ssh_forget_host_key", { host: mismatch.host, port: mismatch.port });
      onRetry(connection);
    } catch (err) {
      setTrustError(String(err));
    } finally {
      setTrusting(false);
    }
  };

  return (
    <div
      className="absolute inset-0 flex items-center justify-center bg-background"
      style={{ display: isVisible ? "flex" : "none" }}
      data-testid="failed-terminal"
      data-error={error || ""}
    >
      <div className="flex flex-col items-center gap-4 max-w-md w-full mx-6 text-center">
        <AlertCircle
          aria-hidden="true"
          className={`h-10 w-10 shrink-0 ${error ? "text-destructive" : "text-muted-foreground"}`}
        />
        {/*
          Connection failures are announced to screen readers: the status
          block lives in role=alert + aria-live=assertive when there is an
          error, and role=status + polite while connecting.
        */}
        <div
          role={error ? "alert" : "status"}
          aria-live={error ? "assertive" : "polite"}
          aria-atomic="true"
        >
          <p className="text-sm font-semibold text-foreground mb-1">
            {error
              ? mismatch
                ? `Host key for ${mismatch.host}:${mismatch.port} has changed`
                : `Could not connect to ${connectionName}`
              : `Connecting to ${connectionName}…`}
          </p>
          {error && mismatch && (
            <>
              <p className="text-xs text-muted-foreground break-words">{mismatch.message}</p>
              <p className="text-xs text-muted-foreground-soft font-mono break-all mt-1">
                {mismatch.fingerprint}
              </p>
            </>
          )}
          {error && !mismatch && (
            <p className="text-xs text-muted-foreground font-mono break-all">{error}</p>
          )}
          {trustError && (
            <p className="text-xs text-destructive break-words mt-1">{trustError}</p>
          )}
        </div>
        <div className="flex gap-2 flex-wrap justify-center">
          {connection && mismatch && (
            <Button
              size="sm"
              variant="destructive"
              disabled={retrying || trusting}
              onClick={trustNewHostKey}
              data-testid="trust-host-key-button"
            >
              <ShieldAlert aria-hidden="true" className="h-3.5 w-3.5 mr-1.5" />
              {trusting ? "Trusting…" : "Trust new host key"}
            </Button>
          )}
          {connection && (
            <>
              <Button
                size="sm"
                variant={mismatch ? "outline" : "default"}
                disabled={retrying}
                onClick={() => onRetry(connection)}
              >
                <RefreshCw
                  aria-hidden="true"
                  className={`h-3.5 w-3.5 mr-1.5 ${retrying ? "animate-spin" : ""}`}
                />
                {retrying ? "Retrying…" : "Retry"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={retrying}
                onClick={() => onEdit(connection)}
              >
                <Pencil aria-hidden="true" className="h-3.5 w-3.5 mr-1.5" />
                Edit Connection
              </Button>
            </>
          )}
          <Button size="sm" variant={retrying && !error ? "destructive" : "ghost"} onClick={onClose}>
            {retrying && !error ? "Cancel" : "Dismiss"}
          </Button>
        </div>
      </div>
    </div>
  );
}
