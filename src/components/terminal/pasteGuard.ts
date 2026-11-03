import { stripControlChars } from "@/lib/snippets";
import { BRACKETED_PASTE } from "./broadcastInput";
import type { TerminalExtension } from "./extensions";

/**
 * Takes control characters out of a paste, under the same rule as a snippet.
 * xterm strips nothing, so clipboard text holding `ESC [ 201 ~` would end its
 * bracketed paste early and what follows would run. This is the one point every
 * paste passes through, xterm's own paste listener included.
 *
 * A program that did not ask for bracketed paste gets no markers to go by, but
 * xterm sends each key on its own, and only sequences starting with an escape
 * run to several characters. So anything else that long is pasted text.
 */
export const pasteGuard: TerminalExtension = {
  id: "paste-guard",
  onData(_ctx, data) {
    const paste = BRACKETED_PASTE.exec(data);
    if (paste) return `\x1b[200~${stripControlChars(paste[1])}\x1b[201~`;
    // shortcut: an unbracketed paste opening with ESC reads as a key or a report, and one control character as a key, so both pass; to catch them, mark pastes at their source.
    return data.length > 1 && !data.startsWith("\x1b") ? stripControlChars(data) : data;
  },
};
