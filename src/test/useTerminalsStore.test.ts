import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@/lib/tauri";
import { deliverChannelMessage, hasOutputSink, OutputSink } from "@/lib/terminalOutput";
import { useTerminalsStore } from "@/store/useTerminalsStore";
import type { Connection } from "@/types";

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn() }));

const sinks: OutputSink[] = [];
vi.mock("@/lib/terminalOutput", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/terminalOutput")>();
  return {
    ...actual,
    createOutputChannel: vi.fn(async () => {
      const sink = new actual.OutputSink();
      sinks.push(sink);
      return { channel: {}, sink };
    }),
  };
});

const invokeMock = vi.mocked(invoke);

const conn: Connection = {
  id: "c1",
  name: "web",
  host: "web.example",
  port: 22,
  type: "direct",
  credential_id: "cred-1",
  tags: [],
};

const pane = () => useTerminalsStore.getState().tabs[0]?.panes[0];
const calls = (command: string) => invokeMock.mock.calls.filter(([name]) => name === command);
const lastSink = () => sinks[sinks.length - 1];

/** Open a session whose `ssh_connect` returned `session-1`. */
async function connectLive() {
  await useTerminalsStore.getState().connect(conn);
  expect(pane()?.sessionId).toBe("session-1");
}

const reconnecting = (attempt = 1) => ({
  kind: "reconnecting",
  attempt,
  max_attempts: 5,
  delay_ms: 2000,
  message: "SSH read error: gone",
});

beforeEach(() => {
  sinks.length = 0;
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string) =>
    command === "ssh_connect" ? "session-1" : undefined,
  );
  useTerminalsStore.setState({ tabs: [], activeTabId: null });
});

describe("a shell that lost its connection", () => {
  it("stays in its pane under the same session while its worker reconnects", async () => {
    await connectLive();

    deliverChannelMessage(lastSink(), reconnecting());
    expect(pane()).toMatchObject({
      sessionId: "session-1",
      retrying: true,
      reconnect: { phase: "waiting", attempt: 1, maxAttempts: 5, message: "SSH read error: gone" },
    });
    expect(pane()?.error).toBeUndefined();

    deliverChannelMessage(lastSink(), { kind: "reconnected" });
    expect(pane()).toMatchObject({ sessionId: "session-1", retrying: false });
    expect(pane()?.reconnect).toBeUndefined();
    expect(calls("ssh_connect")).toHaveLength(1);
  });

  it("shows why it stopped trying", async () => {
    await connectLive();
    deliverChannelMessage(lastSink(), {
      kind: "reconnect_stopped",
      message: "Password auth failed: nope",
    });
    expect(pane()).toMatchObject({
      retrying: false,
      error: "Password auth failed: nope",
      reconnect: { phase: "stopped" },
    });
  });

  it("applies an event that came before ssh_connect returned", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command !== "ssh_connect") return undefined;
      deliverChannelMessage(lastSink(), reconnecting());
      return "session-1";
    });
    await connectLive();
    expect(pane()?.reconnect?.phase).toBe("waiting");
  });

  it("asks its worker to retry instead of opening another session", async () => {
    await connectLive();
    deliverChannelMessage(lastSink(), { kind: "reconnect_stopped", message: "refused" });

    await useTerminalsStore.getState().connect(conn, { replaceSessionId: "session-1" });

    expect(invokeMock).toHaveBeenCalledWith("ssh_reconnect", { sessionId: "session-1" });
    expect(calls("ssh_connect")).toHaveLength(1);
    expect(pane()).toMatchObject({ sessionId: "session-1", retrying: true });
  });

  it("starts over when its worker is gone", async () => {
    await connectLive();
    deliverChannelMessage(lastSink(), { kind: "reconnect_stopped", message: "refused" });
    invokeMock.mockImplementationOnce(async () => {
      throw "Session not found";
    });

    await useTerminalsStore.getState().connect(conn, { replaceSessionId: "session-1" });
    expect(pane()).toMatchObject({ retrying: false, error: "Session not found" });
    expect(pane()?.reconnect).toBeUndefined();

    invokeMock.mockImplementation(async (command: string) =>
      command === "ssh_connect" ? "session-2" : undefined,
    );
    await useTerminalsStore.getState().connect(conn, { replaceSessionId: "session-1" });
    expect(calls("ssh_connect")).toHaveLength(2);
    expect(pane()?.sessionId).toBe("session-2");
    expect(hasOutputSink("session-1")).toBe(false);
    expect(hasOutputSink("session-2")).toBe(true);
  });

  it("cancels through the worker, which then reports the stop", async () => {
    await connectLive();
    deliverChannelMessage(lastSink(), reconnecting());

    await useTerminalsStore.getState().cancelReconnect("session-1");

    expect(invokeMock).toHaveBeenCalledWith("ssh_cancel_reconnect", { sessionId: "session-1" });
    expect(pane()?.reconnect?.phase).toBe("waiting");
    deliverChannelMessage(lastSink(), { kind: "reconnect_stopped", message: "gone" });
    expect(pane()?.reconnect?.phase).toBe("stopped");
  });

  it("is disconnected when its pane closes while reconnecting", async () => {
    await connectLive();
    deliverChannelMessage(lastSink(), reconnecting());

    await useTerminalsStore.getState().closePane("session-1");

    expect(useTerminalsStore.getState().tabs).toHaveLength(0);
    expect(invokeMock).toHaveBeenCalledWith("ssh_disconnect", { sessionId: "session-1" });
  });

  it("is disconnected when its tab closes while reconnecting", async () => {
    await connectLive();
    deliverChannelMessage(lastSink(), reconnecting());
    const tabId = useTerminalsStore.getState().tabs[0].id;

    await useTerminalsStore.getState().closeTab(tabId);

    expect(useTerminalsStore.getState().tabs).toHaveLength(0);
    expect(invokeMock).toHaveBeenCalledWith("ssh_disconnect", { sessionId: "session-1" });
  });
});

describe("a first connection", () => {
  it("keeps failing in place: no reconnect state, no automatic retry", async () => {
    invokeMock.mockImplementationOnce(async () => {
      throw "TCP connect to web.example:22 failed: refused";
    });
    await useTerminalsStore.getState().connect(conn);
    expect(pane()?.error).toContain("refused");
    expect(pane()?.reconnect).toBeUndefined();
    expect(calls("ssh_reconnect")).toHaveLength(0);

    await useTerminalsStore.getState().connect(conn, { replaceSessionId: pane()!.sessionId });
    expect(pane()?.sessionId).toBe("session-1");
    expect(pane()?.error).toBeUndefined();
  });

  it("drops a session that arrives after its placeholder pane closed", async () => {
    let finish: (id: string) => void = () => {};
    invokeMock.mockImplementationOnce(
      () => new Promise<string>((resolve) => { finish = resolve; }) as never,
    );
    const connecting = useTerminalsStore.getState().connect(conn);
    await vi.waitFor(() => expect(calls("ssh_connect")).toHaveLength(1));

    await useTerminalsStore.getState().closePane(pane()!.sessionId);
    finish("late-session");
    await connecting;

    expect(invokeMock).toHaveBeenCalledWith("ssh_disconnect", { sessionId: "late-session" });
    expect(useTerminalsStore.getState().tabs).toHaveLength(0);
  });
});
