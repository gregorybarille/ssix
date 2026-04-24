import { create } from "zustand";
import { invoke } from "@/lib/tauri";
import { log as appLog } from "@/lib/log";
import type { Connection, OpenMode } from "@/types";
import type {
  TerminalTab,
  TerminalSession,
} from "@/components/TerminalTabs";
import { useViewStore } from "./useViewStore";
import { useTunnelsStore } from "./useTunnelsStore";
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
 * `connect()` routes port_forward connections to the tunnels store
 * and shell connections into a new tab (or split into the active
 * tab, depending on `mode`). When the last tab closes, view falls
 * back to "connections" via the view store.
 */
const cancelled: Set<string> = new Set();

interface TerminalsState {
  tabs: TerminalTab[];
  activeTabId: string | null;

  setActiveTabId: (id: string | null) => void;

  /**
   * Open a connection. For port_forward, hands off to the tunnels
   * store. Otherwise opens a shell session in a new tab or split.
   * `replaceSessionId` re-opens an existing failed pane in place,
   * preserving its slot/order.
   */
  connect: (
    conn: Connection,
    options?: { mode?: OpenMode; replaceSessionId?: string },
  ) => Promise<void>;

  /** Close one pane. If it's the only pane in its tab, the tab closes too. */
  closePane: (sessionId: string) => Promise<void>;

  /** Close every pane in a tab. */
  closeTab: (tabId: string) => Promise<void>;

  /** Switch to terminals view and select the Nth (0-indexed) tab, if it exists. */
  selectTabByIndex: (index: number) => void;

  /** Total live + failed panes across all tabs (for the sidebar badge). */
  totalSessionCount: () => number;
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
      if (conn.type === "port_forward") {
        await useTunnelsStore.getState().connectTunnel(conn);
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
        const sessionId = await invoke<string>("ssh_connect", {
          connectionId: conn.id,
        });
        if (cancelled.has(placeholderId)) {
          cancelled.delete(placeholderId);
          invoke("ssh_disconnect", { sessionId }).catch(() => {});
          return;
        }
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
        appLog.info("ssh", `Connected to ${conn.name}`);
      } catch (err) {
        if (cancelled.has(placeholderId)) {
          cancelled.delete(placeholderId);
          return;
        }
        updateSessionEverywhere(placeholderId, {
          error: String(err),
          retrying: false,
        });
        appLog.error("ssh", `Connect failed for ${conn.name}: ${String(err)}`);
      }
    },

    closePane: async (sessionId) => {
      const { tabs, activeTabId } = get();
      let tabClosed: string | null = null;
      for (const tab of tabs) {
        const pane = tab.panes.find((p) => p.sessionId === sessionId);
        if (pane) {
          if (pane.retrying && !pane.error) {
            cancelled.add(sessionId);
          }
          if (tab.panes.length === 1) {
            tabClosed = tab.id;
          }
          break;
        }
      }
      try {
        await invoke("ssh_disconnect", { sessionId });
      } catch {
        // ignore
      }
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
    },

    closeTab: async (tabId) => {
      const { tabs, activeTabId } = get();
      const tab = tabs.find((t) => t.id === tabId);
      if (!tab) return;
      for (const pane of tab.panes) {
        if (pane.retrying && !pane.error) {
          cancelled.add(pane.sessionId);
        }
        try {
          await invoke("ssh_disconnect", { sessionId: pane.sessionId });
        } catch {
          // ignore
        }
      }
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
    },

    selectTabByIndex: (index) => {
      const tab = get().tabs[index];
      if (!tab) return;
      useViewStore.getState().setView("terminals");
      set({ activeTabId: tab.id });
    },

    totalSessionCount: () =>
      get().tabs.reduce((n, t) => n + t.panes.length, 0),
  };
});
