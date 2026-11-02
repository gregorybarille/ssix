import { errorMessage } from "@/lib/errors";
import { create } from "zustand";
import { invoke } from "@/lib/tauri";
import { log as appLog } from "@/lib/log";
import { paneUpdateForReconnectEvent } from "@/lib/reconnect";
import { isForwardConnection } from "@/lib/sshTerms";
import { createOutputChannel, disposeOutput, registerOutputSink } from "@/lib/terminalOutput";
import type { Connection, OpenMode } from "@/types";
import type {
  TerminalTab,
  TerminalSession,
} from "@/components/TerminalTabs";
import { useAuthPromptStore } from "./useAuthPromptStore";
import { useViewStore } from "./useViewStore";
import { usePortForwardsStore } from "./usePortForwardsStore";
import { useSettingsStore } from "./useSettingsStore";

/**
 * Audit-4 Phase 5d: terminal pane/tab lifecycle extracted from
 * App.tsx. The store owns:
 *
 *  - the list of `tabs` (each with up to 2 panes — the split flow)
 *  - the `activeTabId`
 *  - a non-reactive `cancelled` set used to handle the race where
 *    the user closes a placeholder pane *before* the underlying
 *    `ssh_connect` IPC resolves (so the resulting session id is
 *    disconnected immediately rather than left dangling)
 *
 * `connect()` routes every forward kind to the port forwards store
 * and shell connections into a new tab (or split into the active
 * tab, depending on `mode`). When the last tab closes, view falls
 * back to "connections" via the view store.
 *
 * A live shell whose connection drops stays in its pane: its worker reconnects
 * under the same session id and reports over the output channel, and the pane
 * follows along through `reconnect` (see `src/lib/reconnect.ts`).
 */
const cancelled: Set<string> = new Set();

interface TerminalsState {
  tabs: TerminalTab[];
  activeTabId: string | null;

  setActiveTabId: (id: string | null) => void;

  /**
   * Open a connection. A forward of any kind hands off to the port forwards
   * store. Otherwise opens a shell session in a new tab or split.
   * `replaceSessionId` re-opens an existing failed pane in place,
   * preserving its slot/order; a pane whose shell dropped asks its worker to
   * try again, which keeps the session and its scrollback.
   */
  connect: (
    conn: Connection,
    options?: { mode?: OpenMode; replaceSessionId?: string },
  ) => Promise<void>;

  /** Stop a dropped shell's automatic reconnect. Its pane stays, ready to retry. */
  cancelReconnect: (sessionId: string) => Promise<void>;

  /** Close one pane. If it's the only pane in its tab, the tab closes too. */
  closePane: (sessionId: string) => Promise<void>;

  /** Close every pane in a tab. */
  closeTab: (tabId: string) => Promise<void>;

  /** Switch to terminals view and select the Nth (0-indexed) tab, if it exists. */
  selectTabByIndex: (index: number) => void;
}

