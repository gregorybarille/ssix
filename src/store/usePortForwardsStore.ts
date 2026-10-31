import { errorMessage } from "@/lib/errors";
import { create } from "zustand";
import { invoke } from "@/lib/tauri";
import { log as appLog } from "@/lib/log";
import { createOutputChannel } from "@/lib/terminalOutput";
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

interface PortForwardsState {
  sessions: ForwardSession[];
  /**
   * Start a local forward (`ssh -L`) for a port_forward connection.
   * Routes the user to the port forwards view immediately and inserts a placeholder session
   * that flips to either "connected" (success), "error" (failure),
   * or simply disappears (user cancelled before the IPC resolved).
   */
  startForward: (conn: Connection) => Promise<void>;
  /**
   * Stop an active or in-flight forward session. If the session is
   * still being established when closed, the cancelled flag is
   * recorded so the eventual IPC resolution disconnects the orphan
   * session id rather than parading it as a live forward.
   */
  stopForward: (sessionId: string) => Promise<void>;
}

export const usePortForwardsStore = create<PortForwardsState>((set, get) => ({
  sessions: [],

  startForward: async (conn) => {
    // Audit-4 Phase 4b: forwards are only meaningful for port_forward
    // connections. The picker filters by kind === "port_forward" but
    // we assert here so the discriminated `connection` field on the
    // resulting ForwardSession is correctly narrowed.
    if (conn.type !== "port_forward") {
      appLog.error(
        "forward",
        `Refusing to start a forward for non-port_forward connection ${conn.name}`,
      );
      return;
    }
    const placeholderId = `forward-${conn.id}-${Date.now()}`;
    set((state) => ({
      sessions: [
        ...state.sessions,
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
      // Forwards produce no terminal output, but ssh_connect takes the
      // channel unconditionally; nothing is ever sent on this one.
      const { channel } = await createOutputChannel();
      const sessionId = await invoke<string>("ssh_connect", {
        connectionId: conn.id,
        onOutput: channel,
      });
      if (cancelled.has(placeholderId)) {
        cancelled.delete(placeholderId);
        invoke("ssh_disconnect", { sessionId }).catch(() => {});
        return;
      }
      set((state) => ({
        sessions: state.sessions.map((s) =>
          s.sessionId === placeholderId
            ? { sessionId, connectionName: conn.name, connection: conn }
            : s,
        ),
      }));
      appLog.info("forward", `Started ${conn.name}`);
    } catch (err) {
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
    try {
      await invoke("ssh_disconnect", { sessionId });
    } catch {
      // ignore
    }
    set((state) => ({
      sessions: state.sessions.filter((s) => s.sessionId !== sessionId),
    }));
  },
}));
