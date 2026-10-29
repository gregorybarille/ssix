import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { invoke } from "@/lib/tauri";
import { sshClosedEvent, sshErrorEvent } from "@/lib/events";
import { attachOutput } from "@/lib/terminalOutput";
import { registerTerminal, unregisterTerminal } from "@/lib/terminalRegistry";
import { terminalTheme } from "@/lib/terminalTheme";
import { AppSettings } from "@/types";
import "@xterm/xterm/css/xterm.css";

/** Lines kept above the viewport. xterm's default (1000) is low for an SSH client. */
const SCROLLBACK_LINES = 10_000;

interface TerminalProps {
  sessionId: string;
  connectionName: string;
  isVisible: boolean;
  onDisconnect: () => void;
  settings?: AppSettings;
}

export interface TerminalPasteDetail {
  text: string;
  /** Session under the cursor when the paste was requested. */
  sessionId?: string;
}

export function Terminal({ sessionId, isVisible, onDisconnect, settings }: TerminalProps) {
  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  // Keep `onDisconnect` in a ref so the listener registered inside the
  // [sessionId]-deps effect always calls the latest callback.
  const onDisconnectRef = useRef(onDisconnect);
  useEffect(() => {
    onDisconnectRef.current = onDisconnect;
  }, [onDisconnect]);
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

  // Swap the colour scheme live when the app theme changes.
  const theme = terminalTheme(settings?.theme);
  useEffect(() => {
    const term = xtermRef.current;
    if (term) term.options.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (!termRef.current) return;

    const safeFontFamily = settings?.font_family
      ? settings.font_family.replace(/['"\\]/g, "")
      : null;
    const term = new XTerm({
      cursorBlink: true,
      scrollback: SCROLLBACK_LINES,
      fontSize: settings?.font_size ?? 14,
      fontFamily: safeFontFamily
        ? `'${safeFontFamily}', monospace`
        : "'JetBrains Mono', 'Fira Code', monospace",
      theme: terminalTheme(settings?.theme),
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termRef.current);

    // GPU rendering when the WebView offers WebGL; the DOM renderer stays
    // in place otherwise (and takes over again if the context is lost).
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // WebGL unavailable — DOM renderer.
    }

    fitAddon.fit();

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;
    registerTerminal(sessionId, term);

    const { cols, rows } = term;
    invoke("ssh_resize", { sessionId, cols, rows }).catch(() => {});

    /**
     * Cmd/Ctrl+C copies the active xterm selection to the system clipboard
     * only when the user explicitly invokes the shortcut. Returning `false`
     * swallows the event so xterm doesn't also forward Ctrl+C as SIGINT
     * when there is a selection to copy (iTerm/Terminal.app convention).
     * With no selection the keystroke flows through to the remote shell.
     *
     * Cmd/Ctrl+V pastes so keyboard paste works on macOS (xterm's default
     * Ctrl+V on macOS is captured by the WebView).
     *
     * In-app panels are non-modal, so xterm's hidden textarea can keep
     * focus while a panel is open. Never forward keystrokes in that state.
     */
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      if (document.querySelector('[data-slot="app-panel-content"]')) {
        return false;
      }
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
     * Surface ssh_write failures inline. A rejected ssh_write means the
     * backend session is gone; render one red banner per session rather
     * than one per keystroke. The `ssix:ssh:closed:{id}` event follows
     * shortly and triggers `onDisconnect()`.
     */
    let writeFailed = false;
    const dataDisposable = term.onData((data) => {
      invoke("ssh_write", { sessionId, data }).catch((err) => {
        if (!writeFailed) {
          writeFailed = true;
          const msg = typeof err === "string" ? err : String(err ?? "session lost");
          term.write(`\r\n\x1b[31mInput dropped — SSH session lost: ${msg}\x1b[0m\r\n`);
        }
      });
    });

    /**
     * Opt-in auto-copy (`settings.auto_copy_selection`, off by default):
     * classic xterm behaviour of copying every selection immediately.
     * `autoCopyEnabledRef` is read inside the disposable so the toggle takes
     * effect without re-mounting the terminal.
     */
    const selectionDisposable = term.onSelectionChange(() => {
      if (!autoCopyEnabledRef.current) return;
      const sel = term.getSelection();
      if (sel) {
        navigator.clipboard.writeText(sel).catch(() => {});
      }
    });

    // Right-click paste: App.tsx dispatches this with the session id of the
    // terminal under the cursor. Only that terminal pastes.
    const pasteHandler = (e: Event) => {
      const { text, sessionId: target } = (e as CustomEvent<TerminalPasteDetail>).detail;
      if (text && target === sessionId) term.paste(text);
    };
    window.addEventListener("ssix:terminal-paste", pasteHandler);

    // Shell output: raw bytes over the IPC channel created at connect time.
    const detachOutput = attachOutput(sessionId, (bytes) => term.write(bytes));

    // Error / closed notifications. `cancelled` guards against the effect
    // being torn down before `listen` resolves (StrictMode double-mount,
    // closing a tab immediately after opening it), which would otherwise
    // leak the listener and write into a disposed terminal.
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const unlistenError = await listen<string>(sshErrorEvent(sessionId), (event) => {
          if (cancelled) return;
          term.write(`\r\n\x1b[31mSSH Error: ${event.payload}\x1b[0m\r\n`);
        });
        const unlistenClosed = await listen(sshClosedEvent(sessionId), () => {
          if (cancelled) return;
          term.write("\r\n\x1b[33mConnection closed.\x1b[0m\r\n");
          onDisconnectRef.current();
        });
        if (cancelled) {
          unlistenError();
          unlistenClosed();
          return;
        }
        unlisteners.push(unlistenError, unlistenClosed);
      } catch {
        // not in Tauri
      }
    })();

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
      cancelled = true;
      dataDisposable.dispose();
      selectionDisposable.dispose();
      window.removeEventListener("ssix:terminal-paste", pasteHandler);
      detachOutput();
      unlisteners.forEach((fn) => fn());
      resizeObserver.disconnect();
      unregisterTerminal(sessionId);
      term.dispose();
    };
  }, [sessionId]);

  return (
    <div
      className="absolute inset-0"
      style={{ display: isVisible ? "flex" : "none", flexDirection: "column" }}
      data-testid="terminal-container"
      data-session-id={sessionId}
    >
      <div
        ref={termRef}
        className="flex-1 min-h-0 p-1"
        style={{ backgroundColor: theme.background }}
      />
    </div>
  );
}
