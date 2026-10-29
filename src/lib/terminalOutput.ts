/**
 * Terminal output transport.
 *
 * Shell output arrives from the backend over a Tauri `Channel` as raw bytes
 * (one `ArrayBuffer` per message) instead of a JSON event, so nothing on the
 * hot path serialises byte arrays. The channel has to exist before
 * `ssh_connect` is invoked, which means bytes can start flowing before the
 * <Terminal> for that session has mounted. `OutputSink` buffers those early
 * chunks and replays them when the terminal attaches.
 */

/** Upper bound on bytes held for a terminal that has not attached yet. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export type OutputWriter = (chunk: Uint8Array) => void;

export class OutputSink {
  private writer: OutputWriter | null = null;
  private buffered: Uint8Array[] = [];
  private bufferedBytes = 0;

  push(chunk: Uint8Array): void {
    if (this.writer) {
      this.writer(chunk);
      return;
    }
    this.buffered.push(chunk);
    this.bufferedBytes += chunk.byteLength;
    while (this.bufferedBytes > MAX_BUFFERED_BYTES && this.buffered.length > 0) {
      this.bufferedBytes -= this.buffered.shift()!.byteLength;
    }
  }

  /** Start delivering to `writer`, replaying anything buffered so far. */
  attach(writer: OutputWriter): void {
    this.writer = writer;
    const pending = this.buffered;
    this.buffered = [];
    this.bufferedBytes = 0;
    for (const chunk of pending) writer(chunk);
  }

  detach(): void {
    this.writer = null;
  }

  get pendingBytes(): number {
    return this.bufferedBytes;
  }
}

const sinks = new Map<string, OutputSink>();

function toBytes(payload: unknown): Uint8Array {
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  if (payload instanceof Uint8Array) return payload;
  if (Array.isArray(payload)) return Uint8Array.from(payload as number[]);
  return new Uint8Array(0);
}

/**
 * Create the IPC channel handed to `ssh_connect` as `onOutput`, together
 * with the sink it feeds. Register the sink under the session id once the
 * backend has returned one.
 */
export async function createOutputChannel(): Promise<{ channel: unknown; sink: OutputSink }> {
  const { Channel } = await import("@tauri-apps/api/core");
  const sink = new OutputSink();
  const channel = new Channel<ArrayBuffer>((payload) => sink.push(toBytes(payload)));
  return { channel, sink };
}

export function registerOutputSink(sessionId: string, sink: OutputSink): void {
  sinks.set(sessionId, sink);
}

/**
 * Deliver a session's output to `writer`. Returns a function that stops
 * delivery without discarding the sink (the terminal may remount).
 */
export function attachOutput(sessionId: string, writer: OutputWriter): () => void {
  let sink = sinks.get(sessionId);
  if (!sink) {
    sink = new OutputSink();
    sinks.set(sessionId, sink);
  }
  sink.attach(writer);
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
