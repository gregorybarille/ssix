/**
 * Tauri runtime detection.
 *
 * The desktop webview injects `window.__TAURI_INTERNALS__` before any app
 * code runs, and every `@tauri-apps/api` call goes through it. The Vite dev
 * server (`npm run dev`, http://localhost:1420) opened in a regular browser
 * has no such bridge, so a backend call would fail with an opaque
 * "__TAURI_INTERNALS__ is undefined" TypeError. Checking first turns that
 * into one readable message that every view can show.
 */

export const TAURI_UNAVAILABLE_MESSAGE =
  'SSIX is running outside its desktop app, so it cannot reach the backend. Start it with "npm run tauri dev" instead of opening the dev server in a browser.';

/** True inside the Tauri webview. */
export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Throw `TAURI_UNAVAILABLE_MESSAGE` unless running inside the Tauri webview. */
export function assertTauriRuntime(): void {
  if (!isTauriRuntime()) throw new Error(TAURI_UNAVAILABLE_MESSAGE);
}
