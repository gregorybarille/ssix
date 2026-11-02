import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseAuthEvent, type AuthEvent } from "@/lib/authPrompt";
import { invoke } from "@/lib/tauri";
import { OutputSink, routeChannelMessage, type OutputEvent } from "@/lib/terminalOutput";
import { useAuthPromptStore } from "@/store/useAuthPromptStore";
import { useTerminalsStore } from "@/store/useTerminalsStore";
import type { Connection } from "@/types";

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);

const prompt = (prompt_id: string, text = "Password: "): AuthEvent => ({
  kind: "auth_prompt",
  prompt_id,
  host: "host:22",
  username: "me",
  instructions: "",
  prompts: [{ text, echo: false }],
});
const closed = (prompt_id: string): AuthEvent => ({ kind: "auth_prompt_closed", prompt_id });

const callsTo = (command: string) => invokeMock.mock.calls.filter(([name]) => name === command);

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  useAuthPromptStore.setState({ prompts: {} });
  useTerminalsStore.setState({ tabs: [], activeTabId: null });
});

describe("parseAuthEvent", () => {
  it("keeps what the server refused, when it says", () => {
    const refused = { ...prompt("p1"), refused: "The server refused the stored key." };
    expect(parseAuthEvent(refused)).toEqual(refused);
    expect(parseAuthEvent({ ...prompt("p1"), refused: 7 })).toEqual(prompt("p1"));
  });

  it("reads both events as the backend sends them", () => {
    expect(parseAuthEvent(prompt("p1"))).toEqual(prompt("p1"));
    expect(parseAuthEvent(closed("p1"))).toEqual(closed("p1"));
  });

  it("keeps only the known fields", () => {
    expect(parseAuthEvent({ ...prompt("p1"), extra: "x" })).toEqual(prompt("p1"));
  });

  it.each([
    ["bytes", new ArrayBuffer(4)],
    ["a string", "auth_prompt"],
    ["null", null],
    ["another event", { kind: "closed" }],
    ["no id", { kind: "auth_prompt_closed" }],
    ["a field without echo", { ...prompt("p1"), prompts: [{ text: "x" }] }],
    ["prompts that are no list", { ...prompt("p1"), prompts: "Password" }],
    ["no host", { kind: "auth_prompt", prompt_id: "p1", username: "me", instructions: "", prompts: [] }],
  ])("ignores %s", (_name, payload) => {
    expect(parseAuthEvent(payload)).toBeNull();
  });
});

describe("routeChannelMessage", () => {
  function route(payload: unknown) {
    const sink = new OutputSink();
    const events: OutputEvent[] = [];
    const chunks: Uint8Array[] = [];
    sink.attach({ write: (chunk) => chunks.push(chunk), onEvent: (event) => events.push(event) });
    const authEvents: AuthEvent[] = [];
    routeChannelMessage(sink, payload, (event) => authEvents.push(event));
    return { authEvents, chunks, events };
  }

  it("hands login prompts to the handler, not to the terminal", () => {
    const { authEvents, chunks, events } = route(prompt("p1"));
    expect(authEvents).toEqual([prompt("p1")]);
    expect(chunks).toEqual([]);
    expect(events).toEqual([]);
  });

  it("leaves bytes and session events to the terminal", () => {
    expect(route(new Uint8Array([104, 105]).buffer).chunks).toHaveLength(1);
    expect(route({ kind: "closed" }).events).toEqual([{ kind: "closed" }]);
    expect(route({ kind: "closed" }).authEvents).toEqual([]);
  });

  it("drops a prompt when nobody asked for them", () => {
    const sink = new OutputSink();
    routeChannelMessage(sink, prompt("p1"));
    const events: OutputEvent[] = [];
    sink.attach({ write: () => {}, onEvent: (event) => events.push(event) });
    expect(events).toEqual([]);
  });
});

