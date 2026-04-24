import { useEffect } from "react";

/**
 * Map of normalized shortcut → handler. Keys use this format:
 *
 *   "mod+k", "mod+shift+n", "mod+1"
 *
 * where `mod` is Cmd on macOS and Ctrl elsewhere. Modifiers are ordered
 * `mod`, `shift`, `alt`. The key is the lowercase value of `event.key`
 * (digits as themselves, letters as their lowercase form).
 *
 * Handlers receive the original event so they can `preventDefault()`.
 *
 * Shortcuts are skipped automatically when focus is in a typing surface
 * (input, textarea, contenteditable, or xterm's helper textarea), unless
 * `allowInTypingSurface` is set on the binding.
 */
export type ShortcutHandler = (e: KeyboardEvent) => void;
export interface ShortcutBinding {
  handler: ShortcutHandler;
  allowInTypingSurface?: boolean;
}
export type ShortcutMap = Record<string, ShortcutHandler | ShortcutBinding>;

const isMac = (() => {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || "");
})();

export function isTypingSurface(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  // xterm renders an off-screen textarea named .xterm-helper-textarea — when
  // focus is inside any xterm instance the user is typing into the shell.
  if (target.closest(".xterm")) return true;
  if (target.isContentEditable) return true;
  // Fallback for environments where the live `isContentEditable` property
  // isn't reflected (e.g. jsdom): check the attribute directly.
  const ce = target.getAttribute("contenteditable");
  if (ce !== null && ce !== "false") return true;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return false;
}

export function normalizeEvent(e: KeyboardEvent): string | null {
  // We only care about combos that include the platform mod key OR are bare
  // function keys; everything else is normal typing.
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (!mod) return null;
  // Don't fire for the *other* primary modifier — Ctrl+K on macOS is a
  // legitimate readline binding inside the terminal and must pass through.
  if (isMac && e.ctrlKey) return null;
  if (!isMac && e.metaKey) return null;
  const parts = ["mod"];
  if (e.shiftKey) parts.push("shift");
  if (e.altKey) parts.push("alt");
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
  parts.push(key);
  return parts.join("+");
}

export function useGlobalShortcuts(map: ShortcutMap, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const combo = normalizeEvent(e);
      if (!combo) return;
      const entry = map[combo];
      if (!entry) return;
      const binding: ShortcutBinding =
        typeof entry === "function" ? { handler: entry } : entry;
      if (!binding.allowInTypingSurface && isTypingSurface(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      binding.handler(e);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [map, enabled]);
}
