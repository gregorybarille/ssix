import { describe, it, expect, vi } from "vitest";
import {
  OutputSink,
  attachOutput,
  deliverChannelMessage,
  disposeOutput,
  hasOutputSink,
  registerOutputSink,
  type OutputEvent,
  type OutputHandler,
} from "@/lib/terminalOutput";

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(async (_command: string, _args: unknown): Promise<unknown> => undefined),
}));
vi.mock("@/lib/tauri", () => ({ invoke }));

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (chunks: Uint8Array[]) =>
  chunks.map((c) => new TextDecoder().decode(c)).join("");

function collector() {
  const got: Uint8Array[] = [];
  const events: OutputEvent[] = [];
  return {
    got,
    events,
    handler: { write: (c: Uint8Array) => got.push(c), onEvent: (e: OutputEvent) => events.push(e) },
  };
}

describe("OutputSink", () => {
  it("buffers chunks until a handler attaches, then replays them in order", () => {
    const sink = new OutputSink();
    sink.push(bytes("hel"));
    sink.push(bytes("lo"));
    expect(sink.pendingBytes).toBe(5);

    const { got, handler } = collector();
    sink.attach(handler);
    expect(text(got)).toBe("hello");
    expect(sink.pendingBytes).toBe(0);

    sink.push(bytes("!"));
    expect(text(got)).toBe("hello!");
  });

  it("buffers again after detach so a remounting terminal loses nothing", () => {
    const sink = new OutputSink();
    const first = collector();
    sink.attach(first.handler);
    sink.detach();
    sink.push(bytes("later"));
    expect(first.got).toHaveLength(0);

    const second = collector();
    sink.attach(second.handler);
    expect(text(second.got)).toBe("later");
  });

  it("drops the oldest chunks once the unattached buffer exceeds its cap", () => {
    const sink = new OutputSink();
    const big = new Uint8Array(3 * 1024 * 1024);
    sink.push(big);
    sink.push(big); // 6 MB queued → oldest evicted
    expect(sink.pendingBytes).toBe(big.byteLength);
  });

  it("keeps control events in order with the bytes and never evicts them", () => {
    const sink = new OutputSink();
    sink.pushEvent({ kind: "error", message: "auth failed" });
    sink.push(new Uint8Array(3 * 1024 * 1024));
    sink.push(new Uint8Array(3 * 1024 * 1024)); // evicts bytes, not the event
    sink.pushEvent({ kind: "closed" });

    const { events, handler } = collector();
    sink.attach(handler);
    expect(events).toEqual([{ kind: "error", message: "auth failed" }, { kind: "closed" }]);

    sink.pushEvent({ kind: "closed" });
    expect(events).toHaveLength(3);
  });
});

describe("deliverChannelMessage", () => {
  it("routes ArrayBuffers and byte arrays to write, JSON control messages to onEvent", () => {
    const sink = new OutputSink();
    const { got, events, handler } = collector();
    sink.attach(handler);

    deliverChannelMessage(sink, bytes("ab").buffer);
    deliverChannelMessage(sink, [99]);
    deliverChannelMessage(sink, { kind: "error", message: "boom" });
    deliverChannelMessage(sink, { kind: "closed" });
    deliverChannelMessage(sink, { kind: "unknown" });
    deliverChannelMessage(sink, "garbage");

    expect(text(got)).toBe("abc");
    expect(events).toEqual([{ kind: "error", message: "boom" }, { kind: "closed" }]);
  });
});

describe("output registry", () => {
  it("attachOutput delivers a sink registered before the terminal mounted", () => {
    const sink = new OutputSink();
    sink.push(bytes("early"));
    registerOutputSink("s1", sink);

    const { got, handler } = collector();
    const detach = attachOutput("s1", handler);
    expect(text(got)).toBe("early");

    detach();
    sink.push(bytes("after-detach"));
    expect(text(got)).toBe("early");
    expect(hasOutputSink("s1")).toBe(true);

    disposeOutput("s1");
    expect(hasOutputSink("s1")).toBe(false);
  });

  it("attachOutput creates a sink when none was registered", () => {
    const { handler } = collector();
    attachOutput("fresh", handler);
    expect(hasOutputSink("fresh")).toBe(true);
    disposeOutput("fresh");
  });
});

