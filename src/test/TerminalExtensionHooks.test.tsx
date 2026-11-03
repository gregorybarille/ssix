import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SnippetPalette } from "@/components/SnippetPalette";
import { Terminal } from "@/components/Terminal";
import {
  registerTerminalExtension,
  terminalExtensions,
  type TerminalExtension,
  type TerminalExtensionContext,
} from "@/components/terminal/extensions";
import { activeSessionId, writeToSession } from "@/lib/terminalRegistry";
import { useSnippetsStore } from "@/store/useSnippetsStore";
import { useTerminalsStore } from "@/store/useTerminalsStore";
import { useViewStore } from "@/store/useViewStore";
import type { AppSettings, Connection, Snippet } from "@/types";
import { renderInPanel } from "./panel";

/**
 * xterm.js cannot run in jsdom, so a stand-in records what `Terminal` does
 * with it. This pins where the component calls the extension hooks, and when it
 * lets the terminal have the keyboard.
 */
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  attachOutput: vi.fn(),
  events: [] as string[],
  term: null as null | {
    onDataListener: (data: string) => void;
    onSelectionListener: () => void;
    selection: string;
    focused: number;
    keyHandler: (event: KeyboardEvent) => boolean;
    pasted: string[];
  },
}));

vi.mock("@/lib/tauri", () => ({ invoke: mocks.invoke }));
vi.mock("@/lib/terminalOutput", () => ({ attachOutput: mocks.attachOutput }));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    onContextLoss() {}
    dispose() {}
  },
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = {};
    textarea = document.createElement("textarea");
    onDataListener: (data: string) => void = () => {};
    onSelectionListener: () => void = () => {};
    selection = "";
    focused = 0;
    keyHandler: (event: KeyboardEvent) => boolean = () => true;
    modes = { bracketedPasteMode: false };
    constructor() {
      mocks.term = this;
    }
    loadAddon() {}
    open() {
      mocks.events.push("open");
    }
    focus() {
      this.focused += 1;
    }
    pasted: string[] = [];
    paste(text: string) {
      this.pasted.push(text);
    }
    getSelection() {
      return this.selection;
    }
    clearSelection() {
      this.selection = "";
    }
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
      this.keyHandler = handler;
    }
    onData(listener: (data: string) => void) {
      this.onDataListener = listener;
      return { dispose() {} };
    }
    onSelectionChange(listener: () => void) {
      this.onSelectionListener = listener;
      return { dispose() {} };
    }
    write(bytes: Uint8Array, done?: () => void) {
      mocks.events.push(`write:${bytes.length}`);
      done?.();
    }
    dispose() {
      mocks.events.push("term-dispose");
    }
  },
}));

const settings = { theme: "dark", font_family: "Fira Code", font_size: 14 } as AppSettings;
const connection = { id: "c1", name: "prod" } as Connection;

function outputHandler(): { write: (bytes: Uint8Array, done?: () => void) => void } {
  return mocks.attachOutput.mock.calls[0][1];
}

