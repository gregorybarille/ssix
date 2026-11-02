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

/**
 * Whether `container` may take the keyboard focus for something the user did not
 * just ask for: only when that takes it from nobody. Someone typing elsewhere goes
 * on typing there, so what they type never lands in a field that just appeared.
 */
export function focusIsFreeFor(container: Element | null): boolean {
  const active = document.activeElement;
  if (!active || active === document.body) return true;
  if (container?.contains(active)) return true;
  // A browser can leave focus on an element it stopped rendering, such as the
  // terminal of a tab that was just hidden. Nobody can be typing there.
  return !(active.checkVisibility?.() ?? true);
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

/**
 * True while a side panel or palette is open. Panels are non-modal: the view
 * beside one stays clickable, but the keyboard belongs to the panel.
 */
export function isPanelOpen(): boolean {
  return document.querySelector('[data-slot="app-panel-content"]') !== null;
}