describe("output flow control", () => {
  const BATCH = 256 * 1024;

  /** A terminal still parsing whatever it was handed, until told otherwise. */
  function slowTerminal() {
    const parsing: (() => void)[] = [];
    const handler: OutputHandler = {
      write: (_chunk, done) => {
        if (done) parsing.push(done);
      },
      onEvent: () => {},
    };
    return { handler, parsing, finish: () => parsing.splice(0).forEach((done) => done()) };
  }

  function ackedSink() {
    const acks: number[] = [];
    const sink = new OutputSink();
    sink.ackTo((n) => acks.push(n));
    return { sink, acks, acked: () => acks.reduce((sum, n) => sum + n, 0) };
  }

  it("acknowledges output only once the terminal has parsed it", () => {
    const { sink, acked } = ackedSink();
    const terminal = slowTerminal();
    sink.attach(terminal.handler);

    sink.push(new Uint8Array(BATCH));
    sink.push(new Uint8Array(BATCH));
    expect(acked()).toBe(0);

    terminal.finish();
    expect(acked()).toBe(2 * BATCH);
  });

  it("costs no IPC for a shell printing a little at a time", () => {
    const { sink, acks } = ackedSink();
    const terminal = slowTerminal();
    sink.attach(terminal.handler);

    for (let i = 0; i < 100; i++) sink.push(bytes("echo of a keystroke"));
    terminal.finish();
    expect(acks).toEqual([]);
  });

  it("never holds back so much that the backend's limit is reached by that alone", () => {
    const { sink, acked } = ackedSink();
    const terminal = slowTerminal();
    sink.attach(terminal.handler);

    for (let i = 0; i < 1000; i++) {
      sink.push(new Uint8Array(32 * 1024));
      terminal.finish();
    }
    expect(32 * 1024 * 1000 - acked()).toBeLessThan(BATCH);
  });

  it("does not let a terminal that never attaches stall its session", () => {
    const { sink, acked } = ackedSink();
    const size = 64 * 1024 * 1024;
    for (let sent = 0; sent < size; sent += 1024 * 1024) sink.push(new Uint8Array(1024 * 1024));

    expect(size - acked()).toBeLessThan(BATCH);
    expect(sink.pendingBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
  });

  it("replays what it buffered without counting it twice", () => {
    const { sink, acked } = ackedSink();
    sink.push(new Uint8Array(BATCH));
    expect(acked()).toBe(BATCH);

    const terminal = slowTerminal();
    sink.attach(terminal.handler);
    expect(terminal.parsing).toHaveLength(0);
    terminal.finish();
    expect(acked()).toBe(BATCH);
  });

  it("acknowledges what a terminal still had when it went away, once", () => {
    const { sink, acked } = ackedSink();
    const terminal = slowTerminal();
    sink.attach(terminal.handler);
    sink.push(new Uint8Array(BATCH));

    sink.detach();
    expect(acked()).toBe(BATCH);

    terminal.finish();
    expect(acked()).toBe(BATCH);
  });

  it("keeps what arrived before the session id was known until it is", () => {
    const sink = new OutputSink();
    sink.push(new Uint8Array(BATCH));

    const acks: number[] = [];
    sink.ackTo((n) => acks.push(n));
    expect(acks).toEqual([BATCH]);
  });

  it("acknowledges to the session it was registered under", () => {
    invoke.mockClear();
    const sink = new OutputSink();
    registerOutputSink("flow", sink);

    sink.push(new Uint8Array(BATCH));

    expect(invoke).toHaveBeenCalledWith("ssh_output_ack", { sessionId: "flow", bytes: BATCH });
    disposeOutput("flow");
  });
});
