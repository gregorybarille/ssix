/**
 * Pure helpers for the Files view, and the channel its transfers report on.
 */
import { parseHostKeyMismatch } from "./hostKey";
import { assertTauriRuntime } from "./runtime";
import type { FileEntry, TransferEvent } from "@/types";

/**
 * Starts an error that ended the remote pane's session. Mirrors
 * `SESSION_LOST` in `src-tauri/src/commands/sftp.rs`.
 */
const SESSION_LOST = "SFTP_SESSION_LOST";

export function isSessionLost(error: string): boolean {
  return error.startsWith(SESSION_LOST);
}

/** A backend error as a person should read it, without its machine marker. */
export function readableSftpError(error: string): string {
  const mismatch = parseHostKeyMismatch(error);
  if (mismatch) return mismatch.message;
  return isSessionLost(error) ? error.slice(SESSION_LOST.length).trimStart() : error;
}

export function formatSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit]}`;
}

export function formatModified(seconds: number | null): string {
  return seconds === null ? "" : new Date(seconds * 1000).toLocaleString();
}

/** A mode typed in octal (`644`, `0755`), or null if it is not one. */
export function parseMode(text: string): number | null {
  const trimmed = text.trim();
  return /^[0-7]{3,4}$/.test(trimmed) ? Number.parseInt(trimmed, 8) : null;
}

export function formatModeOctal(mode: number | null): string {
  return mode === null ? "" : mode.toString(8).padStart(3, "0");
}

/** `rwxr-x---`, with `s`/`t` for the special bits as `ls -l` shows them. */
export function formatModeSymbolic(mode: number | null): string {
  if (mode === null) return "";
  const triad = (shift: number, special: number, letter: string) => {
    const bits = (mode >> shift) & 7;
    const execute = (bits & 1) !== 0;
    const executeChar = execute ? "x" : "-";
    const specialChar = execute ? letter : letter.toUpperCase();
    const last = (mode & special) !== 0 ? specialChar : executeChar;
    return `${bits & 4 ? "r" : "-"}${bits & 2 ? "w" : "-"}${last}`;
  };
  return triad(6, 0o4000, "s") + triad(3, 0o2000, "s") + triad(0, 0o1000, "t");
}

/** Whether a row opens as a folder. */
export function opensAsFolder(entry: FileEntry): boolean {
  return entry.kind === "dir" || entry.target_is_dir;
}

/** The last component of a path from either side, for showing a name. */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() || path;
}

// Several transfers often start together; they share one load of the module.
let tauriCore: Promise<typeof import("@tauri-apps/api/core")> | null = null;

/** The channel `sftp_start_transfer` reports on. */
export async function createTransferChannel(
  onEvent: (event: TransferEvent) => void,
): Promise<unknown> {
  // `new Channel` reaches into the Tauri bridge, like `invoke`.
  assertTauriRuntime();
  tauriCore ??= import("@tauri-apps/api/core");
  const { Channel } = await tauriCore;
  return new Channel<TransferEvent>(onEvent);
}
