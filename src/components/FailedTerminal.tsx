import { useEffect, useState } from "react";
import { AlertCircle, RefreshCw, Pencil, ShieldAlert } from "lucide-react";
import { Button } from "./ui/button";
import { Connection } from "@/types";
import { invoke } from "@/lib/tauri";
import { parseHostKeyMismatch } from "@/lib/hostKey";
import { secondsUntilRetry, type ReconnectState } from "@/lib/reconnect";

interface FailedTerminalProps {
  connectionName: string;
  error?: string;
  connection?: Connection;
  isVisible: boolean;
  retrying?: boolean;
  /**
   * Set when a live shell lost its connection. The view then docks at the top
   * of the pane, over the mounted terminal, so the scrollback stays readable.
   */
  reconnect?: ReconnectState;
  onCancelReconnect?: () => void;
  onRetry: (conn: Connection) => void;
  onEdit: (conn: Connection) => void;
  onClose: () => void;
}

/** Seconds left before `retryAt`, ticking while `retryAt` is set. */
function useRetryCountdown(retryAt: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (retryAt === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [retryAt]);
  return retryAt === undefined ? 0 : secondsUntilRetry(retryAt, now);
}

export function FailedTerminal({
  connectionName,
  error,
  connection,
  isVisible,
  retrying = false,
  reconnect,
  onCancelReconnect,
  onRetry,
  onEdit,
  onClose,
}: FailedTerminalProps) {
  const mismatch = parseHostKeyMismatch(error);
  const [trusting, setTrusting] = useState(false);
  const [trustError, setTrustError] = useState<string | null>(null);
  const waiting = reconnect?.phase === "waiting" ? reconnect : undefined;
  const secondsLeft = useRetryCountdown(waiting?.retryAt);

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
      className={
        reconnect
          ? "absolute inset-x-0 top-0 z-10 flex justify-center border-b border-border bg-card py-3 shadow-sm"
          : "absolute inset-0 flex items-center justify-center bg-background"
      }
      style={{ display: isVisible ? "flex" : "none" }}
      data-testid="failed-terminal"
      data-error={error || ""}
      data-reconnect-phase={reconnect?.phase}
      data-reconnect-attempt={waiting?.attempt}
    >
      <div
        className={`flex flex-col items-center max-w-md w-full mx-6 text-center ${reconnect ? "gap-2" : "gap-4"}`}
      >
        <AlertCircle
          aria-hidden="true"
          className={`${reconnect ? "h-5 w-5" : "h-10 w-10"} shrink-0 ${error || waiting ? "text-destructive" : "text-muted-foreground"}`}
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
                : reconnect
                  ? `Connection to ${connectionName} lost`
                  : `Could not connect to ${connectionName}`
              : waiting
                ? `Connection to ${connectionName} lost`
                : `Connecting to ${connectionName}…`}
          </p>
          {waiting && (
            <>
              <p className="text-xs text-foreground">
                {`Reconnecting: attempt ${waiting.attempt} of ${waiting.maxAttempts}`}
                {/* Ticks every second, so it stays out of the live region's announcements. */}
                <span aria-hidden="true" data-testid="reconnect-countdown">
                  {secondsLeft > 0 ? ` in ${secondsLeft} s` : "…"}
                </span>
              </p>
              <p className="text-xs text-muted-foreground font-mono break-all mt-1">
                {waiting.message}
              </p>
            </>
          )}
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
          {waiting && (
            <Button
              size="sm"
              variant="outline"
              onClick={onCancelReconnect}
              data-testid="reconnect-cancel-button"
            >
              Cancel
            </Button>
          )}
          {!waiting && connection && mismatch && (
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
          {!waiting && connection && (
            <>
              <Button
                size="sm"
                variant={mismatch ? "outline" : "default"}
                disabled={retrying}
                onClick={() => onRetry(connection)}
                data-testid="failed-terminal-retry"
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
                data-testid="failed-terminal-edit"
              >
                <Pencil aria-hidden="true" className="h-3.5 w-3.5 mr-1.5" />
                Edit Connection
              </Button>
            </>
          )}
          {!waiting && (
            <Button
              size="sm"
              variant={retrying && !error ? "destructive" : "ghost"}
              onClick={onClose}
              data-testid="failed-terminal-dismiss"
            >
              {retrying && !error ? "Cancel" : reconnect ? "Close terminal" : "Dismiss"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