describe("Terminal extension hooks", () => {
  const removers: (() => void)[] = [];
  const add = (extension: TerminalExtension) => {
    removers.push(registerTerminalExtension(extension));
  };

  beforeEach(() => {
    mocks.events.length = 0;
    useViewStore.setState({ view: "terminals" });
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue(undefined);
    mocks.attachOutput.mockReset();
    mocks.attachOutput.mockImplementation(() => {
      mocks.events.push("attach-output");
      return () => {};
    });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    removers.splice(0).forEach((remove) => remove());
    vi.unstubAllGlobals();
  });

  const mount = (props: Partial<Parameters<typeof Terminal>[0]> = {}) =>
    render(
      <Terminal
        sessionId="s1"
        isVisible
        onDisconnect={vi.fn()}
        settings={settings}
        connection={connection}
        {...props}
      />,
    );

  describe("after a paste from the palette", () => {
    const uptime: Snippet = { id: "1", name: "uptime", command: "uptime" };

    /** What xterm does with a key: ask the custom handler, then send it to the shell. */
    const press = (type: string, repeat = false) => {
      const event = new KeyboardEvent(type, { key: "Enter", repeat, cancelable: true });
      if (mocks.term?.keyHandler(event) !== false && type !== "keyup") {
        mocks.term?.onDataListener("\r");
      }
      return event;
    };
    const writes = () => mocks.invoke.mock.calls.filter(([cmd]) => cmd === "ssh_write");

    function MountedPalette() {
      return useSnippetsStore((s) => s.paletteOpen) ? <SnippetPalette /> : null;
    }

    /** Choose the snippet with Enter, and wait for the terminal to get the keyboard. */
    async function pasteWithEnter() {
      mocks.invoke.mockImplementation(async (cmd: string) =>
        cmd === "get_snippets" ? [uptime] : undefined,
      );
      useTerminalsStore.setState({
        tabs: [
          { id: "t1", mode: "single", panes: [{ sessionId: "s1", connectionName: "prod" }] },
        ],
        activeTabId: "t1",
      });
      useSnippetsStore.setState({ snippets: [uptime], paletteOpen: true });
      mount();
      // It took the keyboard as it opened. What counts is getting it back after the paste.
      if (mocks.term) mocks.term.focused = 0;
      renderInPanel(<MountedPalette />);
      fireEvent.keyDown(await screen.findByTestId("snippet-palette-search"), { key: "Enter" });
      await vi.waitFor(() => expect(mocks.term?.focused).toBe(1));
      expect(writes()).toEqual([["ssh_write", { sessionId: "s1", data: "uptime" }]]);
    }

    afterEach(() => {
      useSnippetsStore.setState({ snippets: [], paletteOpen: false });
      useTerminalsStore.setState({ tabs: [], activeTabId: null });
    });

    it("sends nothing while the Enter that chose the snippet repeats", async () => {
      await pasteWithEnter();
      const held = [press("keydown", true), press("keypress", true), press("keydown", true)];
      expect(writes()).toHaveLength(1);
      expect(held.every((event) => event.defaultPrevented)).toBe(true);
    });

    it("lets the user's next Enter through once that one is released", async () => {
      await pasteWithEnter();
      press("keydown", true);
      press("keyup");
      press("keydown");
      expect(writes()).toEqual([
        ["ssh_write", { sessionId: "s1", data: "uptime" }],
        ["ssh_write", { sessionId: "s1", data: "\r" }],
      ]);
    });
  });

  describe("with a panel open", () => {
    const key = (type: string) => new KeyboardEvent(type, { key: "a", cancelable: true });

    it("forwards no key, on keypress either, where xterm sends printable keys from", () => {
      mount();
      const panel = document.createElement("div");
      panel.dataset.slot = "app-panel-content";
      document.body.appendChild(panel);
      const handler = mocks.term?.keyHandler;
      const keypress = key("keypress");
      expect(handler?.(key("keydown"))).toBe(false);
      expect(handler?.(keypress)).toBe(false);
      expect(keypress.defaultPrevented).toBe(true);
      expect(handler?.(key("keyup"))).toBe(true);
      panel.remove();
      expect(handler?.(key("keypress"))).toBe(true);
    });
  });

  describe("the clipboard keys", () => {
    const writeText = vi.fn(async () => undefined);
    const readText = vi.fn(async () => "pasted");
    const stubPlatform = (userAgent: string) =>
      vi.stubGlobal("navigator", { userAgent, clipboard: { writeText, readText } });

    beforeEach(() => {
      writeText.mockClear();
      readText.mockClear();
      stubPlatform("X11; Linux");
      mount();
    });

    const down = (init: KeyboardEventInit) => {
      const event = new KeyboardEvent("keydown", { cancelable: true, ...init });
      return { event, passed: mocks.term?.keyHandler(event) };
    };
    const select = (text: string) => {
      if (mocks.term) mocks.term.selection = text;
    };
    const CTRL = { ctrlKey: true };
    const CTRL_SHIFT = { ctrlKey: true, shiftKey: true };

    it("copies on Ctrl+Shift+C, swallows the key and lets go of the selection", () => {
      select("abc");
      const { event, passed } = down({ key: "C", ...CTRL_SHIFT });
      expect(writeText).toHaveBeenCalledWith("abc");
      expect(passed).toBe(false);
      expect(event.defaultPrevented).toBe(true);
      expect(mocks.term?.selection).toBe("");
    });

    it("sends nothing and leaves the clipboard alone on Ctrl+Shift+C with no selection", () => {
      const { event, passed } = down({ key: "C", ...CTRL_SHIFT });
      expect(writeText).not.toHaveBeenCalled();
      expect(passed).toBe(false);
      expect(event.defaultPrevented).toBe(true);
    });

    it("leaves Ctrl+C to the program with text selected", () => {
      select("abc");
      const { event, passed } = down({ key: "c", ...CTRL });
      expect(writeText).not.toHaveBeenCalled();
      expect(passed).toBe(true);
      expect(event.defaultPrevented).toBe(false);
    });

    it("pastes once on Ctrl+Shift+V: xterm's own listener must not get a native paste", async () => {
      const { event, passed } = down({ key: "V", ...CTRL_SHIFT });
      expect(passed).toBe(false);
      expect(event.defaultPrevented).toBe(true);
      await vi.waitFor(() => expect(mocks.term?.pasted).toEqual(["pasted"]));
    });

    it("leaves Ctrl+V to the program", () => {
      const { event, passed } = down({ key: "v", ...CTRL });
      expect(readText).not.toHaveBeenCalled();
      expect(passed).toBe(true);
      expect(event.defaultPrevented).toBe(false);
    });

    it("uses Cmd on macOS, and leaves Ctrl+C and Ctrl+V to the program there too", async () => {
      stubPlatform("Macintosh");
      select("abc");

      expect(down({ key: "c", ...CTRL }).passed).toBe(true);
      expect(down({ key: "v", ...CTRL }).passed).toBe(true);
      expect(writeText).not.toHaveBeenCalled();
      expect(readText).not.toHaveBeenCalled();

      expect(down({ key: "c", metaKey: true }).passed).toBe(false);
      expect(writeText).toHaveBeenCalledWith("abc");
      expect(down({ key: "v", metaKey: true }).passed).toBe(false);
      await vi.waitFor(() => expect(mocks.term?.pasted).toEqual(["pasted"]));
    });
  });

  describe("becoming visible", () => {
    const props = {
      sessionId: "s1",
      connectionName: "prod",
      onDisconnect: vi.fn(),
      settings,
      connection,
    };

    async function show() {
      const view = render(<Terminal {...props} isVisible={false} />);
      view.rerender(<Terminal {...props} isVisible />);
      // The terminal waits for the DOM to paint before it refits and takes focus.
      await new Promise((resolve) => setTimeout(resolve, 80));
    }

    it("takes the keyboard when nothing else holds it", async () => {
      await show();
      expect(mocks.term?.focused).toBe(1);
    });

    it("leaves the keyboard with an open panel", async () => {
      const panel = document.createElement("div");
      panel.dataset.slot = "app-panel-content";
      document.body.appendChild(panel);
      await show();
      panel.remove();
      expect(mocks.term?.focused).toBe(0);
    });
  });

  it("runs onCreate with the terminal, session and connection, after open and before output", () => {
    let seen: TerminalExtensionContext | undefined;
    add({
      id: "probe",
      onCreate: (ctx) => {
        mocks.events.push("create");
        seen = ctx;
      },
    });
    mount();
    expect(mocks.events).toEqual(["open", "create", "attach-output"]);
    expect(seen?.term).toBe(mocks.term);
    expect(seen?.sessionId).toBe("s1");
    expect(seen?.connection).toBe(connection);
    expect(seen?.settings).toBe(settings);
  });

  it("keeps the context's settings current without remounting", () => {
    let seen: TerminalExtensionContext | undefined;
    add({ id: "probe", onCreate: (ctx) => void (seen = ctx) });
    const view = mount();
    const newer = { ...settings, font_size: 18 };
    view.rerender(
      <Terminal
        sessionId="s1"
        isVisible
        onDisconnect={vi.fn()}
        settings={newer}
        connection={connection}
      />,
    );
    expect(seen?.settings).toBe(newer);
    expect(mocks.events.filter((e) => e === "open")).toHaveLength(1);
  });

  it("sends input to the session unchanged with no onData extension", () => {
    mount();
    mocks.term?.onDataListener("ls\r");
    expect(mocks.invoke).toHaveBeenCalledWith("ssh_write", { sessionId: "s1", data: "ls\r" });
  });

  it("sends what onData returns", () => {
    add({ id: "upper", onData: (_ctx, data) => data.toUpperCase() });
    mount();
    mocks.term?.onDataListener("ls");
    expect(mocks.invoke).toHaveBeenCalledWith("ssh_write", { sessionId: "s1", data: "LS" });
  });

  it("sends nothing when onData swallows the input", () => {
    add({ id: "swallow", onData: () => null });
    mount();
    mocks.term?.onDataListener("ls");
    expect(mocks.invoke).not.toHaveBeenCalledWith("ssh_write", expect.anything());
  });

  it("runs onOutput with each chunk, after handing it to xterm", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    add({
      id: "probe",
      onOutput: (_ctx, chunk) => {
        expect(chunk).toBe(bytes);
        mocks.events.push("output");
      },
    });
    mount();
    outputHandler().write(bytes);
    expect(mocks.events.slice(-2)).toEqual(["write:3", "output"]);
  });

  it("lets the sink know when xterm has parsed a chunk", () => {
    const done = vi.fn();
    mount();
    outputHandler().write(new Uint8Array([1]), done);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("runs what onCreate returned on unmount, before xterm is disposed", () => {
    add({ id: "probe", onCreate: () => () => void mocks.events.push("cleanup") });
    mount().unmount();
    expect(mocks.events.slice(-2)).toEqual(["cleanup", "term-dispose"]);
  });

  it("registers auto-copy as a built-in extension and it reaches the clipboard", () => {
    expect(terminalExtensions.map((e) => e.id)).toContain("auto-copy-selection");
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      writable: true,
      value: { writeText },
    });
    mount({ settings: { ...settings, auto_copy_selection: true } });
    if (mocks.term) mocks.term.selection = "picked";
    mocks.term?.onSelectionListener();
    expect(writeText).toHaveBeenCalledWith("picked");
  });

  it("makes a mounted terminal reachable through the registry, until it unmounts", () => {
    useTerminalsStore.setState({
      tabs: [{ id: "t1", mode: "single", panes: [{ sessionId: "s1", connectionName: "prod" }] }],
      activeTabId: "t1",
    });
    const view = mount();
    expect(writeToSession("s1", "uptime\r")).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("ssh_write", { sessionId: "s1", data: "uptime\r" });
    view.unmount();
    expect(writeToSession("s1", "uptime\r")).toBe(false);
    expect(activeSessionId()).toBeNull();
    useTerminalsStore.setState({ tabs: [], activeTabId: null });
  });
});
