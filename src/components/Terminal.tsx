import React, { useEffect, useRef, useCallback } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@/lib/tauri";
import { AppSettings } from "@/types";
import "@xterm/xterm/css/xterm.css";

interface TerminalProps {
  sessionId: string;
  connectionName: string;
  isVisible: boolean;
  onDisconnect: () => void;
  settings?: AppSettings;
}

export function Terminal({ sessionId, connectionName, isVisible, onDisconnect, settings }: TerminalProps) {
  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const listenersRef = useRef<Array<() => void>>([]);
  // Read by `onSelectionChange` so the setting toggle takes effect live
  // without requiring the terminal to remount.
  const autoCopyEnabledRef = useRef<boolean>(settings?.auto_copy_selection ?? false);
  useEffect(() => {
    autoCopyEnabledRef.current = settings?.auto_copy_selection ?? false;
  }, [settings?.auto_copy_selection]);

  // Refit when becoming visible
  useEffect(() => {
    if (isVisible && fitAddonRef.current && xtermRef.current) {
      // Small delay so the DOM has painted with display:block
      const timer = setTimeout(() => {
        try {
          fitAddonRef.current?.fit();
          const term = xtermRef.current;
          if (term) {
            invoke("ssh_resize", { sessionId, cols: term.cols, rows: term.rows }).catch(() => {});
          }
          xtermRef.current?.focus();
        } catch {
          // ignore
        }
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isVisible, sessionId]);

  // Update xterm font options when settings change
  useEffect(() => {
    const term = xtermRef.current;
    if (!term || !settings) return;
    const safeFontFamily = settings.font_family.replace(/['"\\]/g, "");
    term.options.fontSize = settings.font_size;
    term.options.fontFamily = `'${safeFontFamily}', monospace`;
    fitAddonRef.current?.fit();
  }, [settings?.font_size, settings?.font_family]);

  useEffect(() => {
    if (!termRef.current) return;

    const safeFontFamily = settings?.font_family
      ? settings.font_family.replace(/['"\\]/g, "")
      : null;
    const term = new XTerm({
      cursorBlink: true,
      fontSize: settings?.font_size ?? 14,
      fontFamily: safeFontFamily
        ? `'${safeFontFamily}', monospace`
        : "'JetBrains Mono', 'Fira Code', monospace",
      theme: {
        background: "#1a1b26",
        foreground: "#c0caf5",
        cursor: "#c0caf5",
        selectionBackground: "#33467c",
        black: "#15161e",
        red: "#f7768e",
        green: "#9ece6a",
        yellow: "#e0af68",
        blue: "#7aa2f7",
        magenta: "#bb9af7",
        cyan: "#7dcfff",
        white: "#a9b1d6",
        brightBlack: "#414868",
        brightRed: "#f7768e",
        brightGreen: "#9ece6a",
        brightYellow: "#e0af68",
        brightBlue: "#7aa2f7",
        brightMagenta: "#bb9af7",
        brightCyan: "#7dcfff",
        brightWhite: "#c0caf5",
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termRef.current);
    fitAddon.fit();

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    const { cols, rows } = term;
        invoke("ssh_resize", { sessionId, cols, rows }).catch(() => {});

    /**
     * P1#1: Cmd/Ctrl+C copies the active xterm selection to the system
     * clipboard *only* when the user explicitly invokes the shortcut. We
     * return `false` from `attachCustomKeyEventHandler` to swallow the
     * event so xterm doesn't also forward Ctrl+C as SIGINT to the remote
     * shell when there's a selection to copy (matching iTerm/Terminal.app
     * convention). When there is no selection, the keystroke flows through
     * to xterm's default `onData` handler, which writes Ctrl+C to the
     * remote shell as expected.
     *
     * Also handles Cmd/Ctrl+V paste so that keyboard paste works on macOS
     * (xterm's default Ctrl+V on macOS is captured by the WebView).
     */
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.altKey) return true;
      const key = e.key.toLowerCase();
      if (key === "c") {
        const sel = term.getSelection();
        if (sel.length > 0) {
          navigator.clipboard.writeText(sel).catch(() => {});
          return false; // swallow — don't also send SIGINT
        }
        return true; // no selection → forward Ctrl+C to remote as SIGINT
      }
      if (key === "v") {
        navigator.clipboard
          .readText()
          .then((text) => { if (text) term.paste(text); })
          .catch(() => {});
        return false;
      }
      return true;
    });

    /**
     * P1#2: Surface ssh_write failures inline in the terminal. A rejected
     * ssh_write means the backend session thread is gone (panic, channel
     * dropped, lost tx in SshState) — the user keeps typing into a dead
     * terminal otherwise. We render a single red banner the first time it
     * happens per session so we don't spam on every keystroke after the
     * connection is dead. The `ssh-closed-{id}` event will follow shortly
     * afterward and trigger `onDisconnect()`.
     */
    let writeFailed = false;
    const dataDisposable = term.onData((data) => {
      const encoder = new TextEncoder();
      const bytes = Array.from(encoder.encode(data));
      invoke("ssh_write", { sessionId, data: bytes }).catch((err) => {
        if (!writeFailed) {
          writeFailed = true;
          const msg = typeof err === "string" ? err : String(err ?? "session lost");
          term.write(`\r\n\x1b[31mInput dropped — SSH session lost: ${msg}\x1b[0m\r\n`);
        }
      });
    });

    /**
     * P1#1 (auto-copy-selection setting): when `settings.auto_copy_selection`
     * is true (off by default), reproduce the classic xterm behavior of
     * copying every selection to the clipboard immediately. This is the
     * legacy SSX behavior — preserved behind a setting for users who want
     * it, but no longer the default since it silently overwrites the
     * clipboard on highlight (a privacy/UX foot-gun on macOS).
     *
     * `autoCopyEnabledRef` is read inside the disposable so the toggle
     * takes effect without re-mounting the terminal.
     */
    const selectionDisposable = term.onSelectionChange(() => {
      if (!autoCopyEnabledRef.current) return;
      const sel = term.getSelection();
      if (sel) {
        navigator.clipboard.writeText(sel).catch(() => {});
      }
    });

    // Right-click paste: main.tsx dispatches this when the user right-clicks
    // inside the xterm canvas area and the clipboard has text.
    const pasteHandler = (e: Event) => {
      const text = (e as CustomEvent<{ text: string }>).detail.text;
      if (isVisible && text) term.paste(text);
    };
    window.addEventListener("ssx:terminal-paste", pasteHandler);

    const setupListeners = async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");

        const unlistenOutput = await listen<number[]>(`ssh-output-${sessionId}`, (event) => {
          const bytes = new Uint8Array(event.payload);
          term.write(bytes);
        });

        const unlistenError = await listen<string>(`ssh-error-${sessionId}`, (event) => {
          term.write(`\r\n\x1b[31mSSH Error: ${event.payload}\x1b[0m\r\n`);
        });

        const unlistenClosed = await listen(`ssh-closed-${sessionId}`, () => {
          term.write("\r\n\x1b[33mConnection closed.\x1b[0m\r\n");
          onDisconnect();
        });

        listenersRef.current = [unlistenOutput, unlistenError, unlistenClosed];
      } catch {
        // not in Tauri
      }
    };
    setupListeners();

    const resizeObserver = new ResizeObserver(() => {
      try {
        fitAddon.fit();
        const { cols, rows } = term;
    invoke("ssh_resize", { sessionId, cols, rows }).catch(() => {});
      } catch {
        // ignore resize errors
      }
    });
    resizeObserver.observe(termRef.current);

    return () => {
      dataDisposable.dispose();
      selectionDisposable.dispose();
      window.removeEventListener("ssx:terminal-paste", pasteHandler);
      listenersRef.current.forEach((fn) => fn());
      resizeObserver.disconnect();
      term.dispose();
    };
  }, [sessionId]);

  return (
    <div
      className="absolute inset-0"
      style={{ display: isVisible ? "flex" : "none", flexDirection: "column" }}
    >
      <div ref={termRef} className="flex-1 min-h-0 p-1 bg-[#1a1b26]" />
    </div>
  );
}
