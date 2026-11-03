import type { Platform } from "@/lib/platform";

type KeyWithModifiers = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">;

/**
 * What a key does to the clipboard, or null when it belongs to the program.
 * Plain Ctrl+C and Ctrl+V always do: they interrupt, and they are readline's
 * quoted insert and vim's block-visual.
 */
export function clipboardKeyAction(e: KeyWithModifiers, platform: Platform): "copy" | "paste" | null {
  const held =
    platform === "macos"
      ? e.metaKey && !e.ctrlKey && !e.shiftKey
      : e.ctrlKey && e.shiftKey && !e.metaKey;
  if (!held || e.altKey) return null;
  const key = e.key.toLowerCase();
  if (key === "c") return "copy";
  return key === "v" ? "paste" : null;
}
