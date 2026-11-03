import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal as XTerm } from "@xterm/xterm";
import { broadcastInput, isTypedInput } from "@/components/terminal/broadcastInput";
import { runTerminalData, type TerminalExtensionContext } from "@/components/terminal/extensions";
import "@/components/terminal/registerExtensions";
import type { TerminalSession, TerminalTab } from "@/components/TerminalTabs";
import type { AuthEvent } from "@/lib/authPrompt";
import { invoke } from "@/lib/tauri";
import { deliverChannelMessage, type OutputSink } from "@/lib/terminalOutput";
import {
  isLiveShell,
  registerTerminal,
  unregisterTerminal,
  writeToSession,
} from "@/lib/terminalRegistry";
import { useAuthPromptStore } from "@/store/useAuthPromptStore";
import { useTerminalsStore } from "@/store/useTerminalsStore";
import type { Connection } from "@/types";

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn(async () => undefined) }));

/** The channel each `ssh_connect` gets, with what the store does with a login's events. */
const channels: { sink: OutputSink; onAuthEvent: (event: AuthEvent) => void }[] = [];
vi.mock("@/lib/terminalOutput", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/terminalOutput")>();
  return {
    ...actual,
    createOutputChannel: vi.fn(async (onAuthEvent: (event: AuthEvent) => void) => {
      const sink = new actual.OutputSink();
      channels.push({ sink, onAuthEvent });
      return { channel: {}, sink };
    }),
  };
});

const invokeMock = vi.mocked(invoke);

const live = (sessionId: string): TerminalSession => ({ sessionId, connectionName: sessionId });

const reconnecting = (sessionId: string): TerminalSession => ({
  ...live(sessionId),
  reconnect: { phase: "waiting", attempt: 1, maxAttempts: 5, retryAt: 0, message: "gone" },
});

/** Every state in which a pane is not showing a shell the user can type in. */
const NOT_LIVE: [string, TerminalSession][] = [
  ["is reconnecting", reconnecting("other")],
  ["stopped reconnecting", { ...live("other"), reconnect: { phase: "stopped", message: "gone" } }],
  ["failed to connect", { ...live("other"), error: "TCP connect failed" }],
  ["is still connecting", { ...live("other"), retrying: true }],
  ["whose shell ended", { ...live("other"), ended: true }],
];

function tabWith(panes: TerminalSession[], broadcast = true): TerminalTab {
  return { id: "t1", mode: "horizontal", panes, broadcast };
}

const fakeTerm = (bracketedPasteMode = false) =>
  ({
    textarea: document.createElement("textarea"),
    modes: { bracketedPasteMode },
  }) as unknown as XTerm;

const registered: string[] = [];
/** `askedForBracketedPaste`: the sessions whose program asked for it. */
function setup(tabs: TerminalTab[], askedForBracketedPaste: string[] = []) {
  useTerminalsStore.setState({ tabs, activeTabId: tabs[0]?.id ?? null });
  for (const pane of tabs.flatMap((tab) => tab.panes)) {
    registerTerminal(pane.sessionId, fakeTerm(askedForBracketedPaste.includes(pane.sessionId)));
    registered.push(pane.sessionId);
  }
}

const type = (sessionId: string, data: string) =>
  broadcastInput.onData?.({ sessionId } as TerminalExtensionContext, data);

const writes = () =>
  invokeMock.mock.calls.filter(([command]) => command === "ssh_write").map(([, args]) => args);

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  useAuthPromptStore.setState({ prompts: {} });
  registered.splice(0).forEach(unregisterTerminal);
  useTerminalsStore.setState({ tabs: [], activeTabId: null });
});

