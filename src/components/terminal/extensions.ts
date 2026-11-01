import type { Terminal as XTerm } from "@xterm/xterm";
import { errorMessage } from "@/lib/errors";
import { log as appLog } from "@/lib/log";
import type { AppSettings, Connection } from "@/types";

/** What a terminal hands to every extension. The same object for the terminal's whole life. */
export interface TerminalExtensionContext {
  /** The xterm instance, already opened and fitted. */
  term: XTerm;
  sessionId: string;
  /** The saved connection behind this terminal, when the pane knows it. */
  connection?: Connection;
  /** The terminal's current settings. Read it when needed: it follows live changes. */
  readonly settings: AppSettings | undefined;
}

/**
 * A behaviour plugged into every `<Terminal>`. Implement only the hooks you
 * need, then add the extension to `registerExtensions.ts`. An extension that
 * throws is logged and skipped, so it cannot take keyboard input or output
 * down with it.
 */
export interface TerminalExtension {
  id: string;
  /** After the terminal is opened and before any output is written to it. */
  onCreate?(ctx: TerminalExtensionContext): void;
  /**
   * Keyboard and paste input on its way to the session. Return the text to
   * send (the argument, to leave it alone) or `null` to swallow it. Each
   * extension sees what the previous one returned.
   */
  onData?(ctx: TerminalExtensionContext, data: string): string | null;
  /** Shell output, after it was handed to xterm. Observe it only: do not keep or change `bytes`. */
  onOutput?(ctx: TerminalExtensionContext, bytes: Uint8Array): void;
  /** When the terminal unmounts, before xterm is disposed. Release what `onCreate` took. */
  dispose?(ctx: TerminalExtensionContext): void;
}

const extensions: TerminalExtension[] = [];

/** The registered extensions, in the order their hooks run. */
export const terminalExtensions: readonly TerminalExtension[] = extensions;

/**
 * Add an extension at the end of the list. Registering an id again replaces
 * that extension in place, so a hot reload neither duplicates nor reorders
 * it. Returns a function that removes it.
 */
export function registerTerminalExtension(extension: TerminalExtension): () => void {
  const existing = extensions.findIndex((e) => e.id === extension.id);
  if (existing >= 0) extensions[existing] = extension;
  else extensions.push(extension);
  return () => {
    const index = extensions.indexOf(extension);
    if (index >= 0) extensions.splice(index, 1);
  };
}

function guarded<T>(extension: TerminalExtension, hook: string, call: () => T): T | undefined {
  try {
    return call();
  } catch (error) {
    appLog.error(
      "terminal",
      `Terminal extension ${extension.id} failed in ${hook}: ${errorMessage(error)}`,
    );
    return undefined;
  }
}

export function runTerminalCreate(ctx: TerminalExtensionContext): void {
  for (const extension of extensions) {
    guarded(extension, "onCreate", () => extension.onCreate?.(ctx));
  }
}

/** The input to send after every extension saw it, or `null` if one swallowed it. */
export function runTerminalData(ctx: TerminalExtensionContext, data: string): string | null {
  let current = data;
  for (const extension of extensions) {
    if (!extension.onData) continue;
    const next = guarded(extension, "onData", () => extension.onData?.(ctx, current));
    if (next === null) return null;
    if (next !== undefined) current = next;
  }
  return current;
}

export function runTerminalOutput(ctx: TerminalExtensionContext, bytes: Uint8Array): void {
  for (const extension of extensions) {
    if (extension.onOutput) guarded(extension, "onOutput", () => extension.onOutput?.(ctx, bytes));
  }
}

/** Runs in reverse, so an extension can still rely on the ones registered before it. */
export function runTerminalDispose(ctx: TerminalExtensionContext): void {
  for (const extension of [...extensions].reverse()) {
    guarded(extension, "dispose", () => extension.dispose?.(ctx));
  }
}
