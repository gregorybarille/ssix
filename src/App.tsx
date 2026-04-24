import React, { Suspense, useEffect, lazy } from "react";
import { Sidebar } from "./components/Sidebar";
import { TitleBar } from "./components/TitleBar";
import { ConnectionList } from "./components/ConnectionList";
import { ConnectionForm } from "./components/ConnectionForm";
import { CredentialList } from "./components/CredentialList";
import { CredentialForm } from "./components/CredentialForm";
import { SearchBar } from "./components/SearchBar";
import { TerminalTabs } from "./components/TerminalTabs";
import { TunnelsView } from "./components/TunnelsView";
import { LayoutToggle } from "./components/ui/layout-toggle";
import { ConnectPicker } from "./components/ConnectPicker";
import { ContextMenu } from "./components/ContextMenu";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { Button } from "./components/ui/button";

/**
 * Audit-4 Phase 5e: Settings, Git-Sync, Logs and the SCP dialog are
 * all leaf views that the user opens infrequently and that pull in
 * sizeable component trees (settings panels, git diff renderers,
 * log virtualization, file-transfer state). Lazy-loading them keeps
 * the initial bundle small and shifts their cost to first use.
 */
const SettingsPanel = lazy(() =>
  import("./components/SettingsPanel").then((m) => ({ default: m.SettingsPanel })),
);
const GitSyncView = lazy(() =>
  import("./components/GitSyncView").then((m) => ({ default: m.GitSyncView })),
);
const LogsView = lazy(() =>
  import("./components/LogsView").then((m) => ({ default: m.LogsView })),
);
const ScpDialog = lazy(() =>
  import("./components/ScpDialog").then((m) => ({ default: m.ScpDialog })),
);

/**
 * Minimal Suspense fallback for lazy-loaded views. Intentionally
 * spartan — chunks load fast on local disk and a skeleton would
 * just flash. Centralised so all view fallbacks look identical.
 */
function ViewFallback({ label }: { label: string }) {
  return (
    <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground-soft">
      {label}
    </div>
  );
}
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
import { useViewStore } from "./store/useViewStore";
import { useDialogsStore } from "./store/useDialogsStore";
import { useTerminalsStore } from "./store/useTerminalsStore";
import { useTunnelsStore } from "./store/useTunnelsStore";
import { useApplySettings } from "./hooks/useApplySettings";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts";
import { takeScreenshot } from "./lib/screenshot";
import { log as appLog } from "./lib/log";
import { Connection, ConnectionInput, Credential, LayoutMode } from "./types";
import { Plus } from "lucide-react";

/**
 * Audit-4 Phase 5d: App.tsx is now a pure composition layer. Terminal
 * pane lifecycle, tunnel session lifecycle, dialog UI state and the
 * current view live in dedicated Zustand stores. App owns only:
 *
 *  - the search input string (purely a controlled-form value)
 *  - cross-store submit handlers (e.g. clone uses connections + dialogs)
 *  - the top-level layout JSX
 */
