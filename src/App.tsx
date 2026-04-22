import React, { useEffect, useState } from "react";
import { Sidebar, NavItem } from "./components/Sidebar";
import { TitleBar } from "./components/TitleBar";
import { ConnectionList } from "./components/ConnectionList";
import { ConnectionForm } from "./components/ConnectionForm";
import { CredentialList } from "./components/CredentialList";
import { CredentialForm } from "./components/CredentialForm";
import { SettingsPanel } from "./components/SettingsPanel";
import { SearchBar } from "./components/SearchBar";
import {
  TerminalTabs,
  TerminalTab,
  TerminalSession,
} from "./components/TerminalTabs";
import { TunnelsView, TunnelSession } from "./components/TunnelsView";
import { LogsView } from "./components/LogsView";
import { LayoutToggle } from "./components/ui/layout-toggle";
import { ConnectPicker } from "./components/ConnectPicker";
import { ContextMenu } from "./components/ContextMenu";
import { Button } from "./components/ui/button";
import { useConnectionsStore } from "./store/useConnectionsStore";
import { useCredentialsStore } from "./store/useCredentialsStore";
import { useSettingsStore } from "./store/useSettingsStore";
import { useApplySettings } from "./hooks/useApplySettings";
import { invoke } from "./lib/tauri";
import { takeScreenshot } from "./lib/screenshot";
import { log as appLog } from "./lib/log";
import { Connection, Credential, OpenMode, LayoutMode } from "./types";
import { Plus } from "lucide-react";

type View = NavItem;

