import { beforeEach, describe, expect, it, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
import { forwardStatusEvent } from "@/lib/events";
import { invoke } from "@/lib/tauri";
import {
  RELEASE_WAIT_MS,
  usePortForwardsStore,
  type ForwardStatus,
} from "@/store/usePortForwardsStore";
import { useViewStore } from "@/store/useViewStore";
import type { ForwardConnection } from "@/types";

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn() }));

const baseConnection = {
  id: "fwd",
  name: "socks",
  host: "bastion",
  port: 22,
  type: "dynamic_forward",
  gateway_host: "bastion",
  gateway_port: 22,
  gateway_credential_id: "cred",
  local_port: 1080,
} as ForwardConnection;

type StatusHandler = (event: { payload: ForwardStatus }) => void;
type FakeChannel = { onmessage: (payload: unknown) => void };
type ConnectBehaviour = (channel: FakeChannel) => Promise<string>;

const invokeMock = vi.mocked(invoke) as unknown as ReturnType<typeof vi.fn>;
const listenMock = vi.mocked(listen) as unknown as ReturnType<typeof vi.fn>;

// A new id per test: a forward one test left running would hold up the next
// test's start, which waits for that connection's port to be given back.
let nextConnection = 0;
let conn: ForwardConnection;
let channel: FakeChannel;
let handlers: Map<string, StatusHandler>;
let unlisten: ReturnType<typeof vi.fn>;
let onConnect: ConnectBehaviour;

const store = () => usePortForwardsStore.getState();
const connectCalls = () => invokeMock.mock.calls.filter(([cmd]) => cmd === "ssh_connect");

function emitStatus(sessionId: string, status: Partial<ForwardStatus>) {
  handlers.get(forwardStatusEvent(sessionId))?.({
    payload: {
      state: "listening",
      listen_port: 1080,
      destination: "SOCKS clients",
      message: null,
      active_clients: 0,
      ...status,
    },
  });
}

beforeEach(() => {
  conn = { ...baseConnection, id: `fwd-${++nextConnection}` };
  usePortForwardsStore.setState({ sessions: [] });
  useViewStore.setState({ view: "connections", leaveGuard: null });
  handlers = new Map();
  unlisten = vi.fn();
  onConnect = async () => "session-1";
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string, args?: { onOutput?: FakeChannel }) => {
    if (cmd !== "ssh_connect") return undefined;
    channel = args?.onOutput as FakeChannel;
    return onConnect(channel);
  });
  listenMock.mockReset();
  listenMock.mockImplementation(async (name: string, handler: StatusHandler) => {
    handlers.set(name, handler);
    return unlisten;
  });
});

