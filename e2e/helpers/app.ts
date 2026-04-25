/**
 * Helpers for resolving and launching the SSX Tauri binary under test.
 *
 * tauri-driver expects an absolute path to the built executable. We
 * prefer the debug build (faster iteration, no signing concerns) but
 * fall back to release if only that is present.
 */
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");

/**
 * Resolve the path to the SSX binary produced by `tauri build`.
 * Searches debug then release across linux/macos layouts.
 *
 * Throws with an actionable message if no binary exists yet — CI
 * builds the binary in the step before wdio runs, so a missing
 * binary is always a setup bug.
 */
export function resolveBinaryPath(): string {
  const candidates = [
    // Linux layout (CI + dockerized runner).
    resolve(ROOT, "src-tauri/target/debug/ssx"),
    resolve(ROOT, "src-tauri/target/release/ssx"),
    // macOS layout (won't actually run under tauri-driver but kept
    // for the "developer pointed wdio at a local build" diagnostic).
    resolve(ROOT, "src-tauri/target/debug/bundle/macos/ssx.app/Contents/MacOS/ssx"),
    resolve(ROOT, "src-tauri/target/release/bundle/macos/ssx.app/Contents/MacOS/ssx"),
    // Windows layout.
    resolve(ROOT, "src-tauri/target/debug/ssx.exe"),
    resolve(ROOT, "src-tauri/target/release/ssx.exe"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    `Could not find SSX binary. Looked in:\n  ${candidates.join("\n  ")}\n` +
      `Run \`npm run tauri build -- --debug\` first.`,
  );
}

/**
 * Convenience wrapper: wait until the React root has rendered the
 * Sidebar so specs can rely on the app being interactive.
 */
export async function waitForAppReady(timeoutMs = 30_000): Promise<void> {
  await browser.waitUntil(
    async () => {
      const el = await browser.$('[data-testid="sidebar"]');
      return el.isExisting();
    },
    {
      timeout: timeoutMs,
      timeoutMsg: "App did not finish rendering Sidebar within timeout",
    },
  );
}