function App() {
  const [view, setView] = useState<View>("connections");
  const [connFormOpen, setConnFormOpen] = useState(false);
  const [credFormOpen, setCredFormOpen] = useState(false);
  const [editingConn, setEditingConn] = useState<Connection | null>(null);
  const [editingCred, setEditingCred] = useState<Credential | null>(null);
  const [cloningConn, setCloningConn] = useState<Connection | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [shellTabs, setShellTabs] = useState<TerminalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [tunnelSessions, setTunnelSessions] = useState<TunnelSession[]>([]);
  const cancelledRef = React.useRef<Set<string>>(new Set());
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerMode, setPickerMode] = useState<OpenMode>("tab");
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [screenshotToast, setScreenshotToast] = useState<string | null>(null);
  const [orphanCredDialog, setOrphanCredDialog] = useState<{
    connId: string;
    credId: string;
  } | null>(null);

  const {
    connections,
    fetchConnections,
    addConnection,
    updateConnection,
    deleteConnection,
    cloneConnection,
    searchConnections,
    getOrphanPrivateCredential,
  } = useConnectionsStore();

  const {
    credentials,
    fetchCredentials,
    addCredential,
    addInlineCredential,
    updateCredential,
    deleteCredential,
  } = useCredentialsStore();

  const { settings, fetchSettings, saveSettings } = useSettingsStore();

  useApplySettings(settings);

  useEffect(() => {
    fetchConnections();
    fetchCredentials();
    fetchSettings();
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const { x, y } = (e as CustomEvent<{ x: number; y: number }>).detail;
      setContextMenu({ x, y });
    };
    window.addEventListener("ssx:contextmenu", handler);
    return () => window.removeEventListener("ssx:contextmenu", handler);
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Element;
      if (target.closest("input, textarea, [contenteditable]")) return;
      e.preventDefault();
      if (target.closest(".xterm-screen, .xterm-rows")) {
        navigator.clipboard.readText().then((text) => {
          if (text) {
            window.dispatchEvent(
              new CustomEvent("ssx:terminal-paste", { detail: { text } })
            );
          }
        }).catch(() => {});
        return;
      }
      window.dispatchEvent(
        new CustomEvent("ssx:contextmenu", {
          detail: { x: e.clientX, y: e.clientY },
        })
      );
    };
    document.addEventListener("contextmenu", handler);
    return () => document.removeEventListener("contextmenu", handler);
  }, []);

  const handleTakeScreenshot = async () => {
    try {
      const path = await takeScreenshot();
      setScreenshotToast(path);
      setTimeout(() => setScreenshotToast(null), 4000);
    } catch {
      setScreenshotToast("Screenshot failed.");
      setTimeout(() => setScreenshotToast(null), 3000);
    }
  };

  const handleConnSubmit = async (data: Omit<Connection, "id"> | Connection) => {
    if ("id" in data) {
      await updateConnection(data as Connection);
    } else {
      await addConnection(data);
    }
  };

  const handleDeleteConnection = async (id: string) => {
    const orphanCredId = await getOrphanPrivateCredential(id);
    if (orphanCredId) {
      setOrphanCredDialog({ connId: id, credId: orphanCredId });
    } else {
      await deleteConnection(id);
    }
  };

  const handleOrphanCredDialogConfirm = async (deleteCredToo: boolean) => {
    if (!orphanCredDialog) return;
    const { connId, credId } = orphanCredDialog;
    setOrphanCredDialog(null);
    await deleteConnection(connId);
    if (deleteCredToo) {
      await deleteCredential(credId);
    }
  };

  const handleCredSubmit = async (data: Omit<Credential, "id"> | Credential) => {
    if ("id" in data) {
      await updateCredential(data as Credential);
    } else {
      await addCredential(data);
    }
  };

  const handleCloneSubmit = async (data: Omit<Connection, "id"> | Connection) => {
    if (cloningConn) {
      await cloneConnection(cloningConn.id, data.name, {
        host: data.host,
        port: data.port,
        credential_id: data.credential_id,
      });
    }
  };

  const handleCreateCredential = async (data: Omit<Credential, "id">): Promise<Credential> => {
    if (data.is_private) {
      return await addInlineCredential(data);
    }
    return await addCredential(data);
  };

  const handleSearch = (query: string) => {
    setSearchQuery(query);
    if (query) {
      searchConnections(query);
    } else {
      fetchConnections();
    }
  };

  /* ------------------------- Tunnel session lifecycle ------------------------- */

  const handleConnectTunnel = async (conn: Connection) => {
    const failedId = `tunnel-${conn.id}-${Date.now()}`;
    setTunnelSessions((prev) => [
      ...prev,
      { sessionId: failedId, connectionName: conn.name, connection: conn, retrying: true },
    ]);
    setView("tunnels");
    try {
      const sessionId = await invoke<string>("ssh_connect", { connectionId: conn.id });
      if (cancelledRef.current.has(failedId)) {
        cancelledRef.current.delete(failedId);
        invoke("ssh_disconnect", { sessionId }).catch(() => {});
        return;
      }
      setTunnelSessions((prev) =>
        prev.map((s) =>
          s.sessionId === failedId
            ? { sessionId, connectionName: conn.name, connection: conn }
            : s,
        ),
      );
      appLog.info("tunnel", `Started ${conn.name}`);
    } catch (err) {
      if (cancelledRef.current.has(failedId)) {
        cancelledRef.current.delete(failedId);
        return;
      }
      setTunnelSessions((prev) =>
        prev.map((s) =>
          s.sessionId === failedId
            ? { ...s, error: String(err), retrying: false }
            : s,
        ),
      );
      appLog.error("tunnel", `Failed to start ${conn.name}: ${String(err)}`);
    }
  };

  const handleCloseTunnel = async (sessionId: string) => {
    const session = tunnelSessions.find((s) => s.sessionId === sessionId);
    if (session?.retrying && !session.error) {
      cancelledRef.current.add(sessionId);
    }
    try {
      await invoke("ssh_disconnect", { sessionId });
    } catch {
      // ignore
    }
    setTunnelSessions((prev) => prev.filter((s) => s.sessionId !== sessionId));
  };

  /* ------------------------- Shell session lifecycle ------------------------- */

  // Find the active tab; null if none.
  const activeTab = shellTabs.find((t) => t.id === activeTabId) ?? null;

  const addSessionToNewTab = (session: TerminalSession): string => {
    const tabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setShellTabs((prev) => [...prev, { id: tabId, mode: "single", panes: [session] }]);
    setActiveTabId(tabId);
    return tabId;
  };

  const addSessionToActiveTab = (session: TerminalSession, mode: "horizontal" | "vertical") => {
    if (!activeTab || activeTab.panes.length >= 2) {
      addSessionToNewTab(session);
      return;
    }
    setShellTabs((prev) =>
      prev.map((t) =>
        t.id === activeTab.id ? { ...t, mode, panes: [...t.panes, session] } : t,
      ),
    );
  };

  const updateSessionEverywhere = (
    placeholderId: string,
    next: Partial<TerminalSession> & { sessionId?: string },
  ) => {
    setShellTabs((prev) =>
      prev.map((t) => ({
        ...t,
        panes: t.panes.map((p) =>
          p.sessionId === placeholderId ? { ...p, ...next } : p,
        ),
      })),
    );
  };

  /**
   * Open a connection. For port_forward, route to TunnelsView. Otherwise open
   * a shell session in a new tab or split into the active tab.
   */
  const handleConnect = async (
    conn: Connection,
    options?: { mode?: OpenMode; replaceSessionId?: string },
  ) => {
    if (conn.type === "port_forward") {
      handleConnectTunnel(conn);
      return;
    }

    const mode: OpenMode = options?.mode ?? settings.default_open_mode ?? "tab";
    const replaceSessionId = options?.replaceSessionId;
    const placeholderId = replaceSessionId ?? `failed-${conn.id}-${Date.now()}`;
    const placeholder: TerminalSession = {
      sessionId: placeholderId,
      connectionName: conn.name,
      connection: conn,
      retrying: true,
    };

    if (replaceSessionId) {
      updateSessionEverywhere(placeholderId, { retrying: true, error: undefined });
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
      const sessionId = await invoke<string>("ssh_connect", { connectionId: conn.id });
      if (cancelledRef.current.has(placeholderId)) {
        cancelledRef.current.delete(placeholderId);
        invoke("ssh_disconnect", { sessionId }).catch(() => {});
        return;
      }
      // Replace placeholder identity in-place so the pane keeps its slot.
      setShellTabs((prev) =>
        prev.map((t) => ({
          ...t,
          panes: t.panes.map((p) =>
            p.sessionId === placeholderId
              ? { sessionId, connectionName: conn.name, connection: conn }
              : p,
          ),
        })),
      );
      appLog.info("ssh", `Connected to ${conn.name}`);
    } catch (err) {
      if (cancelledRef.current.has(placeholderId)) {
        cancelledRef.current.delete(placeholderId);
        return;
      }
      updateSessionEverywhere(placeholderId, { error: String(err), retrying: false });
      appLog.error("ssh", `Connect failed for ${conn.name}: ${String(err)}`);
    }
  };

  const handleRetry = (conn: Connection, replaceSessionId: string) => {
    handleConnect(conn, { replaceSessionId });
  };

  const handleEditFromTerminal = (conn: Connection, failedSessionId: string) => {
    handleClosePane(failedSessionId);
    setEditingConn(conn);
    setCloningConn(null);
    setConnFormOpen(true);
    setView("connections");
  };

  /** Close a single pane. If it's the only pane in a tab, the tab closes too. */
  const handleClosePane = async (sessionId: string) => {
    let tabClosed: string | null = null;
    // Find the pane and clean up cancelled flag if needed.
    for (const tab of shellTabs) {
      const pane = tab.panes.find((p) => p.sessionId === sessionId);
      if (pane) {
        if (pane.retrying && !pane.error) {
          cancelledRef.current.add(sessionId);
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
    setShellTabs((prev) => {
      const next = prev
        .map((t) => {
          const remainingPanes = t.panes.filter((p) => p.sessionId !== sessionId);
          if (remainingPanes.length === 0) return null;
          const newMode = remainingPanes.length === 1 ? "single" : t.mode;
          return { ...t, mode: newMode, panes: remainingPanes } as TerminalTab;
        })
        .filter((t): t is TerminalTab => t !== null);
      if (tabClosed && activeTabId === tabClosed) {
        if (next.length > 0) {
          setActiveTabId(next[next.length - 1].id);
        } else {
          setActiveTabId(null);
          setView("connections");
        }
      }
      return next;
    });
  };

  const handleCloseTab = async (tabId: string) => {
    const tab = shellTabs.find((t) => t.id === tabId);
    if (!tab) return;
    for (const pane of tab.panes) {
      if (pane.retrying && !pane.error) {
        cancelledRef.current.add(pane.sessionId);
      }
      try {
        await invoke("ssh_disconnect", { sessionId: pane.sessionId });
      } catch {
        // ignore
      }
    }
    setShellTabs((prev) => {
      const remaining = prev.filter((t) => t.id !== tabId);
      if (activeTabId === tabId) {
        if (remaining.length > 0) {
          setActiveTabId(remaining[remaining.length - 1].id);
        } else {
          setActiveTabId(null);
          setView("connections");
        }
      }
      return remaining;
    });
  };

  const handleNewTabFromTerminal = (mode: OpenMode) => {
    setPickerMode(mode);
    setPickerOpen(true);
  };

  const handlePickerConnect = (conn: Connection) => {
    handleConnect(conn, { mode: pickerMode });
  };

  /* ------------------------- Layout settings helpers ------------------------- */

  const updateLayout = (key: "connection_layout" | "credential_layout" | "tunnel_layout", value: LayoutMode) => {
    saveSettings({ ...settings, [key]: value });
  };

  const totalShellSessions = shellTabs.reduce((n, t) => n + t.panes.length, 0);

  return (
    <div className="flex flex-col h-screen bg-background text-foreground overflow-hidden">
      <TitleBar onSettings={() => setView("settings")} settingsActive={view === "settings"} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          active={view}
          onNavigate={(v) => setView(v as View)}
          terminalCount={totalShellSessions}
          tunnelCount={tunnelSessions.length}
        />

        <main className="flex-1 flex flex-col overflow-hidden">
        {view === "terminals" && shellTabs.length > 0 ? (
          <TerminalTabs
            tabs={shellTabs}
            activeTabId={activeTabId}
            onSelectTab={setActiveTabId}
            onCloseTab={handleCloseTab}
            onClosePane={(_tabId, sessionId) => handleClosePane(sessionId)}
            onNewTab={handleNewTabFromTerminal}
            onRetry={handleRetry}
            onEdit={handleEditFromTerminal}
            settings={settings}
          />
        ) : (
        <>
        {view === "connections" && (
          <>
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <h1 className="text-lg font-semibold">Connections</h1>
              <div className="flex items-center gap-2">
                <LayoutToggle
                  value={settings.connection_layout}
                  onChange={(v) => updateLayout("connection_layout", v)}
                />
                <Button
                  size="sm"
                  onClick={() => {
                    setEditingConn(null);
                    setConnFormOpen(true);
                  }}
                >
                  <Plus className="h-4 w-4 mr-1" />
                  New Connection
                </Button>
              </div>
            </div>
            <div className="px-6 py-3 border-b border-border">
              <SearchBar
                value={searchQuery}
                onChange={setSearchQuery}
                onSearch={handleSearch}
              />
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-2">
              <ConnectionList
                connections={connections}
                credentials={credentials}
                layout={settings.connection_layout}
                onEdit={(conn) => {
                  setEditingConn(conn);
                  setCloningConn(null);
                  setConnFormOpen(true);
                }}
                onDelete={handleDeleteConnection}
                onClone={(conn) => {
                  setCloningConn(conn);
                  setEditingConn(null);
                  setConnFormOpen(true);
                }}
                onConnect={(c) => handleConnect(c)}
              />
            </div>
            <ConnectionForm
              open={connFormOpen}
              onOpenChange={(open) => {
                setConnFormOpen(open);
                if (!open) {
                  setEditingConn(null);
                  setCloningConn(null);
                }
              }}
              connection={cloningConn ?? editingConn}
              credentials={credentials}
              onSubmit={cloningConn ? handleCloneSubmit : handleConnSubmit}
              onCreateCredential={handleCreateCredential}
              isClone={!!cloningConn}
            />
          </>
        )}

        {view === "credentials" && (
          <>
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <h1 className="text-lg font-semibold">Credentials</h1>
              <div className="flex items-center gap-2">
                <LayoutToggle
                  value={settings.credential_layout}
                  onChange={(v) => updateLayout("credential_layout", v)}
                />
                <Button
                  size="sm"
                  onClick={() => {
                    setEditingCred(null);
                    setCredFormOpen(true);
                  }}
                >
                  <Plus className="h-4 w-4 mr-1" />
                  New Credential
                </Button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-2">
              <CredentialList
                credentials={credentials}
                layout={settings.credential_layout}
                onEdit={(cred) => {
                  setEditingCred(cred);
                  setCredFormOpen(true);
                }}
                onDelete={deleteCredential}
              />
            </div>
            <CredentialForm
              open={credFormOpen}
              onOpenChange={(open) => {
                setCredFormOpen(open);
                if (!open) setEditingCred(null);
              }}
              credential={editingCred}
              onSubmit={handleCredSubmit}
            />
          </>
        )}

        {view === "tunnels" && (
          <TunnelsView
            sessions={tunnelSessions}
            connections={connections}
            credentials={credentials}
            layout={settings.tunnel_layout}
            onLayoutChange={(v) => updateLayout("tunnel_layout", v)}
            onCloseSession={handleCloseTunnel}
            onConnect={(c) => handleConnect(c)}
            onEdit={(conn) => {
              setEditingConn(conn);
              setCloningConn(null);
              setConnFormOpen(true);
              setView("connections");
            }}
            onDelete={handleDeleteConnection}
            onClone={(conn) => {
              setCloningConn(conn);
              setEditingConn(null);
              setConnFormOpen(true);
              setView("connections");
            }}
          />
        )}

        {view === "logs" && <LogsView />}

        {view === "settings" && (
          <div className="flex-1 overflow-y-auto">
            <SettingsPanel settings={settings} onSave={saveSettings} />
          </div>
        )}
        </>
        )}
      </main>
      </div>

      {/* Quick connect picker for + tab button */}
      <ConnectPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        connections={connections}
        credentials={credentials}
        onConnect={handlePickerConnect}
      />

      {/* Custom context menu */}
      {contextMenu && (
        <ContextMenu
          position={contextMenu}
          onClose={() => setContextMenu(null)}
          onTakeScreenshot={handleTakeScreenshot}
        />
      )}

      {/* Screenshot saved toast */}
      {screenshotToast && (
        <div className="fixed bottom-4 right-4 z-[9999] bg-popover border rounded-md shadow-lg px-4 py-2 text-sm max-w-xs truncate">
          📸 Saved: {screenshotToast}
        </div>
      )}

      {/* Orphaned private credential confirmation dialog */}
      {orphanCredDialog && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50">
          <div className="bg-popover border rounded-lg shadow-xl p-6 max-w-sm w-full mx-4">
            <h2 className="text-base font-semibold mb-2">Delete private credential?</h2>
            <p className="text-sm text-muted-foreground mb-5">
              This connection has a private credential that is not used by any
              other connection. Do you want to delete it as well?
            </p>
            <div className="flex flex-col gap-2">
              <Button onClick={() => handleOrphanCredDialogConfirm(true)}>
                Delete connection and credential
              </Button>
              <Button variant="secondary" onClick={() => handleOrphanCredDialogConfirm(false)}>
                Delete connection only
              </Button>
              <Button variant="ghost" onClick={() => setOrphanCredDialog(null)}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