describe("useAuthPromptStore", () => {
  const store = () => useAuthPromptStore.getState();

  it("shows a prompt until its own close arrives", () => {
    store().receive("pane", prompt("p1"));
    expect(store().prompts.pane?.prompt_id).toBe("p1");
    expect(store().prompts.pane).not.toHaveProperty("kind");

    store().receive("pane", closed("other"));
    expect(store().prompts.pane?.prompt_id).toBe("p1");

    store().receive("pane", closed("p1"));
    expect(store().prompts.pane).toBeUndefined();
  });

  it("keeps a later round when the earlier one's close arrives after it", () => {
    store().receive("pane", prompt("p1"));
    store().receive("pane", prompt("p2", "Code: "));
    store().receive("pane", closed("p1"));
    expect(store().prompts.pane?.prompt_id).toBe("p2");
  });

  it("closes a prompt by its id, under whichever pane id it was shown", () => {
    store().receive("placeholder", prompt("p1"));
    store().receive("real-session", closed("p1"));
    expect(store().prompts).toEqual({});
  });

  it("sends answers for the pane's prompt", async () => {
    store().receive("pane", prompt("p1"));
    await store().answer("pane", ["secret"]);
    expect(invokeMock).toHaveBeenCalledWith("ssh_auth_answer", {
      promptId: "p1",
      answers: ["secret"],
    });
  });

  it("rejects refused answers and leaves the prompt open", async () => {
    store().receive("pane", prompt("p1"));
    invokeMock.mockRejectedValueOnce("That answer is too long");
    await expect(store().answer("pane", ["x"])).rejects.toBe("That answer is too long");
    expect(store().prompts.pane?.prompt_id).toBe("p1");
  });

  it("does nothing for a pane with no prompt", async () => {
    await store().answer("pane", ["secret"]);
    store().cancel("pane");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("cancels: the prompt goes at once and the backend is told", () => {
    store().receive("pane", prompt("p1"));
    store().cancel("pane");
    expect(store().prompts.pane).toBeUndefined();
    expect(invokeMock).toHaveBeenCalledWith("ssh_auth_cancel", { promptId: "p1" });
  });

  it("survives a failed cancel", async () => {
    invokeMock.mockRejectedValueOnce("gone");
    store().receive("pane", prompt("p1"));
    expect(() => store().cancel("pane")).not.toThrow();
    await Promise.resolve();
  });

  it("refuses a prompt without showing it, and ignores a close", () => {
    store().refuse(prompt("p1"));
    store().refuse(closed("p2"));
    expect(store().prompts).toEqual({});
    expect(callsTo("ssh_auth_cancel")).toEqual([["ssh_auth_cancel", { promptId: "p1" }]]);
  });
});

describe("a connecting pane", () => {
  const conn: Connection = { id: "c1", name: "otp", host: "h", port: 22, type: "direct", tags: [] };

  /** Start connecting and return what the backend got, with ssh_connect left hanging. */
  async function connecting() {
    let finish!: (sessionId: string) => void;
    let fail!: (reason: string) => void;
    let send!: (payload: unknown) => void;
    const started = new Promise<void>((ready) => {
      invokeMock.mockImplementation((command, args) => {
        if (command !== "ssh_connect") return Promise.resolve(undefined);
        const channel = (args as { onOutput: { onmessage: (payload: unknown) => void } }).onOutput;
        send = (payload) => channel.onmessage(payload);
        ready();
        return new Promise((resolve, reject) => {
          finish = resolve;
          fail = reject;
        });
      });
    });
    const done = useTerminalsStore.getState().connect(conn, { mode: "tab" });
    await started;
    const paneId = useTerminalsStore.getState().tabs[0].panes[0].sessionId;
    return { paneId, send, done, finish: (id: string) => finish(id), fail: (e: string) => fail(e) };
  }

  const prompts = () => useAuthPromptStore.getState().prompts;

  it("shows the server's prompt on the pane's placeholder, then becomes the session", async () => {
    const { paneId, send, done, finish } = await connecting();
    send(prompt("p1"));
    expect(prompts()[paneId]?.prompt_id).toBe("p1");

    send(closed("p1"));
    finish("real-session");
    await done;
    expect(prompts()).toEqual({});
    expect(useTerminalsStore.getState().tabs[0].panes[0].sessionId).toBe("real-session");
  });

  it("shows a reconnect's prompt under the session, once it has one", async () => {
    const { send, done, finish } = await connecting();
    finish("real-session");
    await done;

    send(prompt("again"));
    expect(prompts()["real-session"]?.prompt_id).toBe("again");

    send(closed("again"));
    expect(prompts()).toEqual({});
    expect(callsTo("ssh_auth_cancel")).toEqual([]);
  });

  it("closes a prompt whose close arrives after ssh_connect resolved", async () => {
    const { send, done, finish } = await connecting();
    send(prompt("p1"));
    finish("real-session");
    await done;

    send(closed("p1"));
    expect(prompts()).toEqual({});
  });

  it("cancels a reconnect's prompt with its pane, and refuses any that come later", async () => {
    const { send, done, finish } = await connecting();
    finish("real-session");
    await done;
    send(prompt("again"));

    await useTerminalsStore.getState().closePane("real-session");
    expect(prompts()).toEqual({});
    expect(callsTo("ssh_auth_cancel")).toEqual([["ssh_auth_cancel", { promptId: "again" }]]);

    send(prompt("late"));
    expect(prompts()).toEqual({});
    expect(callsTo("ssh_auth_cancel")).toContainEqual(["ssh_auth_cancel", { promptId: "late" }]);
  });

  it("closing the pane cancels the prompt and the attempt stays quiet", async () => {
    const { paneId, send, done, fail } = await connecting();
    send(prompt("p1"));

    await useTerminalsStore.getState().closePane(paneId);
    expect(prompts()).toEqual({});
    expect(callsTo("ssh_auth_cancel")).toEqual([["ssh_auth_cancel", { promptId: "p1" }]]);

    fail("Authentication cancelled");
    await done;
    expect(useTerminalsStore.getState().tabs).toEqual([]);
  });

  it("closing the tab cancels the prompt", async () => {
    const { send, done, fail } = await connecting();
    send(prompt("p1"));

    await useTerminalsStore.getState().closeTab(useTerminalsStore.getState().tabs[0].id);
    expect(callsTo("ssh_auth_cancel")).toEqual([["ssh_auth_cancel", { promptId: "p1" }]]);

    fail("Authentication cancelled");
    await done;
  });

  it("refuses a prompt that arrives after the pane closed", async () => {
    const { paneId, send, done, fail } = await connecting();
    await useTerminalsStore.getState().closePane(paneId);

    send(prompt("late"));
    expect(prompts()).toEqual({});
    expect(callsTo("ssh_auth_cancel")).toEqual([["ssh_auth_cancel", { promptId: "late" }]]);

    fail("Authentication cancelled");
    await done;
  });

  it("a failed answer ends in the failure pane once the prompt closes", async () => {
    const { paneId, send, done, fail } = await connecting();
    send(prompt("p1"));
    send(closed("p1"));
    fail("Keyboard-interactive auth failed: nope");
    await done;
    expect(prompts()).toEqual({});
    expect(useTerminalsStore.getState().tabs[0].panes[0]).toMatchObject({
      sessionId: paneId,
      error: "Keyboard-interactive auth failed: nope",
      retrying: false,
    });
  });
});
