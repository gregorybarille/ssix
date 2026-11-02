import { describe, expect, it, vi } from "vitest";
import {
  paneUpdateForReconnectEvent,
  parseKeepaliveSeconds,
  parseReconnectAttempts,
  secondsUntilRetry,
} from "@/lib/reconnect";
import { OutputSink, deliverChannelMessage } from "@/lib/terminalOutput";

// The JSON `OutputEvent` in src-tauri/src/ssh.rs serializes to; its test
// `output_events_have_the_shape_the_frontend_reads` pins the same strings.
const RECONNECTING = JSON.parse(
  '{"kind":"reconnecting","attempt":2,"max_attempts":5,"delay_ms":4000,"message":"gone"}',
);
const RECONNECTED = JSON.parse('{"kind":"reconnected"}');
const STOPPED = JSON.parse('{"kind":"reconnect_stopped","message":"no"}');

describe("paneUpdateForReconnectEvent", () => {
  it("shows the attempt and when it starts", () => {
    expect(paneUpdateForReconnectEvent(RECONNECTING, 1000)).toEqual({
      reconnect: {
        phase: "waiting",
        attempt: 2,
        maxAttempts: 5,
        retryAt: 5000,
        message: "gone",
      },
      retrying: true,
      error: undefined,
    });
  });

  it("puts a stop in the pane's error, like a failed first connect", () => {
    expect(paneUpdateForReconnectEvent(STOPPED, 1000)).toEqual({
      reconnect: { phase: "stopped", message: "no" },
      retrying: false,
      error: "no",
    });
  });

  it("clears everything once the shell is back", () => {
    expect(paneUpdateForReconnectEvent(RECONNECTED, 1000)).toEqual({
      reconnect: undefined,
      retrying: false,
      error: undefined,
    });
  });
});

describe("secondsUntilRetry", () => {
  it("rounds up, and stays at zero once the attempt is running", () => {
    expect(secondsUntilRetry(5000, 1000)).toBe(4);
    expect(secondsUntilRetry(5000, 4001)).toBe(1);
    expect(secondsUntilRetry(5000, 5000)).toBe(0);
    expect(secondsUntilRetry(5000, 9000)).toBe(0);
  });
});

describe("number fields", () => {
  it("hold a keepalive to what the backend accepts", () => {
    expect(parseKeepaliveSeconds("30")).toBe(30);
    expect(parseKeepaliveSeconds("0")).toBe(0);
    expect(parseKeepaliveSeconds("99999")).toBe(3600);
    expect(parseKeepaliveSeconds("-5")).toBe(0);
    expect(parseKeepaliveSeconds("")).toBeUndefined();
  });

  it("hold the attempts to what the backend accepts", () => {
    expect(parseReconnectAttempts("7")).toBe(7);
    expect(parseReconnectAttempts("0")).toBe(1);
    expect(parseReconnectAttempts("500")).toBe(20);
    expect(parseReconnectAttempts("x")).toBeUndefined();
  });
});

describe("reconnect events on the output channel", () => {
  const handler = () => ({ write: vi.fn(), onEvent: vi.fn() });

  it("go to the pane's listener, never to the terminal's handler", () => {
    const sink = new OutputSink();
    const terminal = handler();
    const listener = vi.fn();
    sink.attach(terminal);
    sink.onReconnectEvent(listener);

    deliverChannelMessage(sink, RECONNECTING);
    deliverChannelMessage(sink, RECONNECTED);
    deliverChannelMessage(sink, STOPPED);

    expect(listener.mock.calls.map(([event]) => event)).toEqual([RECONNECTING, RECONNECTED, STOPPED]);
    expect(terminal.onEvent).not.toHaveBeenCalled();
    expect(terminal.write).not.toHaveBeenCalled();
  });

  it("wait for a listener when they arrive before ssh_connect returned", () => {
    const sink = new OutputSink();
    deliverChannelMessage(sink, RECONNECTING);
    deliverChannelMessage(sink, STOPPED);

    const listener = vi.fn();
    sink.onReconnectEvent(listener);
    expect(listener.mock.calls.map(([event]) => event)).toEqual([RECONNECTING, STOPPED]);

    deliverChannelMessage(sink, RECONNECTED);
    expect(listener).toHaveBeenLastCalledWith(RECONNECTED);
  });

  it("leave errors and the close notification with the terminal", () => {
    const sink = new OutputSink();
    const terminal = handler();
    const listener = vi.fn();
    sink.attach(terminal);
    sink.onReconnectEvent(listener);

    deliverChannelMessage(sink, { kind: "error", message: "lost" });
    deliverChannelMessage(sink, { kind: "closed" });

    expect(terminal.onEvent).toHaveBeenCalledTimes(2);
    expect(listener).not.toHaveBeenCalled();
  });

  it("ignore a message of a kind they do not know", () => {
    const sink = new OutputSink();
    const listener = vi.fn();
    sink.onReconnectEvent(listener);
    deliverChannelMessage(sink, { kind: "something_new" });
    expect(listener).not.toHaveBeenCalled();
  });
});
