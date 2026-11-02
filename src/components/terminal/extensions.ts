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
 * throws is skipped, so it cannot take keyboard input or output down with it,
 * and logged once per hook, so one running on every chunk cannot flood the log.
 */
export interface TerminalExtension {
  id: string;
  /**
   * After the terminal is opened and before any output is written to it.
   * Return a function to release what it took: it runs when this terminal
   * unmounts, before xterm is disposed.
   */
  onCreate?(ctx: TerminalExtensionContext): void | (() => void);
  /**
   * Keyboard and paste input on its way to the session. Return the text to
   * send (the argument, to leave it alone) or `null` to swallow it. Each
   * extension sees what the previous one returned.
   */
  onData?(ctx: TerminalExtensionContext, data: string): string | null;
  /** Shell output, after it was handed to xterm. Observe it only: do not keep or change `bytes`. */
  onOutput?(ctx: TerminalExtensionContext, bytes: Uint8Array): void;
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

const reportedFailures = new WeakMap<TerminalExtension, Set<string>>();

function guarded<T>(extension: TerminalExtension, hook: string, call: () => T): T | undefined {
  try {
    return call();
  } catch (error) {
    const reported = reportedFailures.get(extension) ?? new Set<string>();
    if (!reported.has(hook)) {
      reportedFailures.set(extension, reported.add(hook));
      appLog.error(
        "terminal",
        `Terminal extension ${extension.id} failed in ${hook}, further failures of this hook are not logged: ${errorMessage(error)}`,
      );
    }
    return undefined;
  }
}

/**
 * Run every `onCreate`. The returned function is for the terminal's unmount:
 * it runs the cleanups those calls returned, whatever the registry holds by
 * then, last first so an extension can still rely on the ones before it.
 */
export function runTerminalCreate(ctx: TerminalExtensionContext): () => void {
  const cleanups: (() => void)[] = [];
  for (const extension of extensions) {
    const cleanup = guarded(extension, "onCreate", () => extension.onCreate?.(ctx));
    if (typeof cleanup === "function") {
      cleanups.push(() => guarded(extension, "cleanup", cleanup));
    }
  }
  return () => cleanups.reverse().forEach((cleanup) => cleanup());
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
