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

    const dataDisposable = term.onData((data) => {
      const encoder = new TextEncoder();
      const bytes = Array.from(encoder.encode(data));
      invoke("ssh_write", { sessionId, data: bytes }).catch(() => {});
    });

    const selectionDisposable = term.onSelectionChange(() => {
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
