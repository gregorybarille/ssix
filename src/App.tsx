import React, { useEffect, useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { ConnectionList } from "./components/ConnectionList";
import { ConnectionForm } from "./components/ConnectionForm";
import { CredentialList } from "./components/CredentialList";
import { CredentialForm } from "./components/CredentialForm";
import { SettingsPanel } from "./components/SettingsPanel";
import { SearchBar } from "./components/SearchBar";
import { Button } from "./components/ui/button";
import { useConnectionsStore } from "./store/useConnectionsStore";
import { useCredentialsStore } from "./store/useCredentialsStore";
import { useSettingsStore } from "./store/useSettingsStore";
import { Connection, Credential } from "./types";
import { Plus } from "lucide-react";

type View = "connections" | "credentials" | "settings";

function App() {
  const [view, setView] = useState<View>("connections");
  const [connFormOpen, setConnFormOpen] = useState(false);
  const [credFormOpen, setCredFormOpen] = useState(false);
  const [editingConn, setEditingConn] = useState<Connection | null>(null);
  const [editingCred, setEditingCred] = useState<Credential | null>(null);
  const [cloningConn, setCloningConn] = useState<Connection | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

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

  const handleSearch = (query: string) => {
    setSearchQuery(query);
    if (query) {
      searchConnections(query);
    } else {
      fetchConnections();
    }
  };

  return (
    <div className="flex h-screen bg-background text-foreground overflow-hidden">
      <Sidebar active={view} onNavigate={(v) => setView(v as View)} />

      <main className="flex-1 flex flex-col overflow-hidden">
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
      </main>
    </div>
  );
}

export default App;