describe("usePortForwardsStore", () => {
  it("shows a started forward as running and subscribes to its session's status", async () => {
    await store().startForward(conn);

    expect(useViewStore.getState().view).toBe("forwards");
    expect(store().sessions).toHaveLength(1);
    expect(store().sessions[0]).toMatchObject({ sessionId: "session-1", connectionName: "socks" });
    expect(store().sessions[0].retrying).toBeUndefined();
    expect(listenMock).toHaveBeenCalledWith(
      forwardStatusEvent("session-1"),
      expect.any(Function),
    );
  });

  it("keeps the client count from status events and remembers the last client error", async () => {
    await store().startForward(conn);

    emitStatus("session-1", { state: "client_connected", active_clients: 2 });
    expect(store().sessions[0].activeClients).toBe(2);

    emitStatus("session-1", { state: "client_error", message: "to db:5432: refused", active_clients: 1 });
    expect(store().sessions[0]).toMatchObject({
      activeClients: 1,
      clientError: "to db:5432: refused",
    });

    emitStatus("session-1", { state: "client_closed", active_clients: 0 });
    expect(store().sessions[0]).toMatchObject({
      activeClients: 0,
      clientError: "to db:5432: refused",
    });
    expect(store().sessions[0].error).toBeUndefined();
  });

  it("marks a running forward lost when it ends with an error, and stops listening", async () => {
    await store().startForward(conn);
    emitStatus("session-1", { state: "client_connected", active_clients: 1 });

    channel.onmessage({ kind: "error", message: "Lost the connection to the SSH server" });
    channel.onmessage({ kind: "closed" });

    expect(store().sessions).toHaveLength(1);
    expect(store().sessions[0]).toMatchObject({
      error: "Lost the connection to the SSH server",
      lost: true,
      retrying: false,
      activeClients: 0,
    });
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("returns the row to not connected when a forward closes without an error", async () => {
    await store().startForward(conn);

    channel.onmessage({ kind: "closed" });

    expect(store().sessions).toEqual([]);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("still reports a forward that ended before the store started listening", async () => {
    onConnect = async (ch) => {
      ch.onmessage({ kind: "error", message: "gone at once" });
      ch.onmessage({ kind: "closed" });
      return "session-1";
    };

    await store().startForward(conn);

    expect(store().sessions[0]).toMatchObject({ error: "gone at once", lost: true });
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("does not start a forward that is already running", async () => {
    await store().startForward(conn);
    useViewStore.setState({ view: "connections" });

    await store().startForward(conn);

    expect(connectCalls()).toHaveLength(1);
    expect(store().sessions).toHaveLength(1);
    expect(useViewStore.getState().view).toBe("forwards");
  });

  it("does not start a forward that is still starting", async () => {
    let finish: (id: string) => void = () => {};
    onConnect = () => new Promise((resolve) => (finish = resolve));

    const first = store().startForward(conn);
    await vi.waitFor(() => expect(connectCalls()).toHaveLength(1));
    await store().startForward(conn);
    expect(connectCalls()).toHaveLength(1);
    expect(store().sessions).toHaveLength(1);

    finish("session-1");
    await first;
    expect(store().sessions[0].sessionId).toBe("session-1");
  });

  it("replaces a lost forward's row when it is started again", async () => {
    await store().startForward(conn);
    channel.onmessage({ kind: "error", message: "lost" });
    channel.onmessage({ kind: "closed" });

    onConnect = async () => "session-2";
    await store().startForward(conn);

    expect(store().sessions).toHaveLength(1);
    expect(store().sessions[0].sessionId).toBe("session-2");
    expect(store().sessions[0].error).toBeUndefined();
    expect(store().sessions[0].lost).toBeUndefined();
  });

  it("stops listening and disconnects when stopped, and ignores the close that follows", async () => {
    await store().startForward(conn);

    await store().stopForward("session-1");

    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("ssh_disconnect", { sessionId: "session-1" });
    expect(store().sessions).toEqual([]);

    channel.onmessage({ kind: "closed" });
    expect(store().sessions).toEqual([]);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("disconnects and leaves no subscription when stopped while starting", async () => {
    let finish: (id: string) => void = () => {};
    onConnect = () => new Promise((resolve) => (finish = resolve));

    const started = store().startForward(conn);
    await vi.waitFor(() => expect(connectCalls()).toHaveLength(1));
    await store().stopForward(store().sessions[0].sessionId);
    finish("session-late");
    await started;

    expect(store().sessions).toEqual([]);
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("ssh_disconnect", { sessionId: "session-late" });
  });

  it("shows a refused start as an error, not a lost connection, and does not subscribe", async () => {
    onConnect = async () => {
      throw new Error("SSH server refused to listen on port 8080");
    };

    await store().startForward(conn);

    expect(store().sessions[0]).toMatchObject({
      error: "SSH server refused to listen on port 8080",
      retrying: false,
    });
    expect(store().sessions[0].lost).toBeUndefined();
    expect(listenMock).not.toHaveBeenCalled();
  });

  it("keeps a forward running when its status cannot be subscribed to, and still sees it end", async () => {
    listenMock.mockRejectedValue(new Error("event API unavailable"));

    await store().startForward(conn);
    expect(store().sessions[0].sessionId).toBe("session-1");
    expect(store().sessions[0].error).toBeUndefined();

    channel.onmessage({ kind: "error", message: "lost" });
    expect(store().sessions[0]).toMatchObject({ error: "lost", lost: true });
  });
});

describe("restarting a forward", () => {
  /** Long enough for a start that was going to connect to have done so. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it("waits for a stopped forward to give back its port", async () => {
    await store().startForward(conn);
    const first = channel;
    await store().stopForward("session-1");
    onConnect = async () => "session-2";

    const restart = store().startForward(conn);
    await settle();
    expect(connectCalls()).toHaveLength(1);
    expect(store().sessions[0].retrying).toBe(true);

    first.onmessage({ kind: "closed" });
    await restart;
    expect(connectCalls()).toHaveLength(2);
    expect(store().sessions[0].sessionId).toBe("session-2");
    expect(store().sessions[0].error).toBeUndefined();
  });

  it("waits for an attempt stopped while connecting, until the backend closes it", async () => {
    let finish: (id: string) => void = () => {};
    onConnect = () => new Promise((resolve) => (finish = resolve));
    const started = store().startForward(conn);
    await vi.waitFor(() => expect(connectCalls()).toHaveLength(1));
    const first = channel;
    await store().stopForward(store().sessions[0].sessionId);
    onConnect = async () => "session-2";

    const restart = store().startForward(conn);
    await settle();
    expect(connectCalls()).toHaveLength(1);

    finish("session-late");
    await started;
    expect(invokeMock).toHaveBeenCalledWith("ssh_disconnect", { sessionId: "session-late" });
    await settle();
    expect(connectCalls()).toHaveLength(1);

    first.onmessage({ kind: "closed" });
    await restart;
    expect(connectCalls()).toHaveLength(2);
    expect(store().sessions[0].sessionId).toBe("session-2");
  });

  it("does not wait after a start that failed, which holds no port", async () => {
    onConnect = async () => {
      throw new Error("refused");
    };
    await store().startForward(conn);
    onConnect = async () => "session-2";

    await store().startForward(conn);

    expect(connectCalls()).toHaveLength(2);
    expect(store().sessions[0].sessionId).toBe("session-2");
  });

  it("does not connect at all when stopped while still waiting", async () => {
    await store().startForward(conn);
    const first = channel;
    await store().stopForward("session-1");

    const restart = store().startForward(conn);
    await settle();
    await store().stopForward(store().sessions[0].sessionId);
    first.onmessage({ kind: "closed" });
    await restart;

    expect(connectCalls()).toHaveLength(1);
    expect(store().sessions).toEqual([]);
  });

  it("starts anyway when the port is never reported free", async () => {
    await store().startForward(conn);
    await store().stopForward("session-1");
    onConnect = async () => "session-2";
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const restart = store().startForward(conn);
      await vi.advanceTimersByTimeAsync(RELEASE_WAIT_MS - 1);
      expect(connectCalls()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await restart;
      expect(connectCalls()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
