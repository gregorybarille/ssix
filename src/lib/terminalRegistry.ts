import type { Terminal as XTerm } from "@xterm/xterm";
import { useAuthPromptStore } from "@/store/useAuthPromptStore";
import { useTerminalsStore } from "@/store/useTerminalsStore";
import { useViewStore } from "@/store/useViewStore";
import { errorMessage } from "./errors";
import { log as appLog } from "./log";
import { invoke } from "./tauri";

/**
 * Live xterm instances by session id, for code outside a `<Terminal>` that
 * has to reach one: sending text to a session, finding the active one.
 *
 * The WebGL renderer draws to a canvas, so a terminal's text is no longer
 * in the DOM. The e2e suite reads it through `window.__ssixTerminalText` and
 * `window.__ssixTerminalState` instead; nothing else should depend on those.
 */
const terminals = new Map<string, XTerm>();

/**
 * The session that last had keyboard focus. It survives focus moving to a
 * palette or panel, and its terminal being replaced: `activeSessionId` trusts
 * it only while that session can take input.
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

/**
 * Whether text may go to a session: it has a terminal, and no login prompt over
 * it. A dropped shell logging in again keeps its terminal behind the prompt, and
 * what the user is shown there is a question, not a shell.
 */
function takesInput(sessionId: string): boolean {
  return terminals.has(sessionId) && !useAuthPromptStore.getState().prompts[sessionId];
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
 * Returns whether the session can take text (see `takesInput`). A write that
 * fails after that is logged; the session's `closed` notification follows it.
 */
export function writeToSession(sessionId: string, text: string): boolean {
  if (!takesInput(sessionId)) return false;
  invoke("ssh_write", { sessionId, data: text }).catch((error) => {
    appLog.error("terminal", `Could not write to the session: ${errorMessage(error)}`);
  });
  return true;
}

/**
 * Whether the program in this session asked for bracketed paste (DECSET 2004),
 * so line breaks inside a paste reach it as text instead of pressing Enter.
 * A terminal knows only what it has seen, which starts over when its pane opens
 * again (a split tab closing to one pane, say): bash and zsh ask again at their
 * next prompt.
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
 * The session of the terminal the user is looking at: the active tab's pane that
 * last had focus, otherwise its first pane that can take input. `null` when there
 * is none: on another view, where terminals stay mounted but none is on screen,
 * and with no tab open or only failed panes or panes behind a login prompt.
 */
export function activeSessionId(): string | null {
  if (useViewStore.getState().view !== "terminals") return null;
  const { tabs, activeTabId } = useTerminalsStore.getState();
  const panes = tabs.find((tab) => tab.id === activeTabId)?.panes ?? [];
  const live = panes.map((pane) => pane.sessionId).filter(takesInput);
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

/** What the e2e suite checks of a terminal. */
export interface TerminalState {
  cols: number;
  rows: number;
  fontSize: number | undefined;
  fontFamily: string | undefined;
  background: string | undefined;
  bracketedPaste: boolean;
  focused: boolean;
  /** The buffer line at the top of the screen. */
  viewportY: number;
}

/** One terminal's state, or null when the session is unknown. */
export function terminalState(sessionId: string): TerminalState | null {
  const term = terminals.get(sessionId);
  if (!term) return null;
  return {
    cols: term.cols,
    rows: term.rows,
    fontSize: term.options.fontSize,
    fontFamily: term.options.fontFamily,
    background: term.options.theme?.background,
    bracketedPaste: term.modes.bracketedPasteMode,
    focused: document.activeElement === term.textarea,
    viewportY: term.buffer.active.viewportY,
  };
}

declare global {
  interface Window {
    __ssixTerminalText?: (sessionId?: string) => string | null;
    __ssixTerminalState?: (sessionId: string) => TerminalState | null;
  }
}

if (typeof window !== "undefined") {
  window.__ssixTerminalText = terminalText;
  window.__ssixTerminalState = terminalState;
}
