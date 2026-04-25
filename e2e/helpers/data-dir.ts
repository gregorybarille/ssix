/**
 * Shared SSX state directory for the E2E suite.
 *
 * Sets `SSX_DATA_DIR` to a single fresh `mkdtemp` location BEFORE the
 * Tauri app starts (in wdio.conf.ts `onPrepare`). All specs share the
 * same data dir for the duration of the run, because the Tauri app
 * subprocess is spawned once and reads the env var at startup —
 * mutating `process.env` between specs has no effect.
 *
 * Cross-spec isolation is achieved by every spec using unique
 * credential / connection names (e.g. `cred-a-pw`, `conn-b`).
 *
 * The override is honored by both `storage::data_dir()` and
 * `keychain::secrets_path()` (see src-tauri unit tests).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let sharedDir: string | null = null;

/**
 * Create the shared data dir and export `SSX_DATA_DIR`. Idempotent —
 * subsequent calls return the same path. Call from wdio.conf.ts
 * `onPrepare` (preferred) or from any spec `before()` (fallback).
 */
export function setupTestDataDir(): string {
  if (sharedDir) return sharedDir;
  sharedDir = mkdtempSync(join(tmpdir(), "ssx-e2e-"));
  process.env.SSX_DATA_DIR = sharedDir;
  return sharedDir;
}

/**
 * Tear down the shared data dir. Call from wdio.conf.ts `onComplete`
 * (preferred) or from a spec `after()` if you know the suite is
 * single-spec. No-op if `setupTestDataDir` was never called.
 */
export function cleanupTestDataDir(): void {
  if (sharedDir) {
    try {
      rmSync(sharedDir, { recursive: true, force: true });
    } catch {
      // best effort — CI runner is ephemeral
    }
    sharedDir = null;
    delete process.env.SSX_DATA_DIR;
  }
}

export function currentTestDataDir(): string | null {
  // `sharedDir` is set when setupTestDataDir() was called in this process
  // (e.g. in wdio.conf.ts onPrepare). In WDIO worker processes the
  // module is re-imported fresh, so sharedDir is null — fall back to the
  // env var which is inherited from the parent process or set by CI.
  return sharedDir ?? process.env.SSX_DATA_DIR ?? null;
}
