import { describe, it, expect } from "vitest";
import {
  OutputSink,
  attachOutput,
  disposeOutput,
  hasOutputSink,
  registerOutputSink,
} from "@/lib/terminalOutput";

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (chunks: Uint8Array[]) =>
  chunks.map((c) => new TextDecoder().decode(c)).join("");

describe("OutputSink", () => {
  it("buffers chunks until a writer attaches, then replays them in order", () => {
    const sink = new OutputSink();
    sink.push(bytes("hel"));
    sink.push(bytes("lo"));
    expect(sink.pendingBytes).toBe(5);

    const got: Uint8Array[] = [];
    sink.attach((c) => got.push(c));
    expect(text(got)).toBe("hello");
    expect(sink.pendingBytes).toBe(0);

    sink.push(bytes("!"));
    expect(text(got)).toBe("hello!");
  });

  it("buffers again after detach so a remounting terminal loses nothing", () => {
    const sink = new OutputSink();
    const first: Uint8Array[] = [];
    sink.attach((c) => first.push(c));
    sink.detach();
    sink.push(bytes("later"));
    expect(first).toHaveLength(0);

    const second: Uint8Array[] = [];
    sink.attach((c) => second.push(c));
    expect(text(second)).toBe("later");
  });

  it("drops the oldest chunks once the unattached buffer exceeds its cap", () => {
    const sink = new OutputSink();
    const big = new Uint8Array(3 * 1024 * 1024);
    sink.push(big);
    sink.push(big); // 6 MB queued → oldest evicted
    expect(sink.pendingBytes).toBe(big.byteLength);
  });
});

describe("output registry", () => {
  it("attachOutput delivers a sink registered before the terminal mounted", () => {
    const sink = new OutputSink();
    sink.push(bytes("early"));
    registerOutputSink("s1", sink);

    const got: Uint8Array[] = [];
    const detach = attachOutput("s1", (c) => got.push(c));
    expect(text(got)).toBe("early");

    detach();
    sink.push(bytes("after-detach"));
    expect(text(got)).toBe("early");
    expect(hasOutputSink("s1")).toBe(true);

    disposeOutput("s1");
    expect(hasOutputSink("s1")).toBe(false);
  });

  it("attachOutput creates a sink when none was registered", () => {
    const got: Uint8Array[] = [];
    attachOutput("fresh", (c) => got.push(c));
    expect(hasOutputSink("fresh")).toBe(true);
    disposeOutput("fresh");
  });
});
