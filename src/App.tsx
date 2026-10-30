import { ErrorBanner } from "./components/ui/error-banner";
import { errorMessage } from "@/lib/errors";
import React, { Suspense, useEffect, lazy } from "react";
import { Sidebar } from "./components/Sidebar";
import { TitleBar } from "./components/TitleBar";
import { TerminalTabs } from "./components/TerminalTabs";
import { PortForwardsView } from "./components/PortForwardsView";
import { ConnectionsView } from "./components/views/ConnectionsView";
import { CredentialsView } from "./components/views/CredentialsView";
import { PanelSlot, PanelSlotProvider } from "./components/ui/panel-slot";
import { ConnectPicker } from "./components/ConnectPicker";
import { ContextMenu } from "./components/ContextMenu";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ScreenshotToast } from "./components/ScreenshotToast";
import { ViewFallback } from "./components/ViewFallback";
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
import { useViewStore } from "./store/useViewStore";
import { useDialogsStore } from "./store/useDialogsStore";
import { useTerminalsStore } from "./store/useTerminalsStore";
import { usePortForwardsStore } from "./store/usePortForwardsStore";
import { useApplySettings } from "./hooks/useApplySettings";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts";
import { useScreenshotToast } from "./hooks/useScreenshotToast";
import { useShallow } from "zustand/react/shallow";
import { log as appLog } from "./lib/log";
import { Connection, ConnectionInput, Credential, LayoutMode } from "./types";
import { connectMany } from "./lib/bulk-actions";
import type { TagGroup } from "./lib/tags";

/**
 * Settings, Git-Sync, Logs and the SCP dialogs are leaf views the user
 * opens infrequently and that pull in sizeable component trees.
 * Lazy-loading them keeps the initial bundle small and shifts their
 * cost to first use.
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
const BulkScpDialog = lazy(() =>
  import("./components/BulkScpDialog").then((m) => ({ default: m.BulkScpDialog })),
);

/**
 * App is the composition layer. Terminal pane lifecycle, port forward session
 * lifecycle, dialog UI state and the current view live in dedicated
 * Zustand stores; the Connections and Credentials tabs are their own
 * components under `components/views/`. App owns only:
 *
 *  - cross-store submit handlers (e.g. clone uses connections + dialogs)
 *  - terminal-driven side effects (close/edit from a pane)
 *  - the top-level layout and the app-wide dialogs
 */
