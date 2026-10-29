/**
 * Focus / typing-surface predicates shared by the global shortcut handler
 * and the forms' deferred autofocus. Keep the element lists here so the two
 * never drift apart.
 */

function isContentEditable(el: HTMLElement): boolean {
  if (el.isContentEditable) return true;
  // Fallback for environments where the live `isContentEditable` property
  // isn't reflected (e.g. jsdom): check the attribute directly.
  const ce = el.getAttribute("contenteditable");
  return ce !== null && ce !== "false";
}

/** `<input>` types that take no text, so focusing them is not "typing". */
const NON_TEXT_INPUT_TYPES = ["button", "checkbox", "radio", "submit", "reset", "file", "range", "color"];

/** True when `el` is a text-entry element (text input, textarea, contenteditable). */
export function isTextInput(el: Element | EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return !NON_TEXT_INPUT_TYPES.includes(el.type);
  return isContentEditable(el);
}

/**
 * True when keystrokes aimed at `target` belong to the element rather than to
 * a global shortcut: any form control, a contenteditable, or the shell
 * (xterm renders an off-screen `.xterm-helper-textarea`; focus anywhere
 * inside an `.xterm` means the user is typing into the terminal).
 */
export function isTypingSurface(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest(".xterm")) return true;
  if (isTextInput(target)) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "SELECT";
}
