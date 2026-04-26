/**
 * Capture the SSX Rust backend's in-memory log buffer from inside the
 * running WebView via the existing `get_logs` Tauri command.
 *
 * Why this exists
 * ---------------
 * `tauri-driver` spawns the SSX binary as a grandchild process and
 * does NOT forward its stdio, so redirecting tauri-driver's own
 * stdio captures only WebKitWebDriver chatter — never `eprintln!`
 * from `src-tauri/src/`. The production app already maintains a
 * ring buffer (`src-tauri/src/logs.rs`, exposed as the `get_logs`
 * Tauri command) for the in-app log viewer; we reuse it from E2E
 * to surface backend-side errors when a spec fails.
 *
 * Format mirrors `LogEntry` in `src-tauri/src/logs.rs` (kept in sync
 * via `ts-rs`); duplicating the shape here avoids importing frontend
 * types into the e2e tree.
 */
export interface BackendLogEntry {
  ts: number;
  level: string;
  source: string;
  message: string;
}

/**
 * Pull the in-memory backend log buffer.
 *
 * Returns `null` if the Tauri runtime isn't reachable (e.g. the
 * WebView crashed before this runs); callers should treat that as
 * "no backend logs available" rather than a hard failure so they
 * don't mask the original assertion error.
 */
export async function fetchBackendLogs(): Promise<BackendLogEntry[] | null> {
  try {
    const result = await browser.executeAsync<BackendLogEntry[] | { __ssxError: string }>(
      function (done) {
        // Tauri v2 exposes invoke at window.__TAURI__.core.invoke.
        // Use any-cast inside the browser context (no TS in the
        // injected script).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = window as any;
        const invoke = w?.__TAURI__?.core?.invoke;
        if (typeof invoke !== "function") {
          done({ __ssxError: "window.__TAURI__.core.invoke is not a function" });
          return;
        }
        invoke("get_logs")
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .then((entries: any) => done(entries))
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .catch((err: any) => done({ __ssxError: String(err) }));
      },
    );
    if (result && typeof result === "object" && "__ssxError" in result) {
      return null;
    }
    return result as BackendLogEntry[];
  } catch {
    return null;
  }
}

/**
 * Render backend logs as a single human-readable string suitable for
 * dumping into a CI artifact file. Empty buffer yields a one-line
 * marker so a missing log file vs. a healthy-but-quiet backend are
 * easy to tell apart in CI logs.
 */
export function formatBackendLogs(entries: BackendLogEntry[] | null): string {
  if (entries === null) {
    return "(backend logs unavailable — Tauri runtime not reachable)\n";
  }
  if (entries.length === 0) {
    return "(backend log buffer empty)\n";
  }
  return (
    entries
      .map((e) => {
        const iso = new Date(e.ts).toISOString();
        return `${iso} [${e.level.toUpperCase()}] ${e.source}: ${e.message}`;
      })
      .join("\n") + "\n"
  );
}
