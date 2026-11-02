import type { ReconnectEvent } from "./terminalOutput";

/**
 * What a pane shows while its shell's connection is lost. The session's
 * worker in the backend owns the reconnect (`src-tauri/src/reconnect.rs`):
 * it keeps the session id, and with it the terminal's scrollback, and reports
 * its progress as {@link ReconnectEvent}s. See `docs/session-resilience.md`.
 *
 * - `waiting`: an attempt is about to start, or running since `retryAt`.
 * - `stopped`: nothing more happens until the user retries or closes the pane.
 */
export type ReconnectState =
  | {
      phase: "waiting";
      attempt: number;
      maxAttempts: number;
      /** When the attempt starts, in ms since the epoch. */
      retryAt: number;
      message: string;
    }
  | { phase: "stopped"; message: string };

/** How one event changes a pane. `retrying` and `error` drive the same fields as a first connect. */
export interface ReconnectPaneUpdate {
  reconnect: ReconnectState | undefined;
  retrying: boolean;
  error: string | undefined;
}

export function paneUpdateForReconnectEvent(event: ReconnectEvent, now: number): ReconnectPaneUpdate {
  switch (event.kind) {
    case "reconnecting":
      return {
        reconnect: {
          phase: "waiting",
          attempt: event.attempt,
          maxAttempts: event.max_attempts,
          retryAt: now + event.delay_ms,
          message: event.message,
        },
        retrying: true,
        error: undefined,
      };
    case "reconnect_stopped":
      return {
        reconnect: { phase: "stopped", message: event.message },
        retrying: false,
        error: event.message,
      };
    case "reconnected":
      return { reconnect: undefined, retrying: false, error: undefined };
  }
}

/** Whole seconds until `retryAt`, rounded up; 0 once the attempt is running. */
export function secondsUntilRetry(retryAt: number, now: number): number {
  return Math.max(0, Math.ceil((retryAt - now) / 1000));
}

/** The range `validate_keepalive_interval` accepts in `commands/settings.rs`. */
const MAX_KEEPALIVE_SECONDS = 3600;
/** The range `save_settings` accepts in `commands/settings.rs`. */
const MIN_RECONNECT_ATTEMPTS = 1;
const MAX_RECONNECT_ATTEMPTS = 20;

function clampedInteger(text: string, min: number, max: number): number | undefined {
  const n = Number.parseInt(text, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : undefined;
}

/** The seconds typed in a keepalive field; `undefined` when it holds no number. */
export function parseKeepaliveSeconds(text: string): number | undefined {
  return clampedInteger(text, 0, MAX_KEEPALIVE_SECONDS);
}

/** The attempts typed in the settings field; `undefined` when it holds no number. */
export function parseReconnectAttempts(text: string): number | undefined {
  return clampedInteger(text, MIN_RECONNECT_ATTEMPTS, MAX_RECONNECT_ATTEMPTS);
}
