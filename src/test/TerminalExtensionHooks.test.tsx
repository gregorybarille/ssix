import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { Terminal } from "@/components/Terminal";
import {
  registerTerminalExtension,
  terminalExtensions,
  type TerminalExtension,
  type TerminalExtensionContext,
} from "@/components/terminal/extensions";
import { activeSessionId, writeToSession } from "@/lib/terminalRegistry";
import type { AppSettings, Connection } from "@/types";

/**
 * xterm.js cannot run in jsdom, so a stand-in records what `Terminal` does
 * with it. This pins where the component calls the extension hooks.
 */
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  attachOutput: vi.fn(),
  events: [] as string[],
  term: null as null | {
    onDataListener: (data: string) => void;
    onSelectionListener: () => void;
    selection: string;
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
    constructor() {
      mocks.term = this;
    }
    loadAddon() {}
    open() {
      mocks.events.push("open");
    }
    focus() {}
    paste() {}
    getSelection() {
      return this.selection;
    }
    attachCustomKeyEventHandler() {}
    onData(listener: (data: string) => void) {
      this.onDataListener = listener;
      return { dispose() {} };
    }
    onSelectionChange(listener: () => void) {
      this.onSelectionListener = listener;
      return { dispose() {} };
    }
    write(bytes: Uint8Array) {
      mocks.events.push(`write:${bytes.length}`);
    }
    dispose() {
      mocks.events.push("term-dispose");
    }
  },
}));

const settings = { theme: "dark", font_family: "Fira Code", font_size: 14 } as AppSettings;
const connection = { id: "c1", name: "prod" } as Connection;

function outputHandler(): { write: (bytes: Uint8Array) => void } {
  return mocks.attachOutput.mock.calls[0][1];
}

describe("Terminal extension hooks", () => {
  const removers: (() => void)[] = [];
  const add = (extension: TerminalExtension) => {
    removers.push(registerTerminalExtension(extension));
  };

  beforeEach(() => {
    mocks.events.length = 0;
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
        connectionName="prod"
        isVisible
        onDisconnect={vi.fn()}
        settings={settings}
        connection={connection}
        {...props}
      />,
    );

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
        connectionName="prod"
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
    const view = mount();
    expect(writeToSession("s1", "uptime\r")).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("ssh_write", { sessionId: "s1", data: "uptime\r" });
    view.unmount();
    expect(writeToSession("s1", "uptime\r")).toBe(false);
    expect(activeSessionId()).toBeNull();
  });
});