function App() {
  const view = useViewStore((s) => s.view);
  const setView = useViewStore((s) => s.setView);

  const [searchQuery, setSearchQuery] = React.useState("");

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
  const { status: gitSyncStatus, fetchStatus: fetchGitSyncStatus } =
    useGitSyncStore();

  // Dialog/UI state
  const dialogs = useDialogsStore();

  // Terminal & tunnel session state
  const tabs = useTerminalsStore((s) => s.tabs);
  const activeTabId = useTerminalsStore((s) => s.activeTabId);
  const setActiveTabId = useTerminalsStore((s) => s.setActiveTabId);
  const connect = useTerminalsStore((s) => s.connect);
  const closePane = useTerminalsStore((s) => s.closePane);
  const closeTab = useTerminalsStore((s) => s.closeTab);
  const selectTabByIndex = useTerminalsStore((s) => s.selectTabByIndex);
  const tunnelSessions = useTunnelsStore((s) => s.sessions);
  const closeTunnel = useTunnelsStore((s) => s.closeTunnel);

  useApplySettings(settings);

  useEffect(() => {
    fetchConnections();
    fetchCredentials();
    fetchSettings();
    fetchGitSyncStatus();
  }, []);

  // Re-fetch git-sync status whenever the data we'd serialize changes.
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

  // Custom right-click menu wiring. The dispatcher lives in a global
  // contextmenu listener so xterm.js panes can still own the paste flow.
  useEffect(() => {
    const handler = (e: Event) => {
      const { x, y } = (e as CustomEvent<{ x: number; y: number }>).detail;
      dialogs.setContextMenu({ x, y });
    };
    window.addEventListener("ssx:contextmenu", handler);
    return () => window.removeEventListener("ssx:contextmenu", handler);
  }, [dialogs]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Element;
      if (target.closest("input, textarea, [contenteditable]")) return;
      e.preventDefault();
      if (target.closest(".xterm-screen, .xterm-rows")) {
        navigator.clipboard
          .readText()
          .then((text) => {
            if (text) {
              window.dispatchEvent(
                new CustomEvent("ssx:terminal-paste", { detail: { text } }),
              );
            }
          })
          .catch(() => {});
        return;
      }
      window.dispatchEvent(
        new CustomEvent("ssx:contextmenu", {
          detail: { x: e.clientX, y: e.clientY },
        }),
      );
    };
    document.addEventListener("contextmenu", handler);
    return () => document.removeEventListener("contextmenu", handler);
  }, []);

  /* ---------------------------- Submit handlers ---------------------------- */

  const handleTakeScreenshot = async () => {
    try {
      const path = await takeScreenshot();
      dialogs.setScreenshotToast(path);
      setTimeout(() => dialogs.setScreenshotToast(null), 4000);
    } catch {
      dialogs.setScreenshotToast("Screenshot failed.");
      setTimeout(() => dialogs.setScreenshotToast(null), 3000);
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
    dialogs.setConfirmDeleteConn(conn);
  };

  const performDeleteConnection = async (id: string) => {
    const orphanCredId = await getOrphanPrivateCredential(id);
    if (orphanCredId) {
      dialogs.setOrphanCredDialog({ connId: id, credId: orphanCredId });
    } else {
      await deleteConnection(id);
    }
  };

  const handleOrphanCredDialogConfirm = async (deleteCredToo: boolean) => {
    const payload = dialogs.orphanCredDialog;
    if (!payload) return;
    dialogs.setOrphanCredDialog(null);
    await deleteConnection(payload.connId);
    if (deleteCredToo) {
      await deleteCredential(payload.credId);
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
    if (dialogs.cloningConn) {
      await cloneConnection(dialogs.cloningConn.id, data.name, {
        host: data.host,
        port: data.port,
        credential_id: data.credential_id,
      });
    }
  };

  const handleCreateCredential = async (
    data: Omit<Credential, "id">,
  ): Promise<Credential> => {
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

  /* ---------------------- Terminal-driven side effects ---------------------- */

  const handleEditFromTerminal = (
    conn: Connection,
    failedSessionId: string,
  ) => {
    void closePane(failedSessionId);
    dialogs.openEditConnection(conn);
    setView("connections");
  };

  /**
   * Show a confirmation before closing a live (non-failed) pane.
   * Failed/retrying panes never opened a real shell, so they close
   * immediately without prompting.
   */
  const handleClosePaneRequest = (sessionId: string) => {
    for (const tab of tabs) {
      const pane = tab.panes.find((p) => p.sessionId === sessionId);
      if (!pane) continue;
      if (pane.error || pane.retrying) {
        void closePane(sessionId);
        return;
      }
      dialogs.setConfirmClosePane({ sessionId, name: pane.connectionName });
      return;
    }
  };

  const handleCloseTabRequest = (tabId: string) => {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const liveCount = tab.panes.filter((p) => !p.error).length;
    if (liveCount === 0) {
      void closeTab(tabId);
      return;
    }
    if (tab.panes.length === 1) {
      dialogs.setConfirmClosePane({
        sessionId: tab.panes[0].sessionId,
        name: tab.panes[0].connectionName,
      });
      return;
    }
    // Multi-pane tab: stash all session IDs as a synthetic confirm
    // keyed by `__tab__:<tabId>` so the confirm dialog's onConfirm
    // can route to closeTab(tabId).
    dialogs.setConfirmClosePane({
      sessionId: `__tab__:${tabId}`,
      name: tab.panes.map((p) => p.connectionName).join(" + "),
    });
  };

  /* ----------------------------- Layout helpers ----------------------------- */

  const updateLayout = (
    key: "connection_layout" | "credential_layout" | "tunnel_layout",
    value: LayoutMode,
  ) => {
    void saveSettings({ ...settings, [key]: value }).catch((error) => {
      appLog.error(
        "settings",
        `Failed to save layout settings: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  };

  const totalShellSessions = tabs.reduce((n, t) => n + t.panes.length, 0);
  const gitPending =
    gitSyncStatus.has_local_changes || gitSyncStatus.has_remote_changes;

  // Global keyboard shortcuts — closures rebuild each render so they
  // see fresh state without needing refs.
  useGlobalShortcuts({
    "mod+k": () => dialogs.setPickerOpen(true),
    "mod+n": () => dialogs.openNewConnection(),
    "mod+,": () => setView("settings"),
    "mod+w": () => {
      if (view !== "terminals" || !activeTabId) return;
      handleCloseTabRequest(activeTabId);
    },
    "mod+1": () => selectTabByIndex(0),
    "mod+2": () => selectTabByIndex(1),
    "mod+3": () => selectTabByIndex(2),
    "mod+4": () => selectTabByIndex(3),
    "mod+5": () => selectTabByIndex(4),
    "mod+6": () => selectTabByIndex(5),
    "mod+7": () => selectTabByIndex(6),
    "mod+8": () => selectTabByIndex(7),
    "mod+9": () => selectTabByIndex(8),
  });

  return (
    <div className="flex flex-col h-screen bg-background text-foreground overflow-hidden">
      <TitleBar
        onSettings={() => setView("settings")}
        settingsActive={view === "settings"}
      />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          active={view}
          onNavigate={(v) => setView(v)}
          terminalCount={totalShellSessions}
          tunnelCount={tunnelSessions.length}
          gitPending={gitPending}
        />

        <main className="flex-1 flex flex-col overflow-hidden">
          {view === "terminals" && tabs.length > 0 ? (
            <TerminalTabs
              tabs={tabs}
              activeTabId={activeTabId}
              onSelectTab={setActiveTabId}
              onCloseTab={handleCloseTabRequest}
              onClosePane={(_tabId, sessionId) =>
                handleClosePaneRequest(sessionId)
              }
              onNewTab={(mode) => dialogs.openPicker(mode)}
              onRetry={(conn, replaceSessionId) =>
                void connect(conn, { replaceSessionId })
              }
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
                      <Button size="sm" onClick={() => dialogs.openNewConnection()}>
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
                      onEdit={(conn) => dialogs.openEditConnection(conn)}
                      onDelete={handleDeleteConnection}
                      onClone={(conn) => dialogs.openCloneConnection(conn)}
                      onConnect={(c) => void connect(c)}
                      onScp={(conn) => dialogs.openScp(conn)}
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
                      <Button size="sm" onClick={() => dialogs.openNewCredential()}>
                        <Plus className="h-4 w-4 mr-1" />
                        New Credential
                      </Button>
                    </div>
                  </div>
                  <div className="flex-1 overflow-y-auto px-4 py-2">
                    <CredentialList
                      credentials={credentials}
                      layout={settings.credential_layout}
                      onEdit={(cred) => dialogs.openEditCredential(cred)}
                      onDelete={(id) => {
                        const cred = credentials.find((c) => c.id === id);
                        if (cred) dialogs.setConfirmDeleteCred(cred);
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
                  onCloseSession={closeTunnel}
                  onConnect={(c) => void connect(c)}
                  onEdit={(conn) => {
                    dialogs.openEditConnection(conn);
                    setView("connections");
                  }}
                  onDelete={handleDeleteConnection}
                  onClone={(conn) => {
                    dialogs.openCloneConnection(conn);
                    setView("connections");
                  }}
                />
              )}

              {view === "logs" && (
                <Suspense fallback={<ViewFallback label="Loading logs…" />}>
                  <LogsView />
                </Suspense>
              )}
              {view === "git_sync" && (
                <Suspense fallback={<ViewFallback label="Loading git sync…" />}>
                  <GitSyncView />
                </Suspense>
              )}
              {view === "settings" && (
                <Suspense fallback={<ViewFallback label="Loading settings…" />}>
                  <div className="flex-1 overflow-y-auto">
                    <SettingsPanel settings={settings} onSave={saveSettings} />
                  </div>
                </Suspense>
              )}
            </>
          )}
        </main>
      </div>

      {/* Quick connect picker (Cmd+K, "+ tab") */}
      <ConnectPicker
        open={dialogs.pickerOpen}
        onOpenChange={dialogs.setPickerOpen}
        connections={connections}
        credentials={credentials}
        onConnect={(conn) => void connect(conn, { mode: dialogs.pickerMode })}
      />

      <Suspense fallback={null}>
        <ScpDialog
          open={dialogs.scpOpen}
          onOpenChange={dialogs.setScpOpen}
          connection={dialogs.scpConnection}
        />
      </Suspense>

      {/* Custom context menu */}
      {dialogs.contextMenu && (
        <ContextMenu
          position={dialogs.contextMenu}
          onClose={() => dialogs.setContextMenu(null)}
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
      {dialogs.screenshotToast && (
        <div className="fixed bottom-4 right-4 z-[9999] bg-popover border rounded-md shadow-lg px-4 py-2 text-sm max-w-xs truncate">
          📸 Saved: {dialogs.screenshotToast}
        </div>
      )}

      <ConfirmDialog
        open={!!dialogs.confirmDeleteConn}
        onOpenChange={(o) => !o && dialogs.setConfirmDeleteConn(null)}
        title="Delete connection?"
        description={
          dialogs.confirmDeleteConn ? (
            <>
              Permanently delete <strong>{dialogs.confirmDeleteConn.name}</strong>?
              This cannot be undone.
            </>
          ) : null
        }
        confirmLabel="Delete connection"
        variant="destructive"
        onConfirm={async () => {
          if (dialogs.confirmDeleteConn) {
            await performDeleteConnection(dialogs.confirmDeleteConn.id);
          }
        }}
      />

      <ConfirmDialog
        open={!!dialogs.confirmDeleteCred}
        onOpenChange={(o) => !o && dialogs.setConfirmDeleteCred(null)}
        title="Delete credential?"
        description={
          dialogs.confirmDeleteCred ? (
            <>
              Delete credential <strong>{dialogs.confirmDeleteCred.name}</strong>?
              Connections that reference it will lose their saved
              authentication.
            </>
          ) : null
        }
        confirmLabel="Delete credential"
        variant="destructive"
        onConfirm={async () => {
          if (dialogs.confirmDeleteCred) {
            await deleteCredential(dialogs.confirmDeleteCred.id);
          }
        }}
      />

      <ConfirmDialog
        open={!!dialogs.confirmClosePane}
        onOpenChange={(o) => !o && dialogs.setConfirmClosePane(null)}
        title="Close terminal?"
        description={
          dialogs.confirmClosePane ? (
            <>
              The session for <strong>{dialogs.confirmClosePane.name}</strong> will
              be disconnected. Any unsaved work in the shell will be lost.
            </>
          ) : null
        }
        confirmLabel="Close"
        variant="destructive"
        onConfirm={async () => {
          const payload = dialogs.confirmClosePane;
          if (!payload) return;
          if (payload.sessionId.startsWith("__tab__:")) {
            const tabId = payload.sessionId.slice("__tab__:".length);
            await closeTab(tabId);
          } else {
            await closePane(payload.sessionId);
          }
        }}
      />

      {/* Orphaned private credential prompt */}
      <Dialog
        open={!!dialogs.orphanCredDialog}
        onOpenChange={(open) => {
          if (!open) dialogs.setOrphanCredDialog(null);
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
            <Button variant="ghost" onClick={() => dialogs.setOrphanCredDialog(null)}>
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
       * ConnectionForm and CredentialForm are mounted at the App root
       * so they are reachable from any view (Cmd+N opens the
       * connection form even from Logs / Settings / Tunnels). Keeping
       * them in the per-view branches caused the dialog to mount in
       * the same render that switched view, which felt laggy and
       * dropped any in-progress draft if the user navigated away.
       */}
      <ConnectionForm
        open={dialogs.connFormOpen}
        onOpenChange={dialogs.setConnFormOpen}
        connection={dialogs.cloningConn ?? dialogs.editingConn}
        credentials={credentials}
        onSubmit={dialogs.cloningConn ? handleCloneSubmit : handleConnSubmit}
        onCreateCredential={handleCreateCredential}
        isClone={!!dialogs.cloningConn}
      />
      <CredentialForm
        open={dialogs.credFormOpen}
        onOpenChange={dialogs.setCredFormOpen}
        credential={dialogs.editingCred}
        onSubmit={handleCredSubmit}
      />
    </div>
  );
}

export default App;
