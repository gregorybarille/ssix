/**
 * Where menus, tooltips and dialogs mount: an empty element of their own beside
 * `#root` (see `index.html`), not `document.body`. A new last child of `body`
 * makes WebKit restyle the whole previous last child, because of the
 * `:not(:last-child)` in every `space-y-*` rule. That child is the whole app: with
 * 500 connections each overlay that opened waited about 170 ms for it.
 */
export function overlayHost(): HTMLElement {
  return document.getElementById("overlays") ?? document.body;
}
