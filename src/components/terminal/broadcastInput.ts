import { preparePaste } from "@/lib/snippets";
import { acceptsBracketedPaste, isLiveShell, writeToSession } from "@/lib/terminalRegistry";
import { useTerminalsStore } from "@/store/useTerminalsStore";
import type { TerminalExtension } from "./extensions";

/**
 * The escape sequences a key can produce, as xterm encodes them: Esc, Alt
 * plus a key, cursor keys in both modes, Home and End, Shift+Tab, F1 to F12
 * and the keys ending in `~`, each with or without modifiers. Modified F3
 * (`CSI 1 ; m R`) is left out: it reads exactly like a cursor position report.
 */
const KEY_SEQUENCE =
  // eslint-disable-next-line no-control-regex
  /^\x1b(?:[\s\S]?|\[[A-DFHZ]|O[A-DFHP-S]|\[\d+(?:;\d+)?~|\[1;\d+[A-DFHPQS])$/;

// eslint-disable-next-line no-control-regex
const BRACKETED_PASTE = /^\x1b\[200~([\s\S]*)\x1b\[201~$/;

/**
 * Whether what a terminal sent is something the user typed or pasted. xterm
 * also sends other things through `onData`: mouse reports and focus changes,
 * and its answers to a program's queries (cursor position, device attributes,
 * colours). Those describe that one pane, and in another pane's shell they
 * would land as garbage on the prompt. All of them start with an escape, so
 * only the sequences a key can produce pass.
 */
export function isTypedInput(data: string): boolean {
  if (!data.startsWith("\x1b")) return true;
  return KEY_SEQUENCE.test(data) || BRACKETED_PASTE.test(data);
}

/**
 * What another pane gets of a bracketed paste, or null for nothing. Only a program
 * that asked for bracketed paste knows the markers: elsewhere a line break between
 * them is Enter, and the lines run. So this follows the snippet palette's rules.
 */
function pasteFor(sessionId: string, paste: string, text: string): string | null {
  if (acceptsBracketedPaste(sessionId)) return paste;
  const plain = preparePaste(text, false);
  return "text" in plain ? plain.text : null;
}

/**
 * Broadcast input: what is typed or pasted in one pane of a tab with broadcast
 * on also goes to the tab's other live panes. `writeToSession` runs no `onData`
 * hooks, so this cannot loop. It also means text sent that way, such as a
 * pasted snippet, is not mirrored: see `docs/terminal-ux.md`.
 */
export const broadcastInput: TerminalExtension = {
  id: "broadcast-input",
  onData({ sessionId }, data) {
    const tab = useTerminalsStore
      .getState()
      .tabs.find((candidate) => candidate.panes.some((pane) => pane.sessionId === sessionId));
    if (!tab?.broadcast || !isTypedInput(data)) return data;
    const source = tab.panes.find((pane) => pane.sessionId === sessionId);
    // Keys typed in a pane that lost its connection are dropped, not sent elsewhere.
    if (!source || !isLiveShell(source)) return data;
    const paste = BRACKETED_PASTE.exec(data);
    const skipped: string[] = [];
    for (const pane of tab.panes) {
      if (pane === source || !isLiveShell(pane)) continue;
      const text = paste ? pasteFor(pane.sessionId, data, paste[1]) : data;
      if (text === null) skipped.push(pane.connectionName);
      else writeToSession(pane.sessionId, text);
    }
    if (paste) useTerminalsStore.getState().noteBroadcastSkipped(tab.id, skipped);
    return data;
  },
};