function App() {
  const view = useViewStore((s) => s.view);
  const setView = useViewStore((s) => s.setView);

  // Select only what App renders. Store actions are stable, so these
  // shallow selectors keep `isLoading`/`error` flips in the stores from
  // re-rendering the whole shell.
  const {
    connections,
    fetchConnections,
    addConnection,
    updateConnection,
    deleteConnection,
    cloneConnection,
    getOrphanPrivateCredential,
  } = useConnectionsStore(
    useShallow((s) => ({
      connections: s.connections,
      fetchConnections: s.fetchConnections,
      addConnection: s.addConnection,
      updateConnection: s.updateConnection,
      deleteConnection: s.deleteConnection,
      cloneConnection: s.cloneConnection,
      getOrphanPrivateCredential: s.getOrphanPrivateCredential,
    })),
  );

  const {
    credentials,
    fetchCredentials,
    addCredential,
    addInlineCredential,
    updateCredential,
    deleteCredential,
  } = useCredentialsStore(
    useShallow((s) => ({
      credentials: s.credentials,
      fetchCredentials: s.fetchCredentials,
      addCredential: s.addCredential,
      addInlineCredential: s.addInlineCredential,
      updateCredential: s.updateCredential,
      deleteCredential: s.deleteCredential,
    })),
  );

  const { settings, settingsLoadError, fetchSettings, saveSettings } = useSettingsStore(
    useShallow((s) => ({
      settings: s.settings,
      settingsLoadError: s.error,
      fetchSettings: s.fetchSettings,
      saveSettings: s.saveSettings,
    })),
  );
  const { status: gitSyncStatus, fetchStatus: fetchGitSyncStatus } = useGitSyncStore(
    useShallow((s) => ({ status: s.status, fetchStatus: s.fetchStatus })),
  );
  const [previewSettings, setPreviewSettings] = React.useState<typeof settings | null>(null);

  // Dialog/UI state
  // The connection / credential form fields are read by their views only;
  // leaving them out keeps the shell from re-rendering while a form opens.
  const dialogs = useDialogsStore(
    useShallow(({ connFormOpen, editingConn, credFormOpen, editingCred, ...shell }) => shell),
  );
  const captureScreenshot = useScreenshotToast();

  // Terminal & port forward session state
  const tabs = useTerminalsStore((s) => s.tabs);
  const activeTabId = useTerminalsStore((s) => s.activeTabId);
  const setActiveTabId = useTerminalsStore((s) => s.setActiveTabId);
  const connect = useTerminalsStore((s) => s.connect);
  const closePane = useTerminalsStore((s) => s.closePane);
  const closeTab = useTerminalsStore((s) => s.closeTab);
  const selectTabByIndex = useTerminalsStore((s) => s.selectTabByIndex);
  const forwardSessions = usePortForwardsStore((s) => s.sessions);
  const stopForward = usePortForwardsStore((s) => s.stopForward);

  useApplySettings(previewSettings ?? settings);

  useEffect(() => {
    if (view !== "settings" && previewSettings) {
      setPreviewSettings(null);
    }
  }, [previewSettings, view]);

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
    window.addEventListener("ssix:contextmenu", handler);
    return () => window.removeEventListener("ssix:contextmenu", handler);
  }, [dialogs]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Element;
      if (target.closest("input, textarea, [contenteditable]")) return;
      e.preventDefault();
      if (target.closest(".xterm-screen, .xterm-rows")) {
        const sessionId = target.closest<HTMLElement>("[data-session-id]")?.dataset.sessionId;
        navigator.clipboard
          .readText()
          .then((text) => {
            if (text) {
              window.dispatchEvent(
                new CustomEvent("ssix:terminal-paste", { detail: { text, sessionId } }),
              );
            }
          })
          .catch(() => {});
        return;
      }
      window.dispatchEvent(
        new CustomEvent("ssix:contextmenu", {
          detail: { x: e.clientX, y: e.clientY },
        }),
      );
    };
    document.addEventListener("contextmenu", handler);
    return () => document.removeEventListener("contextmenu", handler);
  }, []);

  /* ---------------------------- Submit handlers ---------------------------- */

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
    try {
      await deleteConnection(payload.connId);
      if (deleteCredToo) {
        await deleteCredential(payload.credId);
      }
    } catch (error) {
      appLog.error(
        "connections",
        `Failed to delete connection: ${errorMessage(error)}`,
      );
    }
  };

  const handleCredSubmit = async (data: Omit<Credential, "id"> | Credential) => {
    if ("id" in data) {
      await updateCredential(data as Credential);
    } else {
      await addCredential(data);
    }
  };

  // The clone form submits a whole new connection; every field it shows
  // (kind, jump host, tags, …) is saved, not only name, host and port.
  const handleCloneSubmit = async (data: ConnectionInput | Connection) => {
    if (dialogs.cloningConn) {
      await cloneConnection(dialogs.cloningConn.id, data);
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

  /**
   * Bulk actions on a tag group always go through a confirmation,
   * regardless of host count: "Connect all" can spawn dozens of SSH
   * sessions and bulk SCP is hard to interrupt cleanly. The confirm
   * handler runs `connectMany` (sequential so tabs appear in order) or
   * opens the bulk SCP dialog with the membership frozen at click time.
   */
  const handleConnectAllInTag = (group: TagGroup) => {
    dialogs.setConfirmTagAction({
      kind: "connect",
      label: group.label,
      connections: group.connections,
    });
  };
  const handleScpAllInTag = (group: TagGroup) => {
    dialogs.setConfirmTagAction({
      kind: "scp",
      label: group.label,
      connections: group.connections,
    });
  };

  /* ---------------------- Terminal-driven side effects ---------------------- */

  const handleEditFromTerminal = (conn: Connection, failedSessionId: string) => {
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
      dialogs.setConfirmClosePane({ kind: "pane", sessionId, name: pane.connectionName });
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
        kind: "pane",
        sessionId: tab.panes[0].sessionId,
        name: tab.panes[0].connectionName,
      });
      return;
    }
    dialogs.setConfirmClosePane({
      kind: "tab",
      tabId,
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
          errorMessage(error)
        }`,
      );
    });
  };

  const totalShellSessions = tabs.reduce((n, t) => n + t.panes.length, 0);
  const gitPending =
    gitSyncStatus.has_local_changes || gitSyncStatus.has_remote_changes;

  // Global keyboard shortcuts. The hook reads the latest map from a ref,
  // so these closures can be rebuilt each render and still see fresh state.
  useGlobalShortcuts({
    "mod+k": () => dialogs.setPickerOpen(true),
    "mod+n": () => {
      setView("connections");
      dialogs.openNewConnection();
    },
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
    <PanelSlotProvider>
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
            forwardCount={forwardSessions.length}
            gitPending={gitPending}
          />

          <main className="flex-1 flex flex-col overflow-hidden min-w-0 min-h-0">
            {view === "terminals" && tabs.length > 0 ? (
              <TerminalTabs
                tabs={tabs}
                activeTabId={activeTabId}
                onSelectTab={setActiveTabId}
                onCloseTab={handleCloseTabRequest}
                onClosePane={(_tabId, sessionId) => handleClosePaneRequest(sessionId)}
                onNewTab={(mode) => dialogs.openPicker(mode)}
                onRetry={(conn, replaceSessionId) => void connect(conn, { replaceSessionId })}
                onEdit={handleEditFromTerminal}
                settings={settings}
              />
            ) : (
              <>
                {view === "connections" && (
                  <ConnectionsView
                    connections={connections}
                    credentials={credentials}
                    settings={settings}
                    onLayoutChange={(v) => updateLayout("connection_layout", v)}
                    onSubmit={handleConnSubmit}
                    onCloneSubmit={handleCloneSubmit}
                    onCreateCredential={handleCreateCredential}
                    onDiscardCredential={deleteCredential}
                    onDelete={handleDeleteConnection}
                    onConnect={(c) => void connect(c)}
                    onConnectAllInTag={handleConnectAllInTag}
                    onScpAllInTag={handleScpAllInTag}
                  />
                )}

                {view === "credentials" && (
                  <CredentialsView
                    credentials={credentials}
                    settings={settings}
                    onLayoutChange={(v) => updateLayout("credential_layout", v)}
                    onSubmit={handleCredSubmit}
                  />
                )}

                {view === "forwards" && (
                  <PortForwardsView
                    sessions={forwardSessions}
                    connections={connections}
                    credentials={credentials}
                    onCloseSession={stopForward}
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
                    <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
                      {settingsLoadError && (
                        <div className="px-6 pt-6 max-w-lg">
                          <ErrorBanner
                            message={`Could not load settings, showing defaults: ${settingsLoadError}`}
                            onRetry={() => void fetchSettings()}
                            testId="settings-load-error"
                          />
                        </div>
                      )}
                      <SettingsPanel
                        settings={settings}
                        onSave={async (next) => {
                          await saveSettings(next);
                          setPreviewSettings(null);
                        }}
                        onPreview={setPreviewSettings}
                      />
                    </div>
                  </Suspense>
                )}
              </>
            )}
          </main>
          <PanelSlot />
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

        <Suspense fallback={null}>
          <BulkScpDialog
            open={dialogs.bulkScpOpen}
            onOpenChange={dialogs.setBulkScpOpen}
            connections={dialogs.bulkScpConnections}
            groupLabel={dialogs.bulkScpLabel}
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
                onClick: () => void captureScreenshot(),
              },
            ]}
          />
        )}

        <ScreenshotToast />

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
                A credential that connections still use cannot be deleted
                until they use another one.
              </>
            ) : null
          }
          confirmLabel="Delete credential"
          variant="destructive"
          testId="confirm-delete-credential"
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
            const target = dialogs.confirmClosePane;
            if (!target) return;
            if (target.kind === "tab") await closeTab(target.tabId);
            else await closePane(target.sessionId);
          }}
        />

        {/* Tag-group bulk action confirm (see handleConnectAllInTag). */}
        <ConfirmDialog
          open={!!dialogs.confirmTagAction}
          onOpenChange={(o) => !o && dialogs.setConfirmTagAction(null)}
          title={
            dialogs.confirmTagAction?.kind === "scp"
              ? "Transfer files to all?"
              : "Connect to all?"
          }
          description={
            dialogs.confirmTagAction ? (
              <>
                {dialogs.confirmTagAction.kind === "scp" ? (
                  <>
                    Open a bulk file transfer dialog for{" "}
                    <strong>{dialogs.confirmTagAction.connections.length}</strong>{" "}
                    connection
                    {dialogs.confirmTagAction.connections.length === 1 ? "" : "s"}{" "}
                    tagged{" "}
                    <strong>{dialogs.confirmTagAction.label}</strong>?
                  </>
                ) : (
                  <>
                    Open SSH sessions for{" "}
                    <strong>{dialogs.confirmTagAction.connections.length}</strong>{" "}
                    connection
                    {dialogs.confirmTagAction.connections.length === 1 ? "" : "s"}{" "}
                    tagged{" "}
                    <strong>{dialogs.confirmTagAction.label}</strong>?
                    Local forwards will be skipped.
                  </>
                )}
              </>
            ) : null
          }
          confirmLabel={
            dialogs.confirmTagAction?.kind === "scp"
              ? "Open transfer dialog"
              : "Connect all"
          }
          testId="confirm-tag-action"
          onConfirm={async () => {
            const payload = dialogs.confirmTagAction;
            if (!payload) return;
            if (payload.kind === "connect") {
              await connectMany(payload.connections);
            } else {
              dialogs.openBulkScp(payload.label, payload.connections);
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
          <DialogContent kind="confirm">
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
                onClick={() => void handleOrphanCredDialogConfirm(false)}
              >
                Delete connection only
              </Button>
              <Button
                variant="destructive"
                onClick={() => void handleOrphanCredDialogConfirm(true)}
              >
                Delete connection and credential
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </PanelSlotProvider>
  );
}

export default App;