describe("isTypedInput", () => {
  it.each([
    ["plain text", "ls -la"],
    ["Enter", "\r"],
    ["Ctrl+C", "\x03"],
    ["Backspace", "\x7f"],
    ["Tab", "\t"],
    ["Esc", "\x1b"],
    ["Alt+b", "\x1bb"],
    ["Alt+Backspace", "\x1b\x7f"],
    ["Up, normal mode", "\x1b[A"],
    ["Down, application mode", "\x1bOB"],
    ["Ctrl+Right", "\x1b[1;5C"],
    ["Home", "\x1b[H"],
    ["End, application mode", "\x1bOF"],
    ["Shift+Tab", "\x1b[Z"],
    ["F1", "\x1bOP"],
    ["F5", "\x1b[15~"],
    ["Delete", "\x1b[3~"],
    ["Page Up with Shift", "\x1b[5;2~"],
    ["Shift+F1", "\x1b[1;2P"],
    ["a bracketed paste", "\x1b[200~git status\r\x1b[201~"],
    ["an empty bracketed paste", "\x1b[200~\x1b[201~"],
  ])("passes %s", (_name, data) => {
    expect(isTypedInput(data)).toBe(true);
  });

  it.each([
    ["an SGR mouse press", "\x1b[<0;10;5M"],
    ["an SGR mouse release", "\x1b[<0;10;5m"],
    ["an SGR mouse move", "\x1b[<35;80;24M"],
    ["an urxvt mouse report", "\x1b[32;10;5M"],
    ["an X10 mouse report", "\x1b[M !!"],
    ["focus in", "\x1b[I"],
    ["focus out", "\x1b[O"],
    ["a cursor position report", "\x1b[24;80R"],
    ["a primary device attributes reply", "\x1b[?1;2c"],
    ["a secondary device attributes reply", "\x1b[>0;276;0c"],
    ["a device status report", "\x1b[0n"],
    ["a mode report", "\x1b[?2004;1$y"],
    ["an OSC colour reply", "\x1b]11;rgb:1a1a/1b1b/2626\x1b\\"],
    ["a DCS reply", "\x1bP1$r0m\x1b\\"],
    ["a window size reply", "\x1b[8;24;80t"],
  ])("refuses %s", (_name, data) => {
    expect(isTypedInput(data)).toBe(false);
  });
});

describe("isLiveShell", () => {
  it("holds for a pane showing its shell", () => {
    expect(isLiveShell(live("a"))).toBe(true);
  });

  it.each(NOT_LIVE)("does not hold for a pane that %s", (_name, pane) => {
    expect(isLiveShell(pane)).toBe(false);
  });
});

describe("broadcastInput", () => {
  it("mirrors what is typed in one pane to the other, and leaves it for its own", () => {
    setup([tabWith([live("a"), live("b")])]);
    expect(type("a", "ls\r")).toBe("ls\r");
    expect(writes()).toEqual([{ sessionId: "b", data: "ls\r" }]);
  });

  it("works from either pane of the tab", () => {
    setup([tabWith([live("a"), live("b")])]);
    type("b", "x");
    expect(writes()).toEqual([{ sessionId: "a", data: "x" }]);
  });

  it("is off by default", () => {
    setup([{ id: "t1", mode: "horizontal", panes: [live("a"), live("b")] }]);
    expect(type("a", "ls\r")).toBe("ls\r");
    expect(writes()).toEqual([]);
  });

  it("stays inside its tab", () => {
    setup([
      tabWith([live("a"), live("b")]),
      { id: "t2", mode: "single", panes: [live("elsewhere")] },
    ]);
    type("a", "x");
    expect(writes()).toEqual([{ sessionId: "b", data: "x" }]);
  });

  it.each(NOT_LIVE)("sends nothing to a pane that %s", (_name, pane) => {
    setup([tabWith([live("a"), pane])]);
    expect(type("a", "x")).toBe("x");
    expect(writes()).toEqual([]);
  });

  it.each(NOT_LIVE)("mirrors nothing from a pane that %s", (_name, pane) => {
    setup([tabWith([pane, live("b")])]);
    expect(type("other", "x")).toBe("x");
    expect(writes()).toEqual([]);
  });

  it("does not mirror mouse reports, focus changes or query replies", () => {
    setup([tabWith([live("a"), live("b")])]);
    for (const data of ["\x1b[<0;10;5M", "\x1b[I", "\x1b[O", "\x1b[24;80R"]) {
      expect(type("a", data)).toBe(data);
    }
    expect(writes()).toEqual([]);
  });

  it("mirrors a paste", () => {
    setup([tabWith([live("a"), live("b")])], ["b"]);
    const paste = "\x1b[200~git status\r\x1b[201~";
    type("a", paste);
    expect(writes()).toEqual([{ sessionId: "b", data: paste }]);
  });

  it("mirrors a paste cleaned of what would end its brackets early", () => {
    setup([tabWith([live("a"), live("b")])], ["b"]);
    const ctx = { sessionId: "a" } as TerminalExtensionContext;
    const sent = runTerminalData(ctx, "\x1b[200~ls\x1b[201~\rid\r\x1b[201~");
    const clean = "\x1b[200~ls[201~\rid\r\x1b[201~";
    expect(sent).toBe(clean);
    expect(writes()).toEqual([{ sessionId: "b", data: clean }]);
  });

  it("reaches a pane again once it is back, with only what is typed from then on", () => {
    setup([tabWith([live("a"), reconnecting("b")])]);
    type("a", "x");
    expect(writes()).toEqual([]);
    useTerminalsStore.setState({ tabs: [tabWith([live("a"), live("b")])] });
    type("a", "y");
    expect(writes()).toEqual([{ sessionId: "b", data: "y" }]);
  });
});

