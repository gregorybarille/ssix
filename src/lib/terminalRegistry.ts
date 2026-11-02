import type { Terminal as XTerm } from "@xterm/xterm";
import { useTerminalsStore } from "@/store/useTerminalsStore";
import { errorMessage } from "./errors";
import { log as appLog } from "./log";
import { invoke } from "./tauri";

/**
 * Live xterm instances by session id, for code outside a `<Terminal>` that
 * has to reach one: sending text to a session, finding the active one.
 *
 * The WebGL renderer draws to a canvas, so a terminal's text is no longer
 * in the DOM. The e2e suite reads it through `window.__ssixTerminalText`
 * instead; nothing else should depend on that.
 */
const terminals = new Map<string, XTerm>();

/**
 * The session that last had keyboard focus. It survives focus moving to a
 * palette or panel, and its terminal unmounting with the Terminals view:
 * `activeSessionId` trusts it only while that session has a live terminal.
 */
let lastFocusedSessionId: string | null = null;

/** The session `handKeyboardTo` gave the keyboard, until an Enter there ends `isHeldEnter`. */
let heldEnterSessionId: string | null = null;

/** Call after `term.open()`: xterm has no input element to watch before that. */
export function registerTerminal(sessionId: string, term: XTerm): void {
  terminals.set(sessionId, term);
  term.textarea?.addEventListener("focus", () => {
    lastFocusedSessionId = sessionId;
  });
}

export function unregisterTerminal(sessionId: string): void {
  terminals.delete(sessionId);
  if (heldEnterSessionId === sessionId) heldEnterSessionId = null;
}

/** Give the keyboard to a session's terminal, when it can take it. */
export function focusSession(sessionId: string): void {
  terminals.get(sessionId)?.focus();
}

/**
 * Send text to a session as if it were typed: it goes straight to `ssh_write`,
 * like keyboard input, and the remote shell echoes it. Terminal extensions'
 * `onData` hooks do not run, so an extension can call this without looping.
 *
 * Returns whether the session has a live terminal to send to. A write that
 * fails after that is logged; the session's `closed` notification follows it.
 */
export function writeToSession(sessionId: string, text: string): boolean {
  if (!terminals.has(sessionId)) return false;
  invoke("ssh_write", { sessionId, data: text }).catch((error) => {
    appLog.error("terminal", `Could not write to the session: ${errorMessage(error)}`);
  });
  return true;
}

/**
 * Whether the program in this session asked for bracketed paste (DECSET 2004),
 * so line breaks inside a paste reach it as text instead of pressing Enter.
 * A terminal that just remounted knows only what it has seen since: bash and
 * zsh ask again at their next prompt.
 */
export function acceptsBracketedPaste(sessionId: string): boolean {
  return terminals.get(sessionId)?.modes.bracketedPasteMode ?? false;
}

/**
 * Give a session's terminal the keyboard after a paste. The Enter that chose
 * the snippet may still be down: see `isHeldEnter`.
 */
export function handKeyboardTo(sessionId: string): void {
  heldEnterSessionId = sessionId;
  terminals.get(sessionId)?.focus();
}

/**
 * Whether this key event is the auto-repeat of an Enter pressed before the
 * terminal had the keyboard. It must not reach the shell, or holding the key
 * would run what was just pasted. Releasing Enter or pressing it afresh ends
 * this, so a release the terminal never saw costs nothing, and holding a later
 * Enter repeats as usual.
 */
export function isHeldEnter(sessionId: string, e: KeyboardEvent): boolean {
  if (e.key !== "Enter" || heldEnterSessionId !== sessionId) return false;
  if (e.repeat) return true;
  heldEnterSessionId = null;
  return false;
}

/**
 * The live session of the active terminal tab: the pane that last had focus,
 * otherwise the tab's first live pane. `null` when the active tab has none
 * (no tab open, or only failed panes).
 */
export function activeSessionId(): string | null {
  const { tabs, activeTabId } = useTerminalsStore.getState();
  const panes = tabs.find((tab) => tab.id === activeTabId)?.panes ?? [];
  const live = panes.map((pane) => pane.sessionId).filter((id) => terminals.has(id));
  return live.find((id) => id === lastFocusedSessionId) ?? live[0] ?? null;
}

function bufferText(term: XTerm): string {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join("\n");
}

/**
 * Text of one terminal's active buffer, or of every open terminal when no
 * session id is given. Returns null when the session is unknown.
 */
export function terminalText(sessionId?: string): string | null {
  if (sessionId) {
    const term = terminals.get(sessionId);
    return term ? bufferText(term) : null;
  }
  return [...terminals.values()].map(bufferText).join("\n");
}

declare global {
  interface Window {
    __ssixTerminalText?: (sessionId?: string) => string | null;
  }
}

if (typeof window !== "undefined") {
  window.__ssixTerminalText = terminalText;
}
