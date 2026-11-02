import type { Snippet } from "@/types";
import { detectPlatform } from "./platform";
import { acceptsBracketedPaste, activeSessionId } from "./terminalRegistry";

/**
 * A `{{variable}}`: a name that starts with a letter or `_` and goes on with
 * letters, digits, `_` or `-`, with optional spaces inside the braces, all on
 * one line. Names are case-sensitive.
 *
 * Anything else stays literal text, so an unclosed `{{` and the templates of
 * other tools (`docker ps --format '{{.Names}}'`, `{{json .}}`) paste as
 * written.
 *
 * Backslashes right in front of a variable pair up: `\\` is one backslash, and
 * one left over keeps the braces literal, for a template word that looks like
 * a name. So `\{{end}}` pastes `{{end}}`, and `C:\Users\\{{user}}` pastes one
 * backslash and the value. Backslashes anywhere else are plain text: the second
 * alternative takes such a run in one go, so a long one stays linear.
 */
const PLACEHOLDER = /(\\*)\{\{[ \t]*([\p{L}_][\p{L}\p{N}_-]*)[ \t]*\}\}|\\+/gu;

/** Control characters other than tab and line breaks. */
const CONTROL_CHARS = /[^\P{Cc}\t\r\n]/gu;

/** The variables of a command, each once, in order of first appearance. */
export function snippetVariables(command: string): string[] {
  const names = new Set<string>();
  for (const [, backslashes, name] of command.matchAll(PLACEHOLDER)) {
    if (name && backslashes.length % 2 === 0) names.add(name);
  }
  return [...names];
}

/**
 * The command with every variable replaced by its value and escapes resolved.
 * One pass: a value containing `{{x}}` is not expanded again. A variable with
 * no value (or an empty one) stays as written, which is what the preview shows.
 */
export function fillVariables(command: string, values: ReadonlyMap<string, string>): string {
  return command.replace(PLACEHOLDER, (whole: string, backslashes: string, name?: string) => {
    if (!name) return whole;
    const braces = whole.slice(backslashes.length);
    const text = backslashes.length % 2 === 0 ? values.get(name) || braces : braces;
    return "\\".repeat(Math.floor(backslashes.length / 2)) + text;
  });
}

/**
 * The bytes to send so that pasting runs nothing, or `null` when that cannot
 * be done. A newline is never added.
 *
 * - Blank lines around the command go, so `uptime\n` does not run itself.
 *   Spaces at its end stay: `kubectl logs ` is a command to finish by hand.
 * - Control characters go, or `\x1b[201~` would end the bracketed paste early
 *   and the lines after it would run; `\x03` or `\x04` would act on the shell.
 * - With `bracketed`, the program has asked to receive pastes between
 *   `\x1b[200~` and `\x1b[201~` and treats line breaks in between as text.
 *   They are sent as `\r`, as xterm's own paste does.
 * - Without it, a line break is the same as pressing Enter, so several lines
 *   cannot be pasted safely (`null`). Joining them would change the command.
 */
export function preparePaste(command: string, bracketed: boolean): string | null {
  const lines = command.replace(CONTROL_CHARS, "").split(/\r\n|\r|\n/);
  let start = 0;
  let end = lines.length;
  while (end - start > 1 && !lines[end - 1].trim()) end--;
  while (end - start > 1 && !lines[start].trim()) start++;
  const kept = lines.slice(start, end);
  if (bracketed) return `\x1b[200~${kept.join("\r")}\x1b[201~`;
  return kept.length === 1 ? kept[0] : null;
}

export const NO_TERMINAL_MESSAGE =
  "There is no live terminal to paste into. Connect to a host, or go back to Terminals and pick a tab that is connected.";

export const SEVERAL_LINES_MESSAGE =
  "Nothing was pasted: this snippet has several lines, and the program in this terminal has not asked for bracketed paste, so each line would run as soon as it arrived. Put the command on one line (a && b), or use a shell with bracketed paste (bash 5.1 or later, zsh, fish). Just back from another view? Press Enter for a new prompt, then try again.";

export type PastePlan = { sessionId: string; text: string } | { error: string };

/** Where a command would go and as what, or why it cannot be pasted right now. */
export function planPaste(command: string): PastePlan {
  const sessionId = activeSessionId();
  if (!sessionId) return { error: NO_TERMINAL_MESSAGE };
  const text = preparePaste(command, acceptsBracketedPaste(sessionId));
  return text === null ? { error: SEVERAL_LINES_MESSAGE } : { sessionId, text };
}

/** AND-matched tokens (from `tokenize` in `search.ts`) over name, command and tags. */
export function snippetMatches(snippet: Snippet, tokens: string[]): boolean {
  const haystack = [snippet.name, snippet.command, ...(snippet.tags ?? [])]
    .join(" ")
    .toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

/** The palette's shortcut (`mod+shift+s` in `useGlobalShortcuts`) as the user types it. */
export function paletteShortcutLabel(): string {
  return detectPlatform() === "macos" ? "Cmd+Shift+S" : "Ctrl+Shift+S";
}
