import { errorMessage } from "@/lib/errors";
import { create } from "zustand";
import { forwardStatusEvent } from "@/lib/events";
import { invoke } from "@/lib/tauri";
import { log as appLog } from "@/lib/log";
import { isForwardConnection } from "@/lib/sshTerms";
import { createOutputChannel, type OutputEvent } from "@/lib/terminalOutput";
import type { Connection } from "@/types";
import type { ForwardSession } from "@/components/PortForwardsView";
import { useViewStore } from "./useViewStore";

/**
 * Audit-4 Phase 5d: the forward-session lifecycle (start, retry/cancel
 * race-handling, close) used to live in App.tsx alongside terminal
 * sessions. The two flows happen to share a generation pattern but
 * their session-id namespaces never overlap, so each gets its own
 * cancelled-set rather than a shared mutable ref.
 *
 * The cancelled set lives outside the reactive `set()` state because
 * it's only consulted from inside async actions; storing it in state
 * would force a re-render every time we toggle a flag.
 */
const cancelled: Set<string> = new Set();

/** Ends each running forward's status subscription; outside state like `cancelled`. */
const statusSubscriptions = new Map<string, () => void>();

/**
 * How long a restart waits for the last attempt to give back its port: a
 * connect and handshake it cannot interrupt (25 s at most), then its teardown
 * (under 4 s). Past that it starts anyway, and a port still taken reports its
 * bind error.
 */
export const RELEASE_WAIT_MS = 40_000;

/**
 * For each connection, settles once its latest attempt has let go of its port:
 * when `ssh_connect` failed, or at `closed`, which the backend only sends after
 * closing the port. A stopped forward's row is gone well before that.
 */
const portReleases = new Map<string, Promise<void>>();

function trackAttempt(connectionId: string) {
  const previous = portReleases.get(connectionId);
  let resolve = () => {};
  const current = new Promise<void>((done) => {
    resolve = () => done();
  });
  portReleases.set(connectionId, current);
  return {
    previousReleased: () =>
      new Promise<void>((done) => {
        if (!previous) {
          done();
          return;
        }
        const timer = setTimeout(done, RELEASE_WAIT_MS);
        void previous.then(() => {
          clearTimeout(timer);
          done();
        });
      }),
    released: () => {
      if (portReleases.get(connectionId) === current) portReleases.delete(connectionId);
      resolve();
    },
  };
}

/** What a forward emits on `forwardStatusEvent`. Mirrors `ForwardStatus` in `src-tauri/src/forwards.rs`. */
export interface ForwardStatus {
  state: "listening" | "client_connected" | "client_closed" | "client_error" | "error";
  listen_port: number;
  destination: string;
  message: string | null;
  active_clients: number;
}

/**
 * The status stream only feeds the client count, so a forward that cannot
 * subscribe still runs; its end arrives on the output channel regardless.
 */
async function subscribeToStatus(
  sessionId: string,
  onStatus: (status: ForwardStatus) => void,
): Promise<() => void> {
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen<ForwardStatus>(forwardStatusEvent(sessionId), (event) =>
      onStatus(event.payload),
    );
  } catch (err) {
    appLog.warn("forward", `No client updates for this forward: ${errorMessage(err)}`);
    return () => {};
  }
}

function endStatusSubscription(sessionId: string) {
  statusSubscriptions.get(sessionId)?.();
  statusSubscriptions.delete(sessionId);
}

/** Forwards running or starting; a row left by one that failed or was lost is neither. */
export function runningForwardCount(sessions: ForwardSession[]): number {
  return sessions.filter((s) => !s.error).length;
}

interface PortForwardsState {
  sessions: ForwardSession[];
  /**
   * Start a forward for a connection of any forward kind.
   * Routes the user to the port forwards view immediately and inserts a placeholder session
   * that flips to either "connected" (success), "error" (failure),
   * or simply disappears (user cancelled before the IPC resolved).
   * A forward that is already running or starting is only brought into view:
   * its port is taken, so a second one could only fail. One that was just
   * stopped first waits for its port to be given back, showing as connecting.
   */
  startForward: (conn: Connection) => Promise<void>;
  /**
   * Stop an active or in-flight forward session. If the session is
   * still being established when closed, the cancelled flag is
   * recorded so the eventual IPC resolution disconnects the orphan
   * session id rather than parading it as a live forward.
   */
  stopForward: (sessionId: string) => Promise<void>;
  /** Stop whatever is running or starting for a connection about to be deleted. */
  stopForwardsOf: (connectionId: string) => Promise<void>;
}

