/**
 * Human-readable text for a caught value. Tauri commands reject with plain
 * strings while frontend code throws `Error`s; `String(new Error("x"))`
 * would show "Error: x", so the message is unwrapped.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
