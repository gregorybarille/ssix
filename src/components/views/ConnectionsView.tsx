import React, { Suspense, lazy } from "react";
import { Plus } from "lucide-react";
import { ConnectionList } from "../ConnectionList";
import { ConnectionForm } from "../ConnectionForm";
import { SearchBar } from "../SearchBar";
import { LayoutToggle } from "../ui/layout-toggle";
import { Button } from "../ui/button";
import { ViewFallback } from "../ViewFallback";
import { useShallow } from "zustand/react/shallow";
import { useDialogsStore } from "@/store/useDialogsStore";
import { filterConnections } from "@/lib/search";
import type { TagGroup } from "@/lib/tags";
import type { AppSettings, Connection, ConnectionInput, Credential, LayoutMode } from "@/types";

const TagGroupGrid = lazy(() =>
  import("../TagGroupGrid").then((m) => ({ default: m.TagGroupGrid })),
);

interface ConnectionsViewProps {
  connections: Connection[];
  credentials: Credential[];
  settings: AppSettings;
  onLayoutChange: (layout: LayoutMode) => void;
  onSubmit: (data: ConnectionInput | Connection) => Promise<void>;
  onCloneSubmit: (data: ConnectionInput | Connection) => Promise<void>;
  onCreateCredential: (data: Omit<Credential, "id">) => Promise<Credential>;
  onDelete: (id: string) => void;
  onConnect: (conn: Connection) => void;
  onConnectAllInTag: (group: TagGroup) => void;
  onScpAllInTag: (group: TagGroup) => void;
}

/**
 * The Connections tab: header with layout toggle, the inline
 * connection form when it is open, otherwise the search bar and either
 * the list/grid or the tag-group view.
 */
export function ConnectionsView({
  connections,
  credentials,
  settings,
  onLayoutChange,
  onSubmit,
  onCloneSubmit,
  onCreateCredential,
  onDelete,
  onConnect,
  onConnectAllInTag,
  onScpAllInTag,
}: ConnectionsViewProps) {
  const dialogs = useDialogsStore(
    useShallow((s) => ({
      connFormOpen: s.connFormOpen,
      editingConn: s.editingConn,
      cloningConn: s.cloningConn,
      openNewConnection: s.openNewConnection,
      setConnFormOpen: s.setConnFormOpen,
      openEditConnection: s.openEditConnection,
      openCloneConnection: s.openCloneConnection,
      openScp: s.openScp,
    })),
  );
  const [searchQuery, setSearchQuery] = React.useState("");

  // Search is a pure filter over the loaded list; the tag-groups view
  // filters tag labels itself and always receives every connection.
  const visibleConnections = React.useMemo(
    () => filterConnections(connections, searchQuery),
    [connections, searchQuery],
  );

  return (
    <>
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <h1 className="text-lg font-semibold">Connections</h1>
        <div className="flex items-center gap-2">
          <LayoutToggle value={settings.connection_layout} onChange={onLayoutChange} showTags />
          <Button
            size="sm"
            onClick={() => dialogs.openNewConnection()}
            data-testid="add-connection-button"
          >
            <Plus className="h-4 w-4 mr-1" aria-hidden="true" />
            New Connection
          </Button>
        </div>
      </div>
      {dialogs.connFormOpen ? (
        <ConnectionForm
          inline
          open={dialogs.connFormOpen}
          onOpenChange={dialogs.setConnFormOpen}
          connection={dialogs.cloningConn ?? dialogs.editingConn}
          credentials={credentials}
          onSubmit={dialogs.cloningConn ? onCloneSubmit : onSubmit}
          onCreateCredential={onCreateCredential}
          isClone={!!dialogs.cloningConn}
        />
      ) : (
        <>
          <div className="px-6 py-3 border-b border-border">
            <SearchBar
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder={settings.connection_layout === "tags" ? "Search tags…" : undefined}
            />
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-2">
            {settings.connection_layout === "tags" ? (
              <Suspense fallback={<ViewFallback label="Loading tags…" />}>
                <TagGroupGrid
                  connections={connections}
                  query={searchQuery}
                  onConnectAll={onConnectAllInTag}
                  onScpAll={onScpAllInTag}
                />
              </Suspense>
            ) : (
              <ConnectionList
                connections={visibleConnections}
                credentials={credentials}
                layout={settings.connection_layout}
                onEdit={(conn) => dialogs.openEditConnection(conn)}
                onDelete={onDelete}
                onClone={(conn) => dialogs.openCloneConnection(conn)}
                onConnect={onConnect}
                onScp={(conn) => dialogs.openScp(conn)}
              />
            )}
          </div>
        </>
      )}
    </>
  );
}