export const usePortForwardsStore = create<PortForwardsState>((set, get) => ({
  sessions: [],

  startForward: async (conn) => {
    // Audit-4 Phase 4b: forwards are only meaningful for forward kinds.
    // We assert here so the discriminated `connection` field on the
    // resulting ForwardSession is correctly narrowed.
    if (!isForwardConnection(conn)) {
      appLog.error(
        "forward",
        `Refusing to start a forward for non-forward connection ${conn.name}`,
      );
      return;
    }
    if (get().sessions.some((s) => s.connection.id === conn.id && !s.error)) {
      useViewStore.getState().setView("forwards");
      return;
    }
    const attempt = trackAttempt(conn.id);
    const placeholderId = `forward-${conn.id}-${Date.now()}`;
    set((state) => ({
      sessions: [
        // Only a forward that ended can be left here; this attempt replaces it.
        ...state.sessions.filter((s) => s.connection.id !== conn.id),
        {
          sessionId: placeholderId,
          connectionName: conn.name,
          connection: conn,
          retrying: true,
        },
      ],
    }));
    useViewStore.getState().setView("forwards");
    try {
      await attempt.previousReleased();
      if (cancelled.has(placeholderId)) {
        cancelled.delete(placeholderId);
        attempt.released();
        return;
      }
      // Forwards produce no terminal output, but this channel says when one
      // ends. The sink holds that until it is attached below, so a forward
      // that ends right away is still reported.
      const { channel, sink } = await createOutputChannel();
      const sessionId = await invoke<string>("ssh_connect", {
        connectionId: conn.id,
        onOutput: channel,
      });
      const unsubscribe = await subscribeToStatus(sessionId, (status) => {
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.sessionId === sessionId
              ? {
                  ...s,
                  activeClients: status.active_clients,
                  clientError:
                    status.state === "client_error"
                      ? status.message ?? undefined
                      : s.clientError,
                }
              : s,
          ),
        }));
      });
      if (cancelled.has(placeholderId)) {
        cancelled.delete(placeholderId);
        unsubscribe();
        sink.attach({
          write: () => {},
          onEvent: (event) => {
            if (event.kind === "closed") attempt.released();
          },
        });
        invoke("ssh_disconnect", { sessionId }).catch(() => {});
        return;
      }
      statusSubscriptions.set(sessionId, unsubscribe);
      set((state) => ({
        sessions: state.sessions.map((s) =>
          s.sessionId === placeholderId
            ? { sessionId, connectionName: conn.name, connection: conn }
            : s,
        ),
      }));
      appLog.info("forward", `Started ${conn.name}`);
      const onEnded = (event: OutputEvent) => {
        if (event.kind === "error") {
          set((state) => ({
            sessions: state.sessions.map((s) =>
              s.sessionId === sessionId
                ? { ...s, error: event.message, lost: true, retrying: false, activeClients: 0 }
                : s,
            ),
          }));
          appLog.error("forward", `${conn.name} ended: ${event.message}`);
          return;
        }
        // `closed` always comes last. With no error before it the forward was
        // stopped, and its row goes back to not connected.
        attempt.released();
        endStatusSubscription(sessionId);
        set((state) => ({
          sessions: state.sessions.filter((s) => s.sessionId !== sessionId || s.error),
        }));
      };
      sink.attach({ write: () => {}, onEvent: onEnded });
    } catch (err) {
      attempt.released();
      if (cancelled.has(placeholderId)) {
        cancelled.delete(placeholderId);
        return;
      }
      set((state) => ({
        sessions: state.sessions.map((s) =>
          s.sessionId === placeholderId
            ? { ...s, error: errorMessage(err), retrying: false }
            : s,
        ),
      }));
      appLog.error("forward", `Failed to start ${conn.name}: ${errorMessage(err)}`);
    }
  },

  stopForward: async (sessionId) => {
    const session = get().sessions.find((s) => s.sessionId === sessionId);
    if (session?.retrying && !session.error) {
      cancelled.add(sessionId);
    }
    endStatusSubscription(sessionId);
    try {
      await invoke("ssh_disconnect", { sessionId });
    } catch {
      // ignore
    }
    set((state) => ({
      sessions: state.sessions.filter((s) => s.sessionId !== sessionId),
    }));
  },

  stopForwardsOf: async (connectionId) => {
    const sessions = get().sessions.filter((s) => s.connection.id === connectionId);
    await Promise.all(sessions.map((s) => get().stopForward(s.sessionId)));
  },
}));
