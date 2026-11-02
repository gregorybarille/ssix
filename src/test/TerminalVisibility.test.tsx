import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@/components/Terminal";
import { useTerminalsStore } from "@/store/useTerminalsStore";
import { useViewStore } from "@/store/useViewStore";
import type { AppSettings, Connection } from "@/types";

/**
 * A terminal stays mounted while another tab or view is on screen. xterm cannot
 * run in jsdom, so a stand-in records what `Terminal` does with it, and tests
 * set the pane's size, which is zero under `display: none`.
 */
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  fit: vi.fn(),
  output: null as null | {
    write: (bytes: Uint8Array) => void;
    onEvent: (event: { kind: string; message?: string }) => void;
  },
  terms: [] as {
    options: Record<string, unknown>;
    keyHandler: (event: KeyboardEvent) => boolean;
    focus: ReturnType<typeof vi.fn>;
    textarea: HTMLTextAreaElement;
    written: unknown[];
  }[],
  resize: null as null | (() => void),
}));

vi.mock("@/lib/tauri", () => ({ invoke: mocks.invoke }));
vi.mock("@/lib/terminalOutput", () => ({
  attachOutput: (_id: string, handler: typeof mocks.output) => {
    mocks.output = handler;
    return () => {};
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = mocks.fit;
  },
}));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    onContextLoss() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {
    onDidChangeResults() {
      return { dispose() {} };
    }
    clearDecorations() {}
  },
}));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 100;
    rows = 30;
    options: Record<string, unknown>;
    textarea = document.createElement("textarea");
    focus = vi.fn();
    written: unknown[] = [];
    keyHandler: (event: KeyboardEvent) => boolean = () => true;
    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      mocks.terms.push(this);
    }
    loadAddon() {}
    open() {}
    paste() {}
    clearSelection() {}
    getSelection() {
      return "";
    }
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
      this.keyHandler = handler;
    }
    onData() {
      return { dispose() {} };
    }
    onSelectionChange() {
      return { dispose() {} };
    }
    write(data: unknown) {
      this.written.push(data);
    }
    dispose() {}
  },
}));

const settings = {
  theme: "dark",
  font_family: "Fira Code",
  font_size: 14,
} as AppSettings;
const connection = { id: "c1", name: "prod" } as Connection;

const resizes = () => mocks.invoke.mock.calls.filter(([command]) => command === "ssh_resize");
const key = (init: KeyboardEventInit, type = "keydown") => new KeyboardEvent(type, init);
const IS_MAC = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || "");
const FIND = IS_MAC ? { key: "f", metaKey: true } : { key: "F", ctrlKey: true, shiftKey: true };

function stubPaneSize(width: number, height: number) {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(width);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(height);
}

