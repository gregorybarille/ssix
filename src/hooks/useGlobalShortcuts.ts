import { isTypingSurface } from "@/lib/focus";

export { isTypingSurface };
import { useEffect, useRef } from "react";

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
 * `allowInTypingSurface` is set on the binding. On macOS the mod key is
 * Cmd, which neither the shell nor a text field ever consumes for the
 * combos bound here, so Cmd shortcuts fire everywhere; Ctrl combos on
 * other platforms stay out of typing surfaces because Ctrl+K, Ctrl+W
 * and friends are readline bindings inside the terminal.
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

/**
 * Whether a shortcut must stay out of the focused typing surface.
 * Exported for tests; `isMac` is fixed per process.
 */
export function blockedByTypingSurface(e: KeyboardEvent, binding: ShortcutBinding): boolean {
  if (binding.allowInTypingSurface) return false;
  if (isMac && e.metaKey) return false;
  return isTypingSurface(e.target);
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
  // Callers build the map inline on every render; keep the latest one in
  // a ref so the window listener is registered once per `enabled` flip
  // instead of torn down and re-added on each render.
  const mapRef = useRef(map);
  mapRef.current = map;
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const combo = normalizeEvent(e);
      if (!combo) return;
      const entry = mapRef.current[combo];
      if (!entry) return;
      const binding: ShortcutBinding =
        typeof entry === "function" ? { handler: entry } : entry;
      if (blockedByTypingSurface(e, binding)) return;
      e.preventDefault();
      e.stopPropagation();
      binding.handler(e);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}
