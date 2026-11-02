import React from "react";
import { ChevronRight, Edit, Folder, FolderOpen, Server, Trash2 } from "lucide-react";
import { useRovingFocus } from "@/hooks/useRovingFocus";
import { usePointerDrag } from "@/hooks/usePointerDrag";
import { errorMessage } from "@/lib/errors";
import {
  NO_FOLDER,
  buildFolderTree,
  collapsedAfterMove,
  collapsedWithRevealed,
  connectionRowKey,
  describeFolderContents,
  flattenFolderTree,
  folderContents,
  folderParent,
  folderRenameError,
  folderRowKey,
  knownFolderPaths,
  loadCollapsedFolders,
  parseFolderPath,
  pluralConnections,
  saveCollapsedFolders,
  typeaheadMatch,
  type FolderTreeFolderRow,
  type FolderTreeRow,
} from "@/lib/folders";
import { filterConnections, tokenize } from "@/lib/search";
import { isForwardConnection } from "@/lib/sshTerms";
import { cn } from "@/lib/utils";
import { useConnectionsStore } from "@/store/useConnectionsStore";
import type { Connection, Credential } from "@/types";
import { ConfirmDialog } from "./ConfirmDialog";
import { ConnectionRow, useConnectionRowMenu, type ConnectionRowActions } from "./ConnectionRow";
import { ContextMenu, useContextMenu, type ContextMenuItem } from "./ContextMenu";
import { FolderPicker } from "./FolderPicker";
import { Button } from "./ui/button";
import { DragChip } from "./ui/drag-chip";
import { EmptyState } from "./ui/EmptyState";
import { ErrorBanner } from "./ui/error-banner";
import { SingleFieldDialog } from "./ui/single-field-dialog";

interface FolderTreeProps extends Omit<ConnectionRowActions, "onMove"> {
  /** Every connection; the tree itself leaves out the forwards and what `query` rules out. */
  connections: Connection[];
  credentials: Credential[];
  /** The view's search text. */
  query: string;
}

/** How long type-ahead keeps adding keys to one word. */
const TYPEAHEAD_RESET_MS = 500;

/** The left edge of a row at `level`; the depth limit keeps this bounded. */
const indent = (level: number) => ({ marginLeft: (level - 1) * 16 });

const TREE_ROW_FOCUS =
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/** The folder a dragged row would land in at this point. */
function dropFolderAt(x: number, y: number): string | null {
  const row = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-folder]");
  return row?.dataset.dropFolder ?? null;
}

interface FolderRowProps extends Omit<React.ComponentProps<"div">, "onClick"> {
  row: FolderTreeFolderRow;
  isDropTarget: boolean;
  onToggle: () => void;
  onRename: () => void;
  onDelete: () => void;
}