describe("a terminal off screen", () => {
  const onDisconnect = vi.fn();

  const element = (props: Partial<Parameters<typeof Terminal>[0]> = {}) => (
    <Terminal
      sessionId="s1"
      connectionName="prod"
      isVisible
      onDisconnect={onDisconnect}
      settings={settings}
      connection={connection}
      {...props}
    />
  );

  /** Run the delayed fit and focus of a terminal coming on screen. */
  const settle = () => act(() => vi.advanceTimersByTime(60));

  const term = () => mocks.terms[mocks.terms.length - 1];

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.terms.length = 0;
    mocks.output = null;
    mocks.resize = null;
    mocks.fit.mockClear();
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue(undefined);
    onDisconnect.mockClear();
    useViewStore.setState({ view: "terminals" });
    useTerminalsStore.setState({
      tabs: [{ id: "t1", mode: "single", panes: [{ sessionId: "s1", connectionName: "prod" }] }],
      activeTabId: "t1",
    });
    stubPaneSize(800, 600);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          mocks.resize = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    useTerminalsStore.setState({ tabs: [], activeTabId: null });
  });

  it("neither fits nor resizes the session when it is mounted hidden", () => {
    render(element({ isVisible: false }));
    settle();
    expect(mocks.fit).not.toHaveBeenCalled();
    expect(resizes()).toEqual([]);
  });

  it("neither fits nor resizes the session on the resize that hiding it causes", () => {
    const view = render(element());
    settle();
    mocks.fit.mockClear();
    mocks.invoke.mockClear();

    view.rerender(element({ isVisible: false }));
    stubPaneSize(0, 0);
    mocks.resize?.();
    settle();

    expect(mocks.fit).not.toHaveBeenCalled();
    expect(resizes()).toEqual([]);
  });

  it("does not fit a visible pane with no size", () => {
    stubPaneSize(0, 0);
    render(element());
    settle();
    mocks.resize?.();
    expect(mocks.fit).not.toHaveBeenCalled();
    expect(resizes()).toEqual([]);
  });

  it("refits and tells the server when shown again", () => {
    const view = render(element({ isVisible: false }));
    settle();
    view.rerender(element());
    settle();
    expect(mocks.fit).toHaveBeenCalledOnce();
    expect(resizes()).toEqual([["ssh_resize", { sessionId: "s1", cols: 100, rows: 30 }]]);
  });

  it("lets go of the keyboard when hidden, and takes it back when shown", () => {
    const view = render(element({ isVisible: false }));
    view.rerender(element());
    settle();
    expect(term().focus).toHaveBeenCalledOnce();

    document.body.appendChild(term().textarea);
    term().textarea.focus();
    view.rerender(element({ isVisible: false }));
    expect(document.activeElement).not.toBe(term().textarea);
    term().textarea.remove();

    term().focus.mockClear();
    view.rerender(element());
    settle();
    expect(term().focus).toHaveBeenCalledOnce();
  });

  it("does not take the keyboard from a panel open beside it", () => {
    const panel = document.createElement("div");
    panel.dataset.slot = "app-panel-content";
    document.body.appendChild(panel);
    const view = render(element({ isVisible: false }));
    view.rerender(element());
    settle();
    expect(mocks.fit).toHaveBeenCalled();
    expect(term().focus).not.toHaveBeenCalled();
    panel.remove();
  });

  it("gives the keyboard to the pane that had it when a split tab comes back", () => {
    useTerminalsStore.setState({
      tabs: [
        {
          id: "t1",
          mode: "horizontal",
          panes: [
            { sessionId: "s1", connectionName: "a" },
            { sessionId: "s2", connectionName: "b" },
          ],
        },
      ],
      activeTabId: "t1",
    });
    const view = render(
      <>
        {element({ isVisible: false })}
        {element({ isVisible: false, sessionId: "s2" })}
      </>,
    );
    const [first, second] = mocks.terms;
    // Attached, or focus events never fire and the registry cannot follow them.
    document.body.append(first.textarea, second.textarea);
    second.textarea.focus();
    second.textarea.blur();

    view.rerender(
      <>
        {element()}
        {element({ sessionId: "s2" })}
      </>,
    );
    settle();
    expect(second.focus).toHaveBeenCalledOnce();
    expect(first.focus).not.toHaveBeenCalled();
    first.textarea.remove();
    second.textarea.remove();
  });

  describe("when it has just opened", () => {
    function focusedElsewhere(tag: string, wrapperClass = "") {
      const wrapper = document.createElement("div");
      wrapper.className = wrapperClass;
      const held = document.createElement(tag);
      wrapper.append(held);
      document.body.append(wrapper);
      held.focus();
      return wrapper;
    }

    it("takes the keyboard", () => {
      render(element());
      expect(term().focus).toHaveBeenCalledOnce();
    });

    it("takes it from the button that asked for it", () => {
      const button = focusedElsewhere("button");
      render(element());
      expect(term().focus).toHaveBeenCalledOnce();
      button.remove();
    });

    it.each([
      ["a text field", "input", ""],
      ["another terminal", "textarea", "xterm"],
    ])("leaves it with someone typing in %s", (_name, tag, wrapperClass) => {
      const elsewhere = focusedElsewhere(tag, wrapperClass);
      render(element());
      expect(term().focus).not.toHaveBeenCalled();
      elsewhere.remove();
    });

    it("leaves it to a panel open beside it", () => {
      const panel = document.createElement("div");
      panel.dataset.slot = "app-panel-content";
      document.body.append(panel);
      render(element());
      expect(term().focus).not.toHaveBeenCalled();
      panel.remove();
    });

    it("leaves it alone when it opens off screen", () => {
      render(element({ isVisible: false }));
      expect(term().focus).not.toHaveBeenCalled();
    });
  });

  describe("when a tab comes on screen", () => {
    const inTab = (props: Partial<Parameters<typeof Terminal>[0]>) => (
      <div role="tabpanel">
        <input data-testid="other-pane" />
        {element(props)}
      </div>
    );

    it("leaves the keyboard on a login prompt that took it in the other pane", () => {
      const view = render(inTab({ isVisible: false }));
      view.rerender(inTab({}));
      view.getByTestId("other-pane").focus();
      settle();
      expect(mocks.fit).toHaveBeenCalled();
      expect(term().focus).not.toHaveBeenCalled();
    });

    it("takes it from the button that brought the tab on screen", () => {
      const button = document.createElement("button");
      document.body.append(button);
      const view = render(inTab({ isVisible: false }));
      button.focus();
      view.rerender(inTab({}));
      settle();
      expect(term().focus).toHaveBeenCalledOnce();
      button.remove();
    });
  });

  it("refuses every key, on keypress too, which xterm would otherwise send", () => {
    const view = render(element());
    settle();
    view.rerender(element({ isVisible: false }));

    expect(term().keyHandler(key({ key: "a" }))).toBe(false);
    const keypress = new KeyboardEvent("keypress", { key: "a", cancelable: true });
    expect(term().keyHandler(keypress)).toBe(false);
    expect(keypress.defaultPrevented).toBe(true);
    expect(term().keyHandler(key({ key: "Enter" }, "keypress"))).toBe(false);
  });

  it("takes keys again once it is back", () => {
    const view = render(element({ isVisible: false }));
    expect(term().keyHandler(key({ key: "a" }))).toBe(false);
    view.rerender(element());
    expect(term().keyHandler(key({ key: "a" }))).toBe(true);
    expect(term().keyHandler(key({ key: "a" }, "keypress"))).toBe(true);
  });

  it("keeps the find shortcut from a visible terminal, and leaves Ctrl+F to the program", () => {
    render(element());
    expect(term().keyHandler(key(FIND))).toBe(false);
    expect(term().keyHandler(key({ key: "f", ctrlKey: true }))).toBe(true);
  });

  it("still writes output that arrives while hidden", () => {
    render(element({ isVisible: false }));
    const bytes = new Uint8Array([104, 105]);
    mocks.output?.write(bytes);
    expect(term().written).toEqual([bytes]);
  });

  describe("when its shell ends", () => {
    it("asks at once on screen", () => {
      render(element());
      mocks.output?.onEvent({ kind: "closed" });
      expect(onDisconnect).toHaveBeenCalledOnce();
    });

    it("waits until it is shown again off screen, and asks once", () => {
      const view = render(element({ isVisible: false }));
      mocks.output?.onEvent({ kind: "closed" });
      expect(onDisconnect).not.toHaveBeenCalled();
      expect(term().written.join("")).toContain("Connection closed.");

      view.rerender(element());
      expect(onDisconnect).toHaveBeenCalledOnce();
      view.rerender(element({ isVisible: false }));
      view.rerender(element());
      expect(onDisconnect).toHaveBeenCalledOnce();
    });

    it("marks the pane, so broadcast input leaves it out from then on", () => {
      render(element({ isVisible: false }));
      mocks.output?.onEvent({ kind: "closed" });
      expect(useTerminalsStore.getState().tabs[0].panes[0].ended).toBe(true);
    });
  });

  describe("appearance", () => {
    it("uses the connection's look over the app's settings", () => {
      render(
        element({
          connection: { ...connection, font_family: "Hack", font_size: 18, color_scheme: "dracula" },
        }),
      );
      expect(term().options.fontSize).toBe(18);
      expect(term().options.fontFamily).toBe("'Hack', monospace");
      expect((term().options.theme as { background: string }).background).toBe("#282a36");
    });

    it("opens with the app's colours when the stored scheme is unknown", () => {
      render(element({ connection: { ...connection, color_scheme: "retired-palette" } }));
      expect((term().options.theme as { background: string }).background).toBe("#1a1b26");
    });

    it("applies a saved edit to a terminal on screen, without a new terminal", () => {
      const view = render(element());
      settle();
      mocks.fit.mockClear();
      view.rerender(
        element({ connection: { ...connection, font_size: 20, color_scheme: "nord" } }),
      );
      expect(mocks.terms).toHaveLength(1);
      expect(term().options.fontSize).toBe(20);
      expect((term().options.theme as { background: string }).background).toBe("#2e3440");
      expect(mocks.fit).toHaveBeenCalledOnce();
    });

    it("waits to change the font of a terminal off screen, which cannot measure it", () => {
      const view = render(element({ isVisible: false }));
      view.rerender(
        element({
          isVisible: false,
          connection: { ...connection, font_size: 20, color_scheme: "nord" },
        }),
      );
      expect(term().options.fontSize).toBe(14);
      // Colours need no measuring.
      expect((term().options.theme as { background: string }).background).toBe("#2e3440");
      expect(mocks.fit).not.toHaveBeenCalled();

      view.rerender(element({ connection: { ...connection, font_size: 20, color_scheme: "nord" } }));
      expect(term().options.fontSize).toBe(20);
    });
  });
});
