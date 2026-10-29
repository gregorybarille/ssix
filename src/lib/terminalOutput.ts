/**
 * Terminal output transport.
 *
 * Shell output arrives from the backend over a Tauri `Channel` as raw bytes
 * (one `ArrayBuffer` per message) instead of a JSON event, so nothing on the
 * hot path serialises byte arrays. The channel has to exist before
 * `ssh_connect` is invoked, which means bytes can start flowing before the
 * <Terminal> for that session has mounted. `OutputSink` buffers those early
 * chunks and replays them when the terminal attaches.
 *
 * Session control notifications (`error`, `closed`) travel on the same
 * channel as small JSON messages (`OutputEvent`, mirrored by `OutputEvent`
 * in `src-tauri/src/ssh.rs`). Sharing the channel keeps them ordered with
 * the bytes and buffered alongside them, so a shell that exits before the
 * terminal mounts is still reported instead of lost.
 */

/** Upper bound on bytes held for a terminal that has not attached yet. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export type OutputEvent = { kind: "error"; message: string } | { kind: "closed" };

export interface OutputHandler {
  write: (chunk: Uint8Array) => void;
  onEvent: (event: OutputEvent) => void;
}

type Item = Uint8Array | OutputEvent;

// `ArrayBuffer.isView` works across realms (jsdom, Node's TextEncoder),
// where `instanceof Uint8Array` does not.
const isBytes = (item: Item): item is Uint8Array => ArrayBuffer.isView(item);

const isArrayBuffer = (payload: unknown): payload is ArrayBuffer =>
  payload instanceof ArrayBuffer ||
  Object.prototype.toString.call(payload) === "[object ArrayBuffer]";

export class OutputSink {
  private handler: OutputHandler | null = null;
  private buffered: Item[] = [];
  private bufferedBytes = 0;

  push(chunk: Uint8Array): void {
    if (this.handler) {
      this.handler.write(chunk);
      return;
    }
    this.buffered.push(chunk);
    this.bufferedBytes += chunk.byteLength;
    // Evict the oldest bytes only; control events are tiny and must survive.
    while (this.bufferedBytes > MAX_BUFFERED_BYTES) {
      const oldest = this.buffered.findIndex(isBytes);
      if (oldest < 0) break;
      const [removed] = this.buffered.splice(oldest, 1);
      this.bufferedBytes -= (removed as Uint8Array).byteLength;
    }
  }

  pushEvent(event: OutputEvent): void {
    if (this.handler) {
      this.handler.onEvent(event);
      return;
    }
    this.buffered.push(event);
  }

  /** Start delivering to `handler`, replaying anything buffered so far. */
  attach(handler: OutputHandler): void {
    this.handler = handler;
    const pending = this.buffered;
    this.buffered = [];
    this.bufferedBytes = 0;
    for (const item of pending) {
      if (isBytes(item)) handler.write(item);
      else handler.onEvent(item);
    }
  }

  detach(): void {
    this.handler = null;
  }

  get pendingBytes(): number {
    return this.bufferedBytes;
  }
}

const sinks = new Map<string, OutputSink>();

function toBytes(payload: unknown): Uint8Array | null {
  if (isArrayBuffer(payload)) return new Uint8Array(payload);
  if (ArrayBuffer.isView(payload)) {
    return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  if (Array.isArray(payload)) return Uint8Array.from(payload as number[]);
  return null;
}

function toEvent(payload: unknown): OutputEvent | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as { kind?: unknown; message?: unknown };
  if (p.kind === "closed") return { kind: "closed" };
  if (p.kind === "error") return { kind: "error", message: String(p.message ?? "") };
  return null;
}

/** Route one channel message (bytes or control event) into `sink`. */
export function deliverChannelMessage(sink: OutputSink, payload: unknown): void {
  const bytes = toBytes(payload);
  if (bytes) {
    sink.push(bytes);
    return;
  }
  const event = toEvent(payload);
  if (event) sink.pushEvent(event);
}

/**
 * Create the IPC channel handed to `ssh_connect` as `onOutput`, together
 * with the sink it feeds. Register the sink under the session id once the
 * backend has returned one.
 */
export async function createOutputChannel(): Promise<{ channel: unknown; sink: OutputSink }> {
  const { Channel } = await import("@tauri-apps/api/core");
  const sink = new OutputSink();
  const channel = new Channel<unknown>((payload) => deliverChannelMessage(sink, payload));
  return { channel, sink };
}

export function registerOutputSink(sessionId: string, sink: OutputSink): void {
  sinks.set(sessionId, sink);
}

/**
 * Deliver a session's output and control events to `handler`. Returns a
 * function that stops delivery without discarding the sink (the terminal
 * may remount).
 */
export function attachOutput(sessionId: string, handler: OutputHandler): () => void {
  let sink = sinks.get(sessionId);
  if (!sink) {
    sink = new OutputSink();
    sinks.set(sessionId, sink);
  }
  sink.attach(handler);
  const attached = sink;
  return () => {
    if (sinks.get(sessionId) === attached) attached.detach();
  };
}

/** Forget a session's sink once the session is closed. */
export function disposeOutput(sessionId: string): void {
  sinks.delete(sessionId);
}

/** Test-only visibility into the registry. */
export function hasOutputSink(sessionId: string): boolean {
  return sinks.has(sessionId);
}