export const useTerminalsStore = create<TerminalsState>((set, get) => {
  const addSessionToNewTab = (session: TerminalSession): string => {
    const tabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    set((state) => ({
      tabs: [...state.tabs, { id: tabId, mode: "single", panes: [session] }],
      activeTabId: tabId,
    }));
    return tabId;
  };

  const addSessionToActiveTab = (
    session: TerminalSession,
    splitMode: "horizontal" | "vertical",
  ) => {
    const { tabs, activeTabId } = get();
    const activeTab = tabs.find((t) => t.id === activeTabId);
    // Fall back to a fresh tab if there is no active tab or the
    // active tab is already showing two panes (the maximum split).
    if (!activeTabId || !activeTab || activeTab.panes.length >= 2) {
      addSessionToNewTab(session);
      return;
    }
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === activeTabId
          ? { ...t, mode: splitMode, panes: [...t.panes, session] }
          : t,
      ),
    }));
  };

  const findPane = (sessionId: string): TerminalSession | undefined =>
    get()
      .tabs.flatMap((t) => t.panes)
      .find((p) => p.sessionId === sessionId);

  /**
   * A pane still waiting for `ssh_connect` has no session to disconnect yet:
   * remember to drop it when it arrives. A shell that is reconnecting has its
   * session already, and `ssh_disconnect` reaches it.
   */
  const markIfStillConnecting = (pane: TerminalSession) => {
    if (pane.retrying && !pane.error && !pane.reconnect) {
      cancelled.add(pane.sessionId);
    }
  };

  const updateSessionEverywhere = (
    placeholderId: string,
    next: Partial<TerminalSession> & { sessionId?: string },
  ) => {
    set((state) => ({
      tabs: state.tabs.map((t) => ({
        ...t,
        panes: t.panes.map((p) =>
          p.sessionId === placeholderId ? { ...p, ...next } : p,
        ),
      })),
    }));
  };

  return {
    tabs: [],
    activeTabId: null,

    setActiveTabId: (id) => set({ activeTabId: id }),

    connect: async (conn, options) => {
      if (isForwardConnection(conn)) {
        await usePortForwardsStore.getState().startForward(conn);
        return;
      }

      const settings = useSettingsStore.getState().settings;
      const mode: OpenMode = options?.mode ?? settings.default_open_mode ?? "tab";
      const replaceSessionId = options?.replaceSessionId;
      const placeholderId =
        replaceSessionId ?? `failed-${conn.id}-${Date.now()}`;
      const placeholder: TerminalSession = {
        sessionId: placeholderId,
        connectionName: conn.name,
        connection: conn,
        retrying: true,
      };

      if (replaceSessionId && findPane(replaceSessionId)?.reconnect) {
        updateSessionEverywhere(replaceSessionId, { retrying: true });
        try {
          await invoke("ssh_reconnect", { sessionId: replaceSessionId });
        } catch (err) {
          // Its worker is gone, so the next retry has to start from scratch.
          updateSessionEverywhere(replaceSessionId, {
            reconnect: undefined,
            retrying: false,
            error: errorMessage(err),
          });
          appLog.error("ssh", `Reconnect failed for ${conn.name}: ${errorMessage(err)}`);
        }
        return;
      }

      const setView = useViewStore.getState().setView;
      if (replaceSessionId) {
        updateSessionEverywhere(placeholderId, {
          retrying: true,
          error: undefined,
        });
      } else if (mode === "split_right") {
        addSessionToActiveTab(placeholder, "horizontal");
        setView("terminals");
      } else if (mode === "split_down") {
        addSessionToActiveTab(placeholder, "vertical");
        setView("terminals");
      } else {
        addSessionToNewTab(placeholder);
        setView("terminals");
      }

      try {
        // The output channel must exist before the backend starts the
        // session; its sink buffers bytes until the <Terminal> mounts.
        const { channel, sink } = await createOutputChannel((event) => {
          const prompts = useAuthPromptStore.getState();
          if (cancelled.has(placeholderId)) prompts.refuse(event);
          else prompts.receive(placeholderId, event);
        });
        const sessionId = await invoke<string>("ssh_connect", {
          connectionId: conn.id,
          onOutput: channel,
        });
        if (cancelled.has(placeholderId)) {
          cancelled.delete(placeholderId);
          invoke("ssh_disconnect", { sessionId }).catch(() => {});
          return;
        }
        registerOutputSink(sessionId, sink);
        // Replace placeholder identity in-place so the pane keeps its slot.
        set((state) => ({
          tabs: state.tabs.map((t) => ({
            ...t,
            panes: t.panes.map((p) =>
              p.sessionId === placeholderId
                ? { sessionId, connectionName: conn.name, connection: conn }
                : p,
            ),
          })),
        }));
        sink.onReconnectEvent((event) =>
          updateSessionEverywhere(sessionId, paneUpdateForReconnectEvent(event, Date.now())),
        );
        appLog.info("ssh", `Connected to ${conn.name}`);
      } catch (err) {
        if (cancelled.has(placeholderId)) {
          cancelled.delete(placeholderId);
          return;
        }
        updateSessionEverywhere(placeholderId, {
          error: errorMessage(err),
          retrying: false,
        });
        appLog.error("ssh", `Connect failed for ${conn.name}: ${errorMessage(err)}`);
      }
    },

    cancelReconnect: async (sessionId) => {
      try {
        // The worker answers with `reconnect_stopped`, which updates the pane.
        await invoke("ssh_cancel_reconnect", { sessionId });
      } catch (err) {
        appLog.error("ssh", `Could not cancel the reconnect: ${errorMessage(err)}`);
      }
    },

    closePane: async (sessionId) => {
      const { tabs, activeTabId } = get();
      useAuthPromptStore.getState().cancel(sessionId);
      let tabClosed: string | null = null;
      for (const tab of tabs) {
        const pane = tab.panes.find((p) => p.sessionId === sessionId);
        if (pane) {
          markIfStillConnecting(pane);
          if (tab.panes.length === 1) {
            tabClosed = tab.id;
          }
          break;
        }
      }
      // Remove the pane immediately; the backend teardown runs after.
      set((state) => {
        const next = state.tabs
          .map((t) => {
            const remainingPanes = t.panes.filter(
              (p) => p.sessionId !== sessionId,
            );
            if (remainingPanes.length === 0) return null;
            const newMode = remainingPanes.length === 1 ? "single" : t.mode;
            return { ...t, mode: newMode, panes: remainingPanes } as TerminalTab;
          })
          .filter((t): t is TerminalTab => t !== null);

        let nextActive = state.activeTabId;
        if (tabClosed && activeTabId === tabClosed) {
          if (next.length > 0) {
            nextActive = next[next.length - 1].id;
          } else {
            nextActive = null;
            useViewStore.getState().setView("connections");
          }
        }
        return { tabs: next, activeTabId: nextActive };
      });
      try {
        await invoke("ssh_disconnect", { sessionId });
      } catch {
        // ignore
      } finally {
        disposeOutput(sessionId);
      }
    },

    closeTab: async (tabId) => {
      const { tabs, activeTabId } = get();
      const tab = tabs.find((t) => t.id === tabId);
      if (!tab) return;
      tab.panes.forEach(markIfStillConnecting);
      for (const pane of tab.panes) useAuthPromptStore.getState().cancel(pane.sessionId);
      set((state) => {
        const remaining = state.tabs.filter((t) => t.id !== tabId);
        let nextActive = state.activeTabId;
        if (activeTabId === tabId) {
          if (remaining.length > 0) {
            nextActive = remaining[remaining.length - 1].id;
          } else {
            nextActive = null;
            useViewStore.getState().setView("connections");
          }
        }
        return { tabs: remaining, activeTabId: nextActive };
      });
      for (const pane of tab.panes) {
        try {
          await invoke("ssh_disconnect", { sessionId: pane.sessionId });
        } catch {
          // ignore
        } finally {
          disposeOutput(pane.sessionId);
        }
      }
    },

    selectTabByIndex: (index) => {
      const tab = get().tabs[index];
      if (!tab) return;
      useViewStore.getState().setView("terminals");
      set({ activeTabId: tab.id });
    },
  };
});
