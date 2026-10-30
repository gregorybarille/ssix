import type { Terminal as XTerm } from "@xterm/xterm";

/**
 * Live xterm instances by session id.
 *
 * The WebGL renderer draws to a canvas, so a terminal's text is no longer
 * in the DOM. The e2e suite reads it through `window.__ssixTerminalText`
 * instead; nothing else should depend on this.
 */
const terminals = new Map<string, XTerm>();

export function registerTerminal(sessionId: string, term: XTerm): void {
  terminals.set(sessionId, term);
}

export function unregisterTerminal(sessionId: string): void {
  terminals.delete(sessionId);
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
