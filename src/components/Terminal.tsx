import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { keyboardIsInItsTab, isPanelOpen, nobodyTypingElsewhere } from "@/lib/focus";
import { invoke } from "@/lib/tauri";
import { attachOutput } from "@/lib/terminalOutput";
import {
  activeSessionId,
  isHeldEnter,
  registerTerminal,
  tabIsStillOpeningPane,
  unregisterTerminal,
} from "@/lib/terminalRegistry";
import { terminalAppearance } from "@/lib/terminalTheme";
import { useTerminalsStore } from "@/store/useTerminalsStore";
import { AppSettings, Connection } from "@/types";
import {
  runTerminalCreate,
  runTerminalData,
  runTerminalKey,
  runTerminalOutput,
  type TerminalExtensionContext,
} from "./terminal/extensions";
import "./terminal/registerExtensions";
import "@xterm/xterm/css/xterm.css";

/** Lines kept above the viewport. xterm's default (1000) is low for an SSH client. */
const SCROLLBACK_LINES = 10_000;

interface TerminalProps {
  sessionId: string;
  connectionName: string;
  /**
   * Whether this pane is on screen: its tab is active and the Terminals view is
   * showing. A hidden terminal stays mounted, so it keeps its scrollback and
   * modes and goes on receiving output.
   */
  isVisible: boolean;
  onDisconnect: () => void;
  settings?: AppSettings;
  /**
   * The saved connection behind this session, as it is now: its font and
   * colours apply live. Also passed on to terminal extensions.
   */
  connection?: Connection;
}

export interface TerminalPasteDetail {
  text: string;
  /** Session under the cursor when the paste was requested. */
  sessionId?: string;
}

