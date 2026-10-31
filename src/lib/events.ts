/**
 * Backend event-name helpers.
 *
 * These mirror the helpers in `src-tauri/src/ssh.rs` (`forward_status_event`).
 * Shell output and per-session `error` / `closed` notifications are not
 * events: they travel over the Tauri `Channel` created in
 * `src/lib/terminalOutput.ts` and passed to `ssh_connect`, so they stay
 * ordered with the bytes and are buffered until the terminal mounts.
 *
 * The `ssix:` prefix namespaces our channels under our app so they
 * cannot collide with Tauri plugin events or with future frontend
 * `window.dispatchEvent` listeners (the frontend already uses an
 * `ssix:` prefix for its DOM events — see `ssix:contextmenu`,
 * `ssix:terminal-paste`).
 *
 * Any rename here MUST be reflected in `src-tauri/src/ssh.rs` in the
 * same commit. Both sides go through these helpers so the contract
 * is one-point.
 */

export const forwardStatusEvent = (sessionId: string) => `ssix:forward:status:${sessionId}`;
