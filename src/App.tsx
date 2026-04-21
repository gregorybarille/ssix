import React, { useEffect, useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { TitleBar } from "./components/TitleBar";
import { ConnectionList } from "./components/ConnectionList";
import { ConnectionForm } from "./components/ConnectionForm";
import { CredentialList } from "./components/CredentialList";
import { CredentialForm } from "./components/CredentialForm";
import { SettingsPanel } from "./components/SettingsPanel";
import { SearchBar } from "./components/SearchBar";
import { TerminalTabs, TerminalSession } from "./components/TerminalTabs";
import { ConnectPicker } from "./components/ConnectPicker";
import { Button } from "./components/ui/button";
import { useConnectionsStore } from "./store/useConnectionsStore";
import { useCredentialsStore } from "./store/useCredentialsStore";
import { useSettingsStore } from "./store/useSettingsStore";
import { useApplySettings } from "./hooks/useApplySettings";
import { invoke } from "./lib/tauri";
import { Connection, Credential } from "./types";
import { Plus } from "lucide-react";

type View = "connections" | "credentials" | "settings" | "terminals";

function App() {
  const [view, setView] = useState<View>("connections");
  const [connFormOpen, setConnFormOpen] = useState(false);
  const [credFormOpen, setCredFormOpen] = useState(false);
  const [editingConn, setEditingConn] = useState<Connection | null>(null);
  const [editingCred, setEditingCred] = useState<Credential | null>(null);
  const [cloningConn, setCloningConn] = useState<Connection | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  // Placeholder IDs the user cancelled while ssh_connect was still in flight.
  // We keep them in a ref so the async handler can check after awaiting.
  const cancelledRef = React.useRef<Set<string>>(new Set());
  const [pickerOpen, setPickerOpen] = useState(false);

  const {
    connections,
    fetchConnections,
    addConnection,
    updateConnection,
    deleteConnection,
    cloneConnection,
    searchConnections,
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

  const handleConnSubmit = async (data: Omit<Connection, "id"> | Connection) => {
    if ("id" in data) {
      await updateConnection(data as Connection);
    } else {
      await addConnection(data);
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

  const handleConnect = async (conn: Connection, replaceSessionId?: string) => {
    const failedId = replaceSessionId ?? `failed-${conn.id}-${Date.now()}`;

    if (!replaceSessionId) {
      // First attempt: open a tab immediately and switch to terminals view.
      setSessions((prev) => [
        ...prev,
        { sessionId: failedId, connectionName: conn.name, connection: conn, retrying: true },
      ]);
      setActiveTabId(failedId);
      setView("terminals");
    } else {
      // Retry: mark the existing tab as retrying so the button spins.
      setSessions((prev) =>
        prev.map((s) =>
          s.sessionId === replaceSessionId ? { ...s, retrying: true } : s
        )
      );
    }

    try {
      const sessionId = await invoke<string>("ssh_connect", {
        connectionId: conn.id,
      });
      // If the user cancelled while ssh_connect was in flight, disconnect the
      // now-orphan backend session and leave UI state alone.
      if (cancelledRef.current.has(failedId)) {
        cancelledRef.current.delete(failedId);
        invoke("ssh_disconnect", { sessionId }).catch(() => {});
        return;
      }
      // Success: replace the placeholder/failed tab with a live session.
      setSessions((prev) =>
        prev.map((s) =>
          s.sessionId === failedId ? { sessionId, connectionName: conn.name, connection: conn } : s
        )
      );
      setActiveTabId(sessionId);
    } catch (err) {
      if (cancelledRef.current.has(failedId)) {
        cancelledRef.current.delete(failedId);
        return;
      }
      // Failure: populate or update the error, clear retrying.
      setSessions((prev) =>
        prev.map((s) =>
          s.sessionId === failedId
            ? { ...s, error: String(err), retrying: false }
            : s
        )
      );
      setActiveTabId(failedId);
    }
  };

  const handleRetry = (conn: Connection, replaceSessionId: string) => {
    handleConnect(conn, replaceSessionId);
  };

  const handleEditFromTerminal = (conn: Connection, failedSessionId: string) => {
    // Close the failed tab and open the connection form.
    handleCloseTab(failedSessionId);
    setEditingConn(conn);
    setCloningConn(null);
    setConnFormOpen(true);
    setView("connections");
  };

  const handleCloseTab = async (sessionId: string) => {
    // If this is a placeholder session that's still connecting, mark it
    // cancelled so handleConnect's resolve path cleans up any backend session
    // that arrives after the user has closed the tab.
    const session = sessions.find((s) => s.sessionId === sessionId);
    if (session?.retrying && !session.error) {
      cancelledRef.current.add(sessionId);
    }
    try {
      await invoke("ssh_disconnect", { sessionId });
    } catch {
      // ignore
    }
    setSessions((prev) => {
      const remaining = prev.filter((s) => s.sessionId !== sessionId);
      // If we closed the active tab, switch to the last remaining or go back to connections
      if (activeTabId === sessionId) {
        if (remaining.length > 0) {
          setActiveTabId(remaining[remaining.length - 1].sessionId);
        } else {
          setActiveTabId(null);
          setView("connections");
        }
      }
      return remaining;
    });
  };

  const handleNewTabFromTerminal = () => {
    setPickerOpen(true);
  };

  return (
    <div className="flex flex-col h-screen bg-background text-foreground overflow-hidden">
      <TitleBar onSettings={() => setView("settings")} settingsActive={view === "settings"} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          active={view}
          onNavigate={(v) => setView(v as View)}
          terminalCount={sessions.length}
        />

        <main className="flex-1 flex flex-col overflow-hidden">
        {view === "terminals" && sessions.length > 0 ? (
          <TerminalTabs
            sessions={sessions}
            activeTabId={activeTabId}
            onSelectTab={setActiveTabId}
            onCloseTab={handleCloseTab}
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
                onEdit={(conn) => {
                  setEditingConn(conn);
                  setCloningConn(null);
                  setConnFormOpen(true);
                }}
                onDelete={deleteConnection}
                onClone={(conn) => {
                  setCloningConn(conn);
                  setEditingConn(null);
                  setConnFormOpen(true);
                }}
                onConnect={handleConnect}
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
            <div className="flex-1 overflow-y-auto px-4 py-2">
              <CredentialList
                credentials={credentials}
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
        onConnect={handleConnect}
      />
    </div>
  );
}

export default App;
