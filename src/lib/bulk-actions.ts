import type { Connection, ScpResult } from "@/types";
import { invoke } from "@/lib/tauri";
import { useTerminalsStore } from "@/store/useTerminalsStore";
import { suffixedLocalDownloadPath } from "@/lib/tags";

/**
 * Connections that can't participate in bulk SSH/SCP operations.
 * Currently only port-forward entries — they aren't real shells
 * and SCP commands reject them server-side anyway. Centralized so
 * the filter rule lives in one place if it ever changes.
 */
export function isBulkActionable(conn: Connection): boolean {
  return conn.type !== "port_forward";
}

/**
 * Fire `connect()` once per actionable connection, sequentially.
 *
 * "Sequentially" here means we await each call before starting the
 * next: each `connect()` resolves as soon as the placeholder pane
 * is in the store, well before the SSH handshake completes — the
 * actual handshakes still run in parallel server-side. The
 * sequential awaiting just guarantees deterministic tab order
 * (`prod` group → tabs appear in `connections` array order rather
 * than in handshake-completion order).
 *
 * Failures during the placeholder phase are swallowed and counted;
 * SSH errors that surface later show up on the affected pane via
 * the existing `ssx:ssh:error:{id}` event flow, exactly the same
 * way single-connection failures do today.
 */
export async function connectMany(
  connections: Connection[],
): Promise<{ started: number; skipped: number }> {
  const targets = connections.filter(isBulkActionable);
  const skipped = connections.length - targets.length;
  let started = 0;
  const connect = useTerminalsStore.getState().connect;
  for (const conn of targets) {
    try {
      await connect(conn, { mode: "tab" });
      started += 1;
    } catch {
      // Swallow per-connection placeholder errors so one bad
      // entry doesn't abort the whole batch. Errors that occur
      // during the actual SSH handshake surface on the pane via
      // the standard event channel, so they're still visible.
    }
  }
  return { started, skipped };
}

/** Per-host outcome for a bulk SCP operation. */
export interface BulkScpStep {
  connectionId: string;
  connectionName: string;
  /** Final remote path that was actually attempted (for download = input; for upload = backend-resolved). */
  remotePath: string;
  /** Final local path that was actually attempted (download = suffixed; upload = unchanged). */
  localPath: string;
  status: "pending" | "running" | "success" | "error" | "skipped";
  /** Bytes transferred on success; undefined otherwise. */
  bytes?: number;
  /** Item count on success; undefined otherwise. */
  entries?: number;
  /** Error message string when status === "error". */
  error?: string;
}

export interface BulkScpUploadInput {
  /** Local file or directory to push to every host. */
  localPath: string;
  /** Optional remote path; same value used for every host. */
  remotePath?: string;
  recursive: boolean;
}

export interface BulkScpDownloadInput {
  /** Remote path to fetch — same value used for every host. */
  remotePath: string;
  /** Local DIRECTORY where per-host files will be written. */
  localDir: string;
  recursive: boolean;
}

/**
 * Build the initial `BulkScpStep[]` array for an upload operation.
 * Port-forward connections become `"skipped"` rows so they're still
 * visible in the progress UI (silent skips are confusing — the user
 * needs to see why the count dropped).
 */
export function planBulkUpload(
  connections: Connection[],
  input: BulkScpUploadInput,
): BulkScpStep[] {
  return connections.map((conn) => ({
    connectionId: conn.id,
    connectionName: conn.name,
    remotePath: input.remotePath ?? conn.remote_path ?? "",
    localPath: input.localPath,
    status: isBulkActionable(conn) ? "pending" : "skipped",
    error: isBulkActionable(conn) ? undefined : "Port-forward connections cannot transfer files",
  }));
}

/**
 * Build the initial `BulkScpStep[]` for a download. Each step's
 * `localPath` is precomputed via {@link suffixedLocalDownloadPath}
 * so the user can see exactly where each file will land before
 * the transfer starts.
 */
export function planBulkDownload(
  connections: Connection[],
  input: BulkScpDownloadInput,
): BulkScpStep[] {
  return connections.map((conn) => ({
    connectionId: conn.id,
    connectionName: conn.name,
    remotePath: input.remotePath,
    localPath: suffixedLocalDownloadPath(
      input.localDir,
      input.remotePath,
      conn.name,
    ),
    status: isBulkActionable(conn) ? "pending" : "skipped",
    error: isBulkActionable(conn) ? undefined : "Port-forward connections cannot transfer files",
  }));
}

/**
 * Run a planned bulk SCP operation sequentially, invoking
 * `onProgress` with a fresh array on every status change so the
 * caller (a React component) can re-render. Sequential execution
 * gives us:
 *
 *  - predictable per-row UX (one row spins at a time),
 *  - bounded memory / no SFTP-handle storms,
 *  - simpler error narratives — a host that hangs only blocks the
 *    rest of the batch, never the whole IPC.
 *
 * The function never throws; per-host failures are recorded on the
 * row. The returned promise resolves once every row has reached a
 * terminal state.
 */
export async function runBulkScp(
  steps: BulkScpStep[],
  mode: "upload" | "download",
  recursive: boolean,
  onProgress: (steps: BulkScpStep[]) => void,
): Promise<BulkScpStep[]> {
  // Defensive copy — we mutate per-row state in place to avoid
  // re-allocating the whole array on every transition. The caller
  // gets a fresh shallow copy via the progress callback.
  const working = steps.map((s) => ({ ...s }));
  const emit = () => onProgress(working.map((s) => ({ ...s })));

  for (let i = 0; i < working.length; i++) {
    const step = working[i];
    if (step.status === "skipped") continue;
    step.status = "running";
    emit();
    try {
      const result =
        mode === "upload"
          ? await invoke<ScpResult>("scp_upload", {
              input: {
                connection_id: step.connectionId,
                local_path: step.localPath,
                remote_path: step.remotePath || undefined,
                recursive,
              },
            })
          : await invoke<ScpResult>("scp_download", {
              input: {
                connection_id: step.connectionId,
                local_path: step.localPath,
                remote_path: step.remotePath,
                recursive,
              },
            });
      step.status = "success";
      step.bytes = result.bytes;
      step.entries = result.entries;
      // Backend may resolve a relative remote path against
      // `conn.remote_path`; surface the real value to the user.
      step.remotePath = result.remote_path;
      step.localPath = result.local_path;
    } catch (err) {
      step.status = "error";
      step.error = err instanceof Error ? err.message : String(err);
    }
    emit();
  }
  return working;
}
