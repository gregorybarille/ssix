/**
 * Backend event-name helpers.
 *
 * These mirror the helpers in `src-tauri/src/ssh.rs` (`ssh_error_event`,
 * `ssh_closed_event`, `tunnel_status_event`). Shell output is not an
 * event: it streams over the Tauri `Channel` created in
 * `src/lib/terminalOutput.ts` and passed to `ssh_connect`.
 *
 * The `ssix:` prefix namespaces our channels under our app so they
 * cannot collide with Tauri plugin events or with future frontend
 * `window.dispatchEvent` listeners (the frontend already uses an
 * `ssix:` prefix for its DOM events — see App.tsx `ssix:contextmenu`,
 * `ssix:terminal-paste`).
 *
 * Any rename here MUST be reflected in `src-tauri/src/ssh.rs` in the
 * same commit. Both sides go through these helpers so the contract
 * is one-point.
 */

export const sshErrorEvent = (sessionId: string) => `ssix:ssh:error:${sessionId}`;
export const sshClosedEvent = (sessionId: string) => `ssix:ssh:closed:${sessionId}`;
export const tunnelStatusEvent = (sessionId: string) => `ssix:tunnel:status:${sessionId}`;
