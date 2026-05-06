/**
 * Audit-4 Phase 6c: backend event-name helpers.
 *
 * These mirror the helpers in `src-tauri/src/ssh.rs` (`ssh_output_event`,
 * `ssh_error_event`, `ssh_closed_event`, `tunnel_status_event`).
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

export const sshOutputEvent = (sessionId: string) => `ssix:ssh:output:${sessionId}`;
export const sshErrorEvent = (sessionId: string) => `ssix:ssh:error:${sessionId}`;
export const sshClosedEvent = (sessionId: string) => `ssix:ssh:closed:${sessionId}`;
export const tunnelStatusEvent = (sessionId: string) => `ssix:tunnel:status:${sessionId}`;