describe("a bracketed paste, in a pane that did not ask for one", () => {
  const skipped = () => useTerminalsStore.getState().tabs[0].broadcastSkipped;
  const bracketed = (text: string) => `\x1b[200~${text}\x1b[201~`;

  it("goes as it is to a pane that asked for one too", () => {
    setup([tabWith([live("a"), live("b")])], ["b"]);
    type("a", bracketed("one\rtwo"));
    expect(writes()).toEqual([{ sessionId: "b", data: bracketed("one\rtwo") }]);
    expect(skipped()).toEqual([]);
  });

  it("goes as plain text when it is one line, with no markers and no Enter", () => {
    setup([tabWith([live("a"), live("b")])]);
    type("a", bracketed("uptime\r"));
    expect(writes()).toEqual([{ sessionId: "b", data: "uptime" }]);
    expect(skipped()).toEqual([]);
  });

  it.each([
    ["several lines", "rm -rf a\rrm -rf b"],
    ["a tab", "echo a\tb"],
  ])("is not sent with %s, and says so", (_name, text) => {
    setup([tabWith([live("a"), live("b")])]);
    expect(type("a", bracketed(text))).toBe(bracketed(text));
    expect(writes()).toEqual([]);
    expect(skipped()).toEqual(["b"]);
  });

  it("is sent to the next pane as usual after one that was skipped", () => {
    setup([tabWith([live("a"), live("b"), live("c")])], ["c"]);
    type("a", bracketed("one\rtwo"));
    expect(writes()).toEqual([{ sessionId: "c", data: bracketed("one\rtwo") }]);
    expect(skipped()).toEqual(["b"]);
  });

  it("is forgotten at the next paste that reaches the pane, not at the next key", () => {
    setup([tabWith([live("a"), live("b")])]);
    type("a", bracketed("one\rtwo"));
    type("a", "x");
    expect(skipped()).toEqual(["b"]);
    type("a", bracketed("three"));
    expect(skipped()).toEqual([]);
  });

  it("is forgotten when broadcast goes off", () => {
    setup([tabWith([live("a"), live("b")])]);
    type("a", bracketed("one\rtwo"));
    useTerminalsStore.getState().toggleBroadcast("t1");
    expect(skipped()).toBeUndefined();
  });

  it("does not count a pane that receives nothing anyway", () => {
    setup([tabWith([live("a"), reconnecting("b")])]);
    type("a", bracketed("one\rtwo"));
    expect(skipped()).toEqual([]);
  });
});

