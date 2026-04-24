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
import { GitSyncView } from "./components/GitSyncView";
import { ScpDialog } from "./components/ScpDialog";
import { LayoutToggle } from "./components/ui/layout-toggle";
import { ConnectPicker } from "./components/ConnectPicker";
import { ContextMenu } from "./components/ContextMenu";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { Button } from "./components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./components/ui/dialog";
import { useConnectionsStore } from "./store/useConnectionsStore";
import { useCredentialsStore } from "./store/useCredentialsStore";
import { useSettingsStore } from "./store/useSettingsStore";
import { useGitSyncStore } from "./store/useGitSyncStore";
import { useApplySettings } from "./hooks/useApplySettings";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts";
import { invoke } from "./lib/tauri";
import { takeScreenshot } from "./lib/screenshot";
import { log as appLog } from "./lib/log";
import { Connection, ConnectionInput, Credential, OpenMode, LayoutMode } from "./types";
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
  const shellTabsRef = React.useRef<TerminalTab[]>([]);
  const activeTabIdRef = React.useRef<string | null>(null);
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
  const [scpConnection, setScpConnection] = useState<Connection | null>(null);
  const [scpOpen, setScpOpen] = useState(false);
  const [confirmDeleteConn, setConfirmDeleteConn] = useState<Connection | null>(null);
  const [confirmDeleteCred, setConfirmDeleteCred] = useState<Credential | null>(null);
  const [confirmClosePane, setConfirmClosePane] = useState<{
    sessionId: string;
    name: string;
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
  const { status: gitSyncStatus, fetchStatus: fetchGitSyncStatus } = useGitSyncStore();

  useApplySettings(settings);

  useEffect(() => {
    shellTabsRef.current = shellTabs;
  }, [shellTabs]);

  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  useEffect(() => {
    fetchConnections();
    fetchCredentials();
    fetchSettings();
    fetchGitSyncStatus();
  }, []);

  const connectionSig = React.useMemo(
    () =>
      connections
        .map((c) => `${c.id}:${c.name}:${c.host}:${c.port}:${c.credential_id ?? ""}`)
        .sort()
        .join("|"),
    [connections],
  );

  const credentialSig = React.useMemo(
    () =>
      credentials
        .map((c) => `${c.id}:${c.name}:${c.username}:${c.type}`)
        .sort()
        .join("|"),
    [credentials],
  );

  useEffect(() => {
    void fetchGitSyncStatus();
  }, [
    settings.git_sync_repo_path,
    settings.git_sync_remote,
    settings.git_sync_branch,
    connectionSig,
    credentialSig,
    fetchGitSyncStatus,
  ]);

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

  const handleConnSubmit = async (data: ConnectionInput | Connection) => {
    if ("id" in data) {
      await updateConnection(data);
    } else {
      await addConnection(data);
    }
  };

  const handleDeleteConnection = (id: string) => {
    const conn = connections.find((c) => c.id === id);
    if (!conn) return;
    setConfirmDeleteConn(conn);
  };

  const performDeleteConnection = async (id: string) => {
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

  const handleCloneSubmit = async (data: ConnectionInput | Connection) => {
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
    // Audit-4 Phase 4b: tunnels are only meaningful for port_forward
    // connections. The picker upstream filters by `kind === "port_forward"`,
    // but assert here so the discriminated `connection` field downstream
    // (TunnelSession) is correctly narrowed.
    if (conn.type !== "port_forward") {
      appLog.error("tunnel", `Refusing to start tunnel for non-port_forward connection ${conn.name}`);
      return;
    }
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

  const addSessionToNewTab = (session: TerminalSession): string => {
    const tabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setShellTabs((prev) => [...prev, { id: tabId, mode: "single", panes: [session] }]);
    setActiveTabId(tabId);
    return tabId;
  };

  const addSessionToActiveTab = (session: TerminalSession, mode: "horizontal" | "vertical") => {
    const currentActiveTabId = activeTabIdRef.current;
    const currentActiveTab = shellTabsRef.current.find((t) => t.id === currentActiveTabId);
    if (!currentActiveTabId || !currentActiveTab || currentActiveTab.panes.length >= 2) {
      addSessionToNewTab(session);
      return;
    }
    setShellTabs((prev) =>
      prev.map((t) =>
        t.id === currentActiveTabId ? { ...t, mode, panes: [...t.panes, session] } : t,
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

  /**
   * Show a confirmation before closing a live (non-failed) pane. Failed
   * panes that never opened a shell don't need confirmation — there's
   * nothing for the user to lose.
   */
  const handleClosePaneRequest = (sessionId: string) => {
    let target: { sessionId: string; name: string } | null = null;
    for (const tab of shellTabs) {
      const pane = tab.panes.find((p) => p.sessionId === sessionId);
      if (pane) {
        if (pane.error || pane.retrying) {
          // Failed/retrying pane — close immediately.
          void handleClosePane(sessionId);
          return;
        }
        target = { sessionId, name: pane.connectionName };
        break;
      }
    }
    if (target) setConfirmClosePane(target);
  };

  const handleCloseTabRequest = (tabId: string) => {
    const tab = shellTabs.find((t) => t.id === tabId);
    if (!tab) return;
    const liveCount = tab.panes.filter((p) => !p.error).length;
    if (liveCount === 0) {
      void handleCloseTab(tabId);
      return;
    }
    if (tab.panes.length === 1) {
      setConfirmClosePane({
        sessionId: tab.panes[0].sessionId,
        name: tab.panes[0].connectionName,
      });
      return;
    }
    // Multi-pane tab close: reuse the orphan-style state model
    // by stashing all session IDs as a synthetic single confirm.
    setConfirmClosePane({
      sessionId: `__tab__:${tabId}`,
      name: tab.panes.map((p) => p.connectionName).join(" + "),
    });
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
    void saveSettings({ ...settings, [key]: value }).catch((error) => {
      appLog.error(
        "settings",
        `Failed to save layout settings: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  };

  const totalShellSessions = shellTabs.reduce((n, t) => n + t.panes.length, 0);
  const gitPending = gitSyncStatus.has_local_changes || gitSyncStatus.has_remote_changes;

  const selectShellTabByIndex = React.useCallback(
    (index: number) => {
      const tab = shellTabsRef.current[index];
      if (!tab) return;
      setView("terminals");
      setActiveTabId(tab.id);
    },
    [],
  );

  // Global keyboard shortcuts. We rebuild the map each render so the closures
  // see fresh state without us needing to thread refs through every action.
  useGlobalShortcuts({
    "mod+k": () => setPickerOpen(true),
    "mod+n": () => {
      // The form is mounted at the App root, so we can open it from any
      // view without first switching to "connections". The user is
      // returned to the same view they were on after closing the form.
      setEditingConn(null);
      setCloningConn(null);
      setConnFormOpen(true);
    },
    "mod+,": () => setView("settings"),
    "mod+w": () => {
      if (view !== "terminals" || !activeTabId) return;
      handleCloseTabRequest(activeTabId);
    },
    "mod+1": () => selectShellTabByIndex(0),
    "mod+2": () => selectShellTabByIndex(1),
    "mod+3": () => selectShellTabByIndex(2),
    "mod+4": () => selectShellTabByIndex(3),
    "mod+5": () => selectShellTabByIndex(4),
    "mod+6": () => selectShellTabByIndex(5),
    "mod+7": () => selectShellTabByIndex(6),
    "mod+8": () => selectShellTabByIndex(7),
    "mod+9": () => selectShellTabByIndex(8),
  });

  return (
    <div className="flex flex-col h-screen bg-background text-foreground overflow-hidden">
      <TitleBar onSettings={() => setView("settings")} settingsActive={view === "settings"} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          active={view}
          onNavigate={(v) => setView(v as View)}
          terminalCount={totalShellSessions}
          tunnelCount={tunnelSessions.length}
          gitPending={gitPending}
        />

        <main className="flex-1 flex flex-col overflow-hidden">
        {view === "terminals" && shellTabs.length > 0 ? (
          <TerminalTabs
            tabs={shellTabs}
            activeTabId={activeTabId}
            onSelectTab={setActiveTabId}
            onCloseTab={handleCloseTabRequest}
            onClosePane={(_tabId, sessionId) =>
              handleClosePaneRequest(sessionId)
            }
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
                onScp={(conn) => {
                  setScpConnection(conn);
                  setScpOpen(true);
                }}
              />
            </div>
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
                onDelete={(id) => {
                  const cred = credentials.find((c) => c.id === id);
                  if (cred) setConfirmDeleteCred(cred);
                }}
              />
            </div>
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

        {view === "git_sync" && <GitSyncView />}

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

      <ScpDialog
        open={scpOpen}
        onOpenChange={setScpOpen}
        connection={scpConnection}
      />

      {/* Custom context menu */}
      {contextMenu && (
        <ContextMenu
          position={contextMenu}
          onClose={() => setContextMenu(null)}
          ariaLabel="Window actions"
          items={[
            {
              label: "Take screenshot",
              icon: <span aria-hidden="true">📸</span>,
              onClick: handleTakeScreenshot,
            },
          ]}
        />
      )}

      {/* Screenshot saved toast */}
      {screenshotToast && (
        <div className="fixed bottom-4 right-4 z-[9999] bg-popover border rounded-md shadow-lg px-4 py-2 text-sm max-w-xs truncate">
          📸 Saved: {screenshotToast}
        </div>
      )}

      {/* Delete connection confirmation */}
      <ConfirmDialog
        open={!!confirmDeleteConn}
        onOpenChange={(o) => !o && setConfirmDeleteConn(null)}
        title="Delete connection?"
        description={
          confirmDeleteConn ? (
            <>
              Permanently delete <strong>{confirmDeleteConn.name}</strong>?
              This cannot be undone.
            </>
          ) : null
        }
        confirmLabel="Delete connection"
        variant="destructive"
        onConfirm={async () => {
          if (confirmDeleteConn) {
            await performDeleteConnection(confirmDeleteConn.id);
          }
        }}
      />

      {/* Delete credential confirmation */}
      <ConfirmDialog
        open={!!confirmDeleteCred}
        onOpenChange={(o) => !o && setConfirmDeleteCred(null)}
        title="Delete credential?"
        description={
          confirmDeleteCred ? (
            <>
              Delete credential <strong>{confirmDeleteCred.name}</strong>?
              Connections that reference it will lose their saved
              authentication.
            </>
          ) : null
        }
        confirmLabel="Delete credential"
        variant="destructive"
        onConfirm={async () => {
          if (confirmDeleteCred) {
            await deleteCredential(confirmDeleteCred.id);
          }
        }}
      />

      {/* Close terminal pane / tab confirmation */}
      <ConfirmDialog
        open={!!confirmClosePane}
        onOpenChange={(o) => !o && setConfirmClosePane(null)}
        title="Close terminal?"
        description={
          confirmClosePane ? (
            <>
              The session for <strong>{confirmClosePane.name}</strong> will
              be disconnected. Any unsaved work in the shell will be lost.
            </>
          ) : null
        }
        confirmLabel="Close"
        variant="destructive"
        onConfirm={async () => {
          if (!confirmClosePane) return;
          if (confirmClosePane.sessionId.startsWith("__tab__:")) {
            const tabId = confirmClosePane.sessionId.slice("__tab__:".length);
            await handleCloseTab(tabId);
          } else {
            await handleClosePane(confirmClosePane.sessionId);
          }
        }}
      />

      {/* Orphaned private credential confirmation dialog */}
      <Dialog
        open={!!orphanCredDialog}
        onOpenChange={(open) => {
          if (!open) setOrphanCredDialog(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete private credential?</DialogTitle>
            <DialogDescription>
              This connection has a private credential that is not used by any
              other connection. Do you want to delete it as well?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col-reverse sm:flex-col-reverse sm:space-x-0 gap-2">
            <Button
              variant="ghost"
              onClick={() => setOrphanCredDialog(null)}
            >
              Cancel
            </Button>
            <Button
              variant="secondary"
              onClick={() => handleOrphanCredDialogConfirm(false)}
            >
              Delete connection only
            </Button>
            <Button
              variant="destructive"
              onClick={() => handleOrphanCredDialogConfirm(true)}
            >
              Delete connection and credential
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/*
       * ConnectionForm and CredentialForm are mounted at the App root so
       * they are reachable from any view (Cmd+N opens the connection
       * form even when the user is on Logs / Settings / Tunnels, the
       * "New Credential" picker inside ConnectionForm can open the
       * credential form on top of the connection form, etc.). Keeping
       * them in the connections/credentials view branches caused the
       * dialog to mount in the same render that switched view, which
       * made Cmd+N feel laggy and discarded any in-progress draft if
       * the user navigated away mid-edit.
       */}
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
      <CredentialForm
        open={credFormOpen}
        onOpenChange={(open) => {
          setCredFormOpen(open);
          if (!open) setEditingCred(null);
        }}
        credential={editingCred}
        onSubmit={handleCredSubmit}
      />
    </div>
  );
}

export default App;
