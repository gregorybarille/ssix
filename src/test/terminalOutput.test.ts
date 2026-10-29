import { describe, it, expect } from "vitest";
import {
  OutputSink,
  attachOutput,
  deliverChannelMessage,
  disposeOutput,
  hasOutputSink,
  registerOutputSink,
  type OutputEvent,
} from "@/lib/terminalOutput";

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