describe("a pane showing a login prompt", () => {
  const conn: Connection = { id: "c1", name: "web", host: "h", port: 22, type: "direct" };
  const store = () => useTerminalsStore.getState();
  const prompt: AuthEvent = {
    kind: "auth_prompt",
    prompt_id: "p1",
    host: "h:22",
    username: "me",
    instructions: "",
    prompts: [{ text: "Code: ", echo: false }],
  };
  const closed: AuthEvent = { kind: "auth_prompt_closed", prompt_id: "p1" };
  const secondPane = () => store().tabs[0].panes[1];

  const withTerminal = (sessionId: string) => {
    registerTerminal(sessionId, fakeTerm());
    registered.push(sessionId);
  };

  /** Split a live pane through the store, so the second pane's events take the real route. */
  async function split(sshConnect: () => Promise<unknown>) {
    channels.length = 0;
    invokeMock.mockImplementation(async (command: string) =>
      command === "ssh_connect" ? sshConnect() : undefined,
    );
    useTerminalsStore.setState({ tabs: [tabWith([live("a")], false)], activeTabId: "t1" });
    withTerminal("a");
    const connected = store().connect(conn, { mode: "split_right" });
    await vi.waitFor(() => expect(channels).toHaveLength(1));
    store().toggleBroadcast("t1");
    return { connected, ...channels[0] };
  }

  async function splitWithShell() {
    const opened = await split(async () => "b");
    await opened.connected;
    withTerminal("b");
    return opened;
  }

  it("gets nothing while logging in for the first time, when it has no terminal yet", async () => {
    let finish = (_sessionId: string) => {};
    const opened = await split(() => new Promise((resolve) => (finish = resolve)));
    opened.onAuthEvent(prompt);
    expect(useAuthPromptStore.getState().prompts[secondPane().sessionId]).toBeDefined();

    expect(isLiveShell(secondPane())).toBe(false);
    type("a", "x");
    expect(writes()).toEqual([]);
    finish("b");
    await opened.connected;
  });

  it("gets nothing through a reconnect, and what is typed from then on once it is back", async () => {
    const { sink, onAuthEvent } = await splitWithShell();
    deliverChannelMessage(sink, {
      kind: "reconnecting",
      attempt: 1,
      max_attempts: 5,
      delay_ms: 0,
      message: "gone",
    });
    onAuthEvent(prompt);

    type("a", "password");
    expect(writeToSession("b", "uptime\r")).toBe(false);
    expect(writes()).toEqual([]);

    onAuthEvent(closed);
    deliverChannelMessage(sink, { kind: "reconnected" });
    type("a", "after");
    expect(writes()).toEqual([{ sessionId: "b", data: "after" }]);
  });

  it("counts as no live shell for as long as the prompt shows, whatever else the pane says", async () => {
    const { onAuthEvent } = await splitWithShell();
    expect(isLiveShell(secondPane())).toBe(true);

    onAuthEvent(prompt);
    expect(secondPane().reconnect).toBeUndefined();
    expect(isLiveShell(secondPane())).toBe(false);
    type("a", "x");
    expect(writes()).toEqual([]);

    onAuthEvent(closed);
    expect(isLiveShell(secondPane())).toBe(true);
  });
});

describe("the broadcast state of a tab", () => {
  const conn: Connection = { id: "c1", name: "web", host: "h", port: 22, type: "direct" };
  const store = () => useTerminalsStore.getState();
  const tab = () => store().tabs[0];
  const connectGivesSession = () =>
    invokeMock.mockImplementation(async (command: string) =>
      command === "ssh_connect" ? "new-session" : undefined,
    );

  it("needs two panes to turn on", () => {
    useTerminalsStore.setState({
      tabs: [{ id: "t1", mode: "single", panes: [live("a")] }],
      activeTabId: "t1",
    });
    store().toggleBroadcast("t1");
    expect(tab().broadcast).toBeFalsy();
  });

  it("turns on and off for the one tab", () => {
    useTerminalsStore.setState({
      tabs: [
        tabWith([live("a"), live("b")], false),
        { ...tabWith([live("c"), live("d")], false), id: "t2" },
      ],
      activeTabId: "t1",
    });
    store().toggleBroadcast("t1");
    expect(store().tabs.map((t) => !!t.broadcast)).toEqual([true, false]);
    store().toggleBroadcast("t1");
    expect(store().tabs.map((t) => !!t.broadcast)).toEqual([false, false]);
  });

  it("goes off when a pane is closed, and stays off when the tab splits again", async () => {
    connectGivesSession();
    useTerminalsStore.setState({ tabs: [tabWith([live("a"), live("b")])], activeTabId: "t1" });
    await store().closePane("b");
    expect(tab().panes.map((pane) => pane.sessionId)).toEqual(["a"]);
    expect(tab().broadcast).toBeFalsy();

    await store().connect(conn, { mode: "split_right" });
    expect(tab().panes).toHaveLength(2);
    expect(tab().broadcast).toBe(false);
  });

  it("starts off in a new tab, and a new tab leaves the others as they are", async () => {
    connectGivesSession();
    useTerminalsStore.setState({ tabs: [tabWith([live("a"), live("b")])], activeTabId: "t1" });
    await store().connect(conn, { mode: "tab" });
    expect(store().tabs).toHaveLength(2);
    expect(store().tabs[0].broadcast).toBe(true);
    expect(store().tabs[1].broadcast).toBeFalsy();
  });

  it("remembers that a shell ended", () => {
    useTerminalsStore.setState({ tabs: [tabWith([live("a"), live("b")])], activeTabId: "t1" });
    store().markSessionEnded("b");
    expect(isLiveShell(tab().panes[1])).toBe(false);
    expect(isLiveShell(tab().panes[0])).toBe(true);
  });
});
