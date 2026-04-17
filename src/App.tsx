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
  const [connectError, setConnectError] = useState<string | null>(null);
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

  const handleConnect = async (conn: Connection) => {
    setConnectError(null);
    try {
      const sessionId = await invoke<string>("ssh_connect", {
        connection_id: conn.id,
      });
      const newSession: TerminalSession = { sessionId, connectionName: conn.name };
      setSessions((prev) => [...prev, newSession]);
      setActiveTabId(sessionId);
      setView("terminals");
    } catch (err) {
      setConnectError(String(err));
    }
  };

  const handleCloseTab = async (sessionId: string) => {
    try {
      await invoke("ssh_disconnect", { session_id: sessionId });
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
            {connectError && (
              <div className="mx-6 mt-3 px-3 py-2 rounded-md bg-destructive/10 text-destructive text-sm">
                {connectError}
              </div>
            )}
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
