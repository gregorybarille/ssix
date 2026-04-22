import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/globals.css";

// Smart right-click handler:
//   1. input / textarea / [contenteditable] → let the native browser menu appear
//      (has Cut / Copy / Paste out of the box).
//   2. xterm terminal area → silently paste clipboard text into the shell.
//   3. Everywhere else → show the custom SSX context menu.
document.addEventListener("contextmenu", (e) => {
  const target = e.target as Element;

  // 1 — native menu for form fields
  if (target.closest("input, textarea, [contenteditable]")) return;

  e.preventDefault();

  // 2 — right-click paste into xterm
  if (target.closest(".xterm-screen, .xterm-rows")) {
    navigator.clipboard.readText().then((text) => {
      if (text) {
        window.dispatchEvent(
          new CustomEvent("ssx:terminal-paste", { detail: { text } })
        );
      }
    }).catch(() => {});
    return;
  }

  // 3 — custom context menu
  window.dispatchEvent(
    new CustomEvent("ssx:contextmenu", {
      detail: { x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY },
    })
  );
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