export function Terminal({ sessionId, isVisible, onDisconnect, settings, connection }: TerminalProps) {
  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  // Keep `onDisconnect` in a ref so the listener registered inside the
  // [sessionId]-deps effect always calls the latest callback.
  const onDisconnectRef = useRef(onDisconnect);
  useEffect(() => {
    onDisconnectRef.current = onDisconnect;
  }, [onDisconnect]);
  // Read through the extension context so a settings change reaches
  // extensions live, without requiring the terminal to remount.
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  // For the listeners of the [sessionId] effect below. A layout effect, because
  // the resize that hiding a terminal causes fires before a plain effect would.
  const isVisibleRef = useRef(isVisible);
  useLayoutEffect(() => {
    isVisibleRef.current = isVisible;
  }, [isVisible]);
  // The shell ended while this terminal was off screen; see the `closed` event.
  const endedWhileHiddenRef = useRef(false);

  /**
   * Fit xterm to its pane and tell the server. A hidden pane has no size: the
   * fit addon's minimum would make it 2x1, reflow the scrollback to that and
   * resize the shell under a running program. So a hidden terminal keeps its
   * size, and the fit on showing it catches up.
   */
  const fitToPane = useCallback(() => {
    const term = xtermRef.current;
    const pane = termRef.current;
    if (!term || !pane || !isVisibleRef.current) return;
    if (pane.clientWidth === 0 || pane.clientHeight === 0) return;
    try {
      fitAddonRef.current?.fit();
      invoke("ssh_resize", { sessionId, cols: term.cols, rows: term.rows }).catch(() => {});
    } catch {
      // ignore resize errors
    }
  }, [sessionId]);

  // On screen: refit, and take the keyboard. Off screen: let go of the keyboard,
  // or typing in the view that replaced this terminal would reach its shell.
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    if (!isVisible) {
      term.textarea?.blur();
      return;
    }
    if (endedWhileHiddenRef.current) {
      endedWhileHiddenRef.current = false;
      onDisconnectRef.current();
    }
    // Small delay so the DOM has painted with display:block
    const timer = setTimeout(() => {
      fitToPane();
      // A split tab shows two terminals: the keyboard goes back to the one that
      // had it. A panel beside them keeps it, and so does a login prompt in the
      // other pane, which took it as the tab came on screen.
      if (isPanelOpen() || keyboardIsInItsTab(termRef.current)) return;
      const active = activeSessionId();
      if (active === null || active === sessionId) term.focus();
    }, 50);
    return () => clearTimeout(timer);
  }, [isVisible, sessionId, fitToPane]);

  const { fontFamily, fontSize, theme } = terminalAppearance(connection, settings);

  // Font changes need a measurement, which a hidden terminal cannot take (xterm
  // keeps the old cell size), so they wait until it is shown.
  useEffect(() => {
    const term = xtermRef.current;
    if (!term || !isVisible) return;
    if (term.options.fontSize === fontSize && term.options.fontFamily === fontFamily) return;
    term.options.fontSize = fontSize;
    term.options.fontFamily = fontFamily;
    fitToPane();
  }, [fontSize, fontFamily, isVisible, fitToPane]);

  // Swap the colour scheme live when the app theme or the connection's scheme changes.
  useEffect(() => {
    const term = xtermRef.current;
    if (term) term.options.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (!termRef.current) return;

    const term = new XTerm({
      cursorBlink: true,
      scrollback: SCROLLBACK_LINES,
      fontSize,
      fontFamily,
      theme,
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

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;
    registerTerminal(sessionId, term);
    fitToPane();

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
     * focus while a panel is open. Never forward keystrokes in that state,
     * nor to a terminal off screen, on keypress as well: xterm sends printable
     * keys and Enter from there when it was told to skip their keydown.
     */
    term.attachCustomKeyEventHandler((e) => {
      if (isHeldEnter(sessionId, e)) {
        // Without this the browser goes on to fire keypress, and xterm sends that.
        e.preventDefault();
        return false;
      }
      if (e.type === "keyup") return true;
      if (isPanelOpen() || !isVisibleRef.current) {
        if (e.type === "keypress") e.preventDefault();
        return false;
      }
      if (e.type !== "keydown") return true;
      if (!runTerminalKey(extensionContext, e)) return false;
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
     * than one per keystroke. The `closed` notification follows shortly
     * on the output channel and triggers `onDisconnect()`.
     */
    const extensionContext: TerminalExtensionContext = {
      term,
      sessionId,
      connection,
      get settings() {
        return settingsRef.current;
      },
    };

    let writeFailed = false;
    const dataDisposable = term.onData((input) => {
      const data = runTerminalData(extensionContext, input);
      if (data === null) return;
      invoke("ssh_write", { sessionId, data }).catch((err) => {
        if (!writeFailed) {
          writeFailed = true;
          const msg = typeof err === "string" ? err : String(err ?? "session lost");
          term.write(`\r\n\x1b[31mInput dropped — SSH session lost: ${msg}\x1b[0m\r\n`);
        }
      });
    });

    // Before the output is attached below: buffered output replays at once.
    const disposeExtensions = runTerminalCreate(extensionContext);

    // Right-click paste: App.tsx dispatches this with the session id of the
    // terminal under the cursor. Only that terminal pastes.
    const pasteHandler = (e: Event) => {
      const { text, sessionId: target } = (e as CustomEvent<TerminalPasteDetail>).detail;
      if (text && target === sessionId) term.paste(text);
    };
    window.addEventListener("ssix:terminal-paste", pasteHandler);

    // Shell output and error / closed notifications: both arrive in order
    // over the IPC channel created at connect time, buffered by the sink
    // until this terminal attaches, so nothing is lost on a late mount.
    const detachOutput = attachOutput(sessionId, {
      write: (bytes) => {
        term.write(bytes);
        runTerminalOutput(extensionContext, bytes);
      },
      onEvent: (event) => {
        if (event.kind === "error") {
          term.write(`\r\n\x1b[31mSSH Error: ${event.message}\x1b[0m\r\n`);
        } else {
          term.write("\r\n\x1b[33mConnection closed.\x1b[0m\r\n");
          useTerminalsStore.getState().markSessionEnded(sessionId);
          // Closing asks for confirmation in the side panel. A terminal off
          // screen does not interrupt what the user is doing for that: it asks
          // when it is shown again.
          if (isVisibleRef.current) onDisconnectRef.current();
          else endedWhileHiddenRef.current = true;
        }
      },
    });

    const resizeObserver = new ResizeObserver(fitToPane);
    resizeObserver.observe(termRef.current);

    // The effect above ran before this terminal existed, so opening is up to this one.
    const mayTakeKeyboard =
      isVisibleRef.current &&
      !isPanelOpen() &&
      !tabIsStillOpeningPane(sessionId) &&
      nobodyTypingElsewhere(termRef.current);
    if (mayTakeKeyboard) term.focus();

    return () => {
      dataDisposable.dispose();
      disposeExtensions();
      window.removeEventListener("ssix:terminal-paste", pasteHandler);
      detachOutput();
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
