import { detectPlatform } from "./platform";

/**
 * Links found in terminal output. That output is untrusted: whatever the
 * server sends, only an `http` or `https` URL may ever reach the browser.
 */

const SCHEMES = ["http:", "https:"];

/** The URL parser quietly drops tabs and line breaks, which could disguise a target. */
// eslint-disable-next-line no-control-regex
const CONTROL_OR_SPACE = /[\u0000- \u007f-\u009f]/;

/** `raw` parsed if it may be opened, `null` for anything else. */
export function parseExternalUrl(raw: string): URL | null {
  if (CONTROL_OR_SPACE.test(raw)) return null;
  try {
    const url = new URL(raw);
    return SCHEMES.includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

/** Open a link in the default browser. Rejects anything but `http` and `https`. */
export async function openExternalUrl(raw: string): Promise<void> {
  const url = parseExternalUrl(raw);
  if (!url) throw new Error("Only http and https links can be opened.");
  const { open } = await import("@tauri-apps/plugin-shell");
  await open(url.href);
}

/**
 * Whether a click on a link should open it. It takes the platform's modifier
 * (Cmd on macOS, Ctrl elsewhere), so a stray click on output never opens a
 * browser. Ctrl+click is a right-click on macOS, so it does not count there.
 */
export function isLinkOpenClick(event: MouseEvent): boolean {
  return detectPlatform() === "macos" ? event.metaKey : event.ctrlKey;
}

/** The modifier of {@link isLinkOpenClick}, as the user reads it. */
export function linkModifierLabel(): string {
  return detectPlatform() === "macos" ? "Cmd" : "Ctrl";
}