function FolderRow({
  row,
  isDropTarget,
  onToggle,
  onRename,
  onDelete,
  style,
  ...rowProps
}: FolderRowProps) {
  const isSection = row.path === NO_FOLDER;
  const expandable = row.count > 0;
  const Icon = row.open && expandable ? FolderOpen : Folder;
  return (
    <div
      {...rowProps}
      role="treeitem"
      aria-level={row.level}
      aria-posinset={row.posInSet}
      aria-setsize={row.setSize}
      aria-expanded={expandable ? row.open : undefined}
      aria-label={`${row.label}, ${pluralConnections(row.count)}`}
      data-testid={isSection ? "folder-no-folder" : "folder-row"}
      data-name={isSection ? undefined : row.path}
      data-drop-folder={row.path}
      data-drop-target={isDropTarget || undefined}
      title={isSection ? undefined : row.path}
      style={{ ...style, ...indent(row.level) }}
      className={cn(
        "flex items-center gap-2 rounded-lg px-3 py-2 cursor-pointer transition-colors hover:bg-accent",
        TREE_ROW_FOCUS,
        isDropTarget && "bg-accent ring-2 ring-primary",
      )}
      onClick={(e) => e.detail <= 1 && onToggle()}
    >
      <ChevronRight
        className={cn(
          "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
          row.open && "rotate-90",
          !expandable && "invisible",
        )}
        aria-hidden="true"
      />
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className={cn("min-w-0 truncate text-sm font-medium", isSection && "text-muted-foreground")}>
        {row.label}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground-soft" data-testid="folder-count">
        {row.count}
      </span>
      {!isSection && (
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label={`Rename folder ${row.path}`}
            data-testid="folder-rename"
            onClick={(e) => {
              e.stopPropagation();
              onRename();
            }}
          >
            <Edit className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-destructive hover:text-destructive"
            aria-label={`Delete folder ${row.path}`}
            data-testid="folder-delete"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * The Folders layout: connections grouped by their folder path, as an ARIA
 * tree. A search opens every folder that holds a match and hides the rest, and
 * what it folds is forgotten with the search, so the viewer's remembered state
 * comes back untouched when it is cleared. See `docs/folders.md`.
 */
export function FolderTree({
  connections,
  credentials,
  query,
  onEdit,
  onDelete,
  onClone,
  onConnect,
  onScp,
  onBrowse,
}: FolderTreeProps) {
  const moveConnectionToFolder = useConnectionsStore((s) => s.moveConnectionToFolder);
  const renameFolder = useConnectionsStore((s) => s.renameFolder);
  const deleteFolder = useConnectionsStore((s) => s.deleteFolder);

  const [collapsed, setCollapsed] = React.useState(loadCollapsedFolders);
  const [foldedInSearch, setFoldedInSearch] = React.useState<{ query: string; paths: Set<string> }>(
    { query, paths: new Set() },
  );
  const [moving, setMoving] = React.useState<Connection | null>(null);
  const [renaming, setRenaming] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState<string | null>(null);
  const [moveError, setMoveError] = React.useState<string | null>(null);

  const shells = React.useMemo(
    () => connections.filter((connection) => !isForwardConnection(connection)),
    [connections],
  );
  const searching = tokenize(query).length > 0;
  const foldedPaths = foldedInSearch.query === query ? foldedInSearch.paths : null;
  const rows = React.useMemo(
    () =>
      flattenFolderTree(buildFolderTree(filterConnections(shells, query)), {
        isOpen: (path) => (searching ? !foldedPaths?.has(path) : !collapsed.has(path)),
        // An empty section is still a place to drop on; a search hides it
        // like every other folder with no match.
        keepEmptySection: !searching && shells.length > 0,
      }),
    [shells, query, searching, foldedPaths, collapsed],
  );
  const knownFolders = React.useMemo(() => knownFolderPaths(connections), [connections]);

  const updateCollapsed = (next: Set<string>) => {
    setCollapsed(next);
    saveCollapsedFolders(next);
  };

  const toggleFolder = (path: string) => {
    const flip = (paths: Set<string>) => {
      const next = new Set(paths);
      if (!next.delete(path)) next.add(path);
      return next;
    };
    if (searching) setFoldedInSearch({ query, paths: flip(foldedPaths ?? new Set()) });
    else updateCollapsed(flip(collapsed));
  };

  // A row whose folder is renamed or deleted loses its element, so the dialog's
  // own focus restore has nothing to return to.
  const focusAfterClose = React.useRef<string | null>(null);
  const latestRows = React.useRef<FolderTreeRow[]>(rows);
  latestRows.current = rows;

  const activateRow = (index: number) => {
    const row = rows[index];
    if (!row) return;
    if (row.kind === "folder") {
      if (row.count > 0) toggleFolder(row.path);
    } else {
      onConnect?.(row.connection);
    }
  };
  const roving = useRovingFocus({ itemCount: rows.length, onActivate: activateRow });

  const moveFocusTo = (index: number) => {
    roving.setFocusedIndex(index);
    queueMicrotask(() => roving.focusItem(index));
  };

  const closeAutoFocus = (event: Event) => {
    const key = focusAfterClose.current;
    focusAfterClose.current = null;
    if (key === null) return;
    const index = latestRows.current.findIndex((row) => row.key === key);
    event.preventDefault();
    moveFocusTo(Math.max(index, 0));
  };

  const typeahead = React.useRef({ text: "", at: 0 });

  const onTreeKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    const index = Number((e.target as HTMLElement).dataset.rovingIndex);
    const row = rows[index];
    // A key on a row's own buttons is theirs: they have no index.
    if (!row) return;

    const word = typeahead.current;
    const wordRunning = word.text !== "" && e.timeStamp - word.at <= TYPEAHEAD_RESET_MS;
    const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
    // Space activates a row, so it starts no word, but a name can have one in it.
    if (printable && (e.key !== " " || wordRunning)) {
      e.preventDefault();
      const text = (wordRunning ? word.text : "") + e.key;
      typeahead.current = { text, at: e.timeStamp };
      const match = typeaheadMatch(
        rows.map((other) => other.label),
        index,
        text,
      );
      if (match !== -1) moveFocusTo(match);
      return;
    }
    // Any other key ends the word, but for a Shift on its way to a capital.
    if (e.key !== "Shift") typeahead.current = { text: "", at: 0 };

    if (e.key === "ArrowRight") {
      e.preventDefault();
      if (row.kind !== "folder" || row.count === 0) return;
      if (row.open) moveFocusTo(index + 1);
      else toggleFolder(row.path);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (row.kind === "folder" && row.open && row.count > 0) {
        toggleFolder(row.path);
      } else if (row.parentKey !== null) {
        moveFocusTo(rows.findIndex((other) => other.key === row.parentKey));
      }
    } else {
      roving.onKeyDown(e);
    }
  };

  const actions: ConnectionRowActions = {
    onEdit,
    onDelete,
    onClone,
    onConnect,
    onScp,
    onBrowse,
    onMove: (connection) => setMoving(connection),
  };
  const { rowMenuProps, menu: rowMenu } = useConnectionRowMenu(credentials, actions);

  const folderMenu = useContextMenu();
  const [menuFolder, setMenuFolder] = React.useState<FolderTreeFolderRow | null>(null);
  const folderMenuItems = (row: FolderTreeFolderRow): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [];
    if (row.count > 0) {
      items.push({
        label: row.open ? "Collapse" : "Expand",
        icon: row.open ? <Folder className="h-3.5 w-3.5" /> : <FolderOpen className="h-3.5 w-3.5" />,
        onClick: () => toggleFolder(row.path),
      });
    }
    if (row.path !== NO_FOLDER) {
      items.push({ separator: true });
      items.push({
        label: "Rename folder…",
        icon: <Edit className="h-3.5 w-3.5" />,
        onClick: () => setRenaming(row.path),
      });
      items.push({
        label: "Delete folder…",
        icon: <Trash2 className="h-3.5 w-3.5" />,
        destructive: true,
        onClick: () => setDeleting(row.path),
      });
    }
    return items;
  };

  /** Show the folder a connection landed in, and the connection with it. */
  const reveal = (path: string | null) => updateCollapsed(collapsedWithRevealed(collapsed, path));

  const moveTo = async (connection: Connection, path: string | null) => {
    await moveConnectionToFolder(connection.id, path);
    reveal(path);
  };

  const drag = usePointerDrag<string>(dropFolderAt);

  const onDropOnFolder = (connection: Connection, target: string) => {
    setMoveError(null);
    const path = target === NO_FOLDER ? null : target;
    if (path === (connection.folder ?? null)) return;
    void moveTo(connection, path).catch((err: unknown) =>
      setMoveError(`Could not move ${connection.name}: ${errorMessage(err)}`),
    );
  };

  if (shells.length === 0) {
    return (
      <EmptyState
        icon={Server}
        title="No connections yet"
        hint="Create your first SSH connection"
      />
    );
  }

  const deletingContents =
    deleting !== null ? describeFolderContents(folderContents(connections, deleting)) : "";
  const deletingParent = deleting !== null ? folderParent(deleting) : null;

  return (
    <>
      {moveError && (
        <ErrorBanner message={moveError} className="mb-2" testId="folder-move-error" />
      )}
      {rows.length === 0 ? (
        <EmptyState
          icon={Server}
          title="No matching connections"
          hint="Try another search"
        />
      ) : (
        <div
          role="tree"
          aria-label="Connections by folder"
          data-testid="folder-tree"
          className="space-y-1 select-none"
          onKeyDown={onTreeKeyDown}
        >
          {rows.map((row, index) =>
            row.kind === "folder" ? (
              <FolderRow
                key={row.key}
                {...roving.getItemProps(index)}
                row={row}
                isDropTarget={drag.chip?.target === row.path}
                onToggle={() => row.count > 0 && toggleFolder(row.path)}
                onRename={() => setRenaming(row.path)}
                onDelete={() => setDeleting(row.path)}
                onContextMenu={(e) => {
                  setMenuFolder(row);
                  folderMenu.open(e);
                }}
                onKeyDown={(e) => {
                  setMenuFolder(row);
                  folderMenu.onKeyDown(e);
                }}
              />
            ) : (
              <ConnectionRow
                key={row.key}
                {...roving.getItemProps(index)}
                {...rowMenuProps(row.connection)}
                role="treeitem"
                aria-level={row.level}
                aria-posinset={row.posInSet}
                aria-setsize={row.setSize}
                data-drop-folder={row.connection.folder ?? NO_FOLDER}
                style={indent(row.level)}
                conn={row.connection}
                credentials={credentials}
                actions={actions}
                onActivate={() => activateRow(index)}
                onPointerDown={(e) => {
                  // A press on one of the row's own buttons is that button's.
                  if ((e.target as HTMLElement).closest("button")) return;
                  drag.startPress(
                    e,
                    () => row.connection.name,
                    (target) => onDropOnFolder(row.connection, target),
                  );
                }}
              />
            ),
          )}
        </div>
      )}
      {drag.chip && <DragChip chip={drag.chip} testId="folder-drag-chip" />}
      {rowMenu}
      {folderMenu.state && menuFolder && folderMenuItems(menuFolder).length > 0 && (
        <ContextMenu
          position={folderMenu.state}
          onClose={() => {
            folderMenu.close();
            setMenuFolder(null);
          }}
          ariaLabel={`Actions for ${menuFolder.label}`}
          items={folderMenuItems(menuFolder)}
        />
      )}
      {moving && (
        <SingleFieldDialog
          key={moving.id}
          idPrefix="folder-move"
          title="Move to folder"
          description={`Choose a folder for ${moving.name}, or leave it empty for no folder.`}
          label="Folder"
          submitLabel="Move"
          required={false}
          initial={moving.folder ?? ""}
          renderInput={(props) => <FolderPicker {...props} folders={knownFolders} />}
          onSubmit={async (text) => {
            const parsed = parseFolderPath(text);
            if (parsed.error !== undefined) throw new Error(parsed.error);
            focusAfterClose.current = connectionRowKey(moving.id);
            await moveTo(moving, parsed.path);
          }}
          onClose={() => setMoving(null)}
          onCloseAutoFocus={closeAutoFocus}
        />
      )}
      {renaming !== null && (
        <SingleFieldDialog
          key={renaming}
          idPrefix="folder-rename"
          title="Rename folder"
          description={`Everything in ${renaming} and its subfolders moves with it. Use / to put it inside another folder.`}
          label="Path"
          submitLabel="Rename"
          initial={renaming}
          preview={(text) => {
            const { path } = parseFolderPath(text);
            return path && path !== renaming && knownFolders.includes(path)
              ? `${path} already exists: the two folders merge.`
              : null;
          }}
          onSubmit={async (text) => {
            const why = folderRenameError(renaming, text);
            if (why) throw new Error(why);
            const to = parseFolderPath(text).path ?? renaming;
            if (to !== renaming) {
              await renameFolder(renaming, to);
              updateCollapsed(collapsedAfterMove(collapsed, renaming, to));
            }
            focusAfterClose.current = folderRowKey(to);
          }}
          onClose={() => setRenaming(null)}
          onCloseAutoFocus={closeAutoFocus}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete folder?"
        description={
          <>
            Delete <strong className="break-all">{deleting}</strong> and its subfolders? This{" "}
            {deletingParent ? "moves" : "takes"}{" "}
            <span data-testid="folder-delete-contents">{deletingContents}</span>{" "}
            {deletingParent ? (
              <>
                to <strong className="break-all">{deletingParent}</strong>.
              </>
            ) : (
              "out of any folder."
            )}{" "}
            No connection is deleted.
          </>
        }
        confirmLabel="Delete folder"
        variant="destructive"
        testId="folder-delete-dialog"
        onConfirm={async () => {
          if (deleting === null) return;
          await deleteFolder(deleting);
          updateCollapsed(collapsedAfterMove(collapsed, deleting, null));
          focusAfterClose.current = folderRowKey(deletingParent ?? NO_FOLDER);
        }}
        onCloseAutoFocus={closeAutoFocus}
      />
    </>
  );
}
