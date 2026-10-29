/** True when `el` is a text-entry element (input, textarea, contenteditable). */
export function isTextInput(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) {
    return !["button", "checkbox", "radio", "submit", "reset", "file", "range", "color"].includes(
      el.type,
    );
  }
  return el.isContentEditable || el.getAttribute("contenteditable") === "true";
}
