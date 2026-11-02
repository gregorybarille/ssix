import { useEffect, useMemo, useState, type KeyboardEvent, type MouseEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  ArrowDown,
  ArrowUp,
  CornerLeftUp,
  File,
  FileSymlink,
  Folder,
  FolderPlus,
  FolderSymlink,
  KeyRound,
  Pencil,
  RefreshCw,
  SquarePen,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { Button } from "../ui/button";
import { ErrorBanner } from "../ui/error-banner";
import { Input } from "../ui/input";
import { ContextMenu, useContextMenu, type ContextMenuItem } from "../ContextMenu";
import { useFileDrag } from "./useFileDrag";
import { useRovingFocus } from "@/hooks/useRovingFocus";
import {
  formatModeOctal,
  formatModeSymbolic,
  formatModified,
  formatSize,
  opensAsFolder,
} from "@/lib/sftp";
import { cn } from "@/lib/utils";
import { useSftpStore, type PaneSide, type SelectMode } from "@/store/useSftpStore";
import type { FileEntry } from "@/types";

function entryIcon(entry: FileEntry): LucideIcon {
  if (entry.kind === "dir") return Folder;
  if (entry.kind === "symlink") return entry.target_is_dir ? FolderSymlink : FileSymlink;
  return File;
}

function editable(entry: FileEntry): boolean {
  return entry.kind === "file" || (entry.kind === "symlink" && !entry.target_is_dir);
}

function chmodAllowed(entry: FileEntry): boolean {
  return entry.kind !== "symlink" && entry.mode !== null;
}

interface ToolButtonProps {
  label: string;
  icon: LucideIcon;
  testId: string;
  disabled?: boolean;
  destructive?: boolean;
  onClick: () => void;
}

function ToolButton({ label, icon: Icon, testId, disabled, destructive, onClick }: ToolButtonProps) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn("h-7 w-7 shrink-0", destructive && "text-destructive hover:text-destructive")}
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      title={label}
      data-testid={testId}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
    </Button>
  );
}

interface PathFieldProps {
  side: PaneSide;
  title: string;
  path: string;
  disabled: boolean;
  onGo: (path: string) => void;
}

/** The folder typed into a pane. Its draft lives here, so typing leaves the rows alone. */
function PathField({ side, title, path, disabled, onGo }: PathFieldProps) {
  const [draft, setDraft] = useState(path);
  useEffect(() => setDraft(path), [path]);
  return (
    <Input
      value={draft}
      disabled={disabled}
      className="h-7 min-w-0 flex-1 font-mono text-xs"
      aria-label={`Folder on ${title}`}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && draft.trim()) onGo(draft.trim());
      }}
      data-testid={`files-path-${side}`}
    />
  );
}

interface FilePaneProps {
  side: PaneSide;
  title: string;
  /** Shown instead of the rows while the pane has nothing to list. */
  placeholder?: React.ReactNode;
}

/** One side of the Files view: a folder's rows, and what can be done with them. */
export function FilePane({ side, title, placeholder }: FilePaneProps) {
  const {
    pane,
    otherPath,
    connected,
    editBusy,
    navigate,
    refresh,
    select,
    setDialog,
    transfer,
    openEdit,
  } = useSftpStore(
    useShallow((s) => ({
      pane: s[side],
      otherPath: s[side === "local" ? "remote" : "local"].path,
      connected: s.sessionId !== null,
      editBusy: s.edit !== null || s.editOpening,
      navigate: s.navigate,
      refresh: s.refresh,
      select: s.select,
      setDialog: s.setDialog,
      transfer: s.transfer,
      openEdit: s.openEdit,
    })),
  );
  const { entries, path, parent, selected, loading, error, omitted, truncated } = pane;
  const isRemote = side === "remote";
  const usable = !isRemote || connected;
  const copyVerb = isRemote ? "Download" : "Upload";
  const CopyIcon = isRemote ? ArrowDown : ArrowUp;

  const selectedPaths = useMemo(() => new Set(selected), [selected]);
  const chosen = useMemo(
    () => entries.filter((e) => selectedPaths.has(e.path)),
    [entries, selectedPaths],
  );
  const single = chosen.length === 1 ? chosen[0] : null;
  const canCopy = connected && otherPath !== "" && chosen.length > 0;

  const openEntry = (entry: FileEntry) => {
    if (opensAsFolder(entry)) void navigate(side, entry.path);
  };
  const roving = useRovingFocus({
    itemCount: entries.length,
    onActivate: (index) => {
      const entry = entries[index];
      if (!entry) return;
      if (opensAsFolder(entry)) openEntry(entry);
      else select(side, entry.path, "replace");
    },
  });

  const drag = useFileDrag(side, (paths, dir) => {
    void transfer(
      side,
      paths.map((p) => ({ path: p })),
      dir,
    );
  });
  // Dragging a row that is part of the selection takes the selection along.
  const dragPaths = (entry: FileEntry) => {
    const { selected: current } = useSftpStore.getState()[side];
    return current.includes(entry.path) ? current : [entry.path];
  };

  const ctx = useContextMenu();
  const [ctxEntry, setCtxEntry] = useState<FileEntry | null>(null);
  const openMenuFor = (entry: FileEntry) => {
    if (!selectedPaths.has(entry.path)) select(side, entry.path, "replace");
    setCtxEntry(entry);
  };
  /** The rows an action from this entry's menu applies to. */
  const menuTargets = (entry: FileEntry) =>
    selectedPaths.has(entry.path) ? chosen : [entry];
  const buildItems = (entry: FileEntry): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [];
    if (opensAsFolder(entry)) {
      items.push({
        label: "Open",
        icon: <Folder className="h-3.5 w-3.5" />,
        onClick: () => openEntry(entry),
      });
    }
    items.push({
      label: copyVerb,
      icon: <CopyIcon className="h-3.5 w-3.5" />,
      disabled: !connected || otherPath === "",
      onClick: () => void transfer(side, menuTargets(entry)),
    });
    if (isRemote && editable(entry)) {
      items.push({
        label: "Edit",
        icon: <SquarePen className="h-3.5 w-3.5" />,
        disabled: !usable || editBusy,
        onClick: () => void openEdit(entry),
      });
    }
    items.push({
      label: "Rename",
      icon: <Pencil className="h-3.5 w-3.5" />,
      disabled: !usable,
      onClick: () => setDialog({ kind: "rename", side, entry }),
    });
    items.push({
      label: "Permissions",
      icon: <KeyRound className="h-3.5 w-3.5" />,
      disabled: !usable || !chmodAllowed(entry),
      onClick: () => setDialog({ kind: "chmod", side, entry }),
    });
    items.push({ separator: true });
    items.push({
      label: "Delete",
      icon: <Trash2 className="h-3.5 w-3.5" />,
      destructive: true,
      disabled: !usable,
      onClick: () => setDialog({ kind: "delete", side, entries: menuTargets(entry) }),
    });
    return items;
  };

  const onRowClick = (event: MouseEvent, entry: FileEntry) => {
    const mode: SelectMode = event.shiftKey
      ? "range"
      : event.metaKey || event.ctrlKey
        ? "toggle"
        : "replace";
    select(side, entry.path, mode);
  };
  const onRowKeyDown = (event: KeyboardEvent<HTMLDivElement>, entry: FileEntry) => {
    if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") {
      event.preventDefault();
      event.stopPropagation();
      openMenuFor(entry);
      ctx.openAt(event.currentTarget);
    } else if (event.key === " ") {
      // Enter opens; Space picks, without leaving the folder.
      event.preventDefault();
      event.stopPropagation();
      select(side, entry.path, "toggle");
    }
  };

  return (
    <section
      className="flex min-h-0 min-w-0 flex-col rounded-md border border-border"
      aria-label={title}
      data-testid={`files-pane-${side}`}
      data-path={path}
      data-drop-side={side}
    >
      <header className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <h2 className="max-w-32 shrink-0 truncate pl-1 pr-2 text-xs font-semibold" title={title}>
          {title}
        </h2>
        <ToolButton
          label="Parent folder"
          icon={CornerLeftUp}
          testId={`files-up-${side}`}
          disabled={!usable || !parent}
          onClick={() => parent && void navigate(side, parent)}
        />
        <PathField
          side={side}
          title={title}
          path={path}
          disabled={!usable}
          onGo={(typed) => void navigate(side, typed)}
        />
        <ToolButton
          label="Refresh"
          icon={RefreshCw}
          testId={`files-refresh-${side}`}
          disabled={!usable || !path}
          onClick={() => void refresh(side)}
        />
      </header>
      <div className="flex items-center gap-1 border-b border-border px-2 py-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 text-xs"
          disabled={!canCopy}
          onClick={() => void transfer(side, chosen)}
          data-testid={`files-transfer-${side}`}
        >
          <CopyIcon className="h-3.5 w-3.5" aria-hidden="true" />
          {copyVerb}
        </Button>
        {isRemote && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-xs"
            disabled={!usable || !single || !editable(single) || editBusy}
            onClick={() => single && void openEdit(single)}
            data-testid="files-edit"
          >
            <SquarePen className="h-3.5 w-3.5" aria-hidden="true" />
            Edit
          </Button>
        )}
        <div className="flex-1" />
        <ToolButton
          label="New folder"
          icon={FolderPlus}
          testId={`files-mkdir-${side}`}
          disabled={!usable || !path}
          onClick={() => setDialog({ kind: "mkdir", side })}
        />
        <ToolButton
          label="Rename"
          icon={Pencil}
          testId={`files-rename-${side}`}
          disabled={!usable || !single}
          onClick={() => single && setDialog({ kind: "rename", side, entry: single })}
        />
        <ToolButton
          label="Permissions"
          icon={KeyRound}
          testId={`files-chmod-${side}`}
          disabled={!usable || !single || !chmodAllowed(single)}
          onClick={() => single && setDialog({ kind: "chmod", side, entry: single })}
        />
        <ToolButton
          label="Delete"
          icon={Trash2}
          testId={`files-delete-${side}`}
          destructive
          disabled={!usable || chosen.length === 0}
          onClick={() => setDialog({ kind: "delete", side, entries: chosen })}
        />
      </div>
      {error && (
        <ErrorBanner
          className="m-2"
          message={error}
          onRetry={() => void refresh(side)}
          testId={`files-error-${side}`}
        />
      )}
      {!usable ? (
        <div className="flex-1 overflow-y-auto">{placeholder}</div>
      ) : (
        <div
          className="min-h-0 flex-1 overflow-y-auto p-1"
          role="list"
          aria-label={`Files on ${title}`}
          aria-busy={loading}
          onKeyDown={roving.onKeyDown}
          data-testid={`files-list-${side}`}
        >
          {entries.map((entry, index) => {
            const Icon = entryIcon(entry);
            const isSelected = selectedPaths.has(entry.path);
            return (
              <div
                key={entry.path}
                {...roving.getItemProps(index)}
                role="listitem"
                aria-label={entry.name}
                aria-current={isSelected || undefined}
                className={cn(
                  "flex cursor-default select-none items-center gap-2 rounded px-2 py-1 text-xs",
                  "[content-visibility:auto] [contain-intrinsic-size:auto_26px]",
                  "hover:bg-accent/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  isSelected && "bg-accent",
                )}
                data-testid="file-row"
                data-name={entry.name}
                data-kind={entry.kind}
                data-mode={formatModeOctal(entry.mode)}
                data-drop-dir={opensAsFolder(entry) ? entry.path : undefined}
                onClick={(e) => onRowClick(e, entry)}
                onDoubleClick={() => openEntry(entry)}
                onPointerDown={(e) =>
                  drag.startPress(
                    e,
                    () => dragPaths(entry),
                    () => {
                      const count = dragPaths(entry).length;
                      return count === 1 ? entry.name : `${count} items`;
                    },
                  )
                }
                onContextMenu={(e) => {
                  openMenuFor(entry);
                  ctx.open(e);
                }}
                onKeyDown={(e) => onRowKeyDown(e, entry)}
              >
                <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate" title={entry.name}>
                  {entry.name}
                </span>
                <span className="hidden font-mono text-muted-foreground-soft xl:inline">
                  {formatModeSymbolic(entry.mode)}
                </span>
                <span className="hidden whitespace-nowrap text-muted-foreground-soft lg:inline">
                  {formatModified(entry.modified)}
                </span>
                <span className="w-16 shrink-0 text-right text-muted-foreground">
                  {entry.kind === "file" && entry.size !== null ? formatSize(entry.size) : ""}
                </span>
              </div>
            );
          })}
          {entries.length === 0 && !loading && !error && (
            <p className="p-3 text-center text-xs text-muted-foreground" data-testid={`files-empty-${side}`}>
              This folder is empty.
            </p>
          )}
        </div>
      )}
      <footer
        className="flex flex-wrap gap-x-3 border-t border-border px-3 py-1 text-xs text-muted-foreground-soft"
        data-testid={`files-footer-${side}`}
      >
        <span>
          {entries.length} {entries.length === 1 ? "item" : "items"}
          {chosen.length > 0 && `, ${chosen.length} selected`}
        </span>
        {truncated && <span>Only the first {entries.length} are shown.</span>}
        {omitted > 0 && <span>{omitted} with names that cannot be shown safely are left out.</span>}
      </footer>
      {ctx.state && ctxEntry && (
        <ContextMenu
          position={ctx.state}
          onClose={() => {
            ctx.close();
            setCtxEntry(null);
          }}
          ariaLabel={`Actions for ${ctxEntry.name}`}
          items={buildItems(ctxEntry)}
        />
      )}
      {drag.chip && (
        <div
          className={cn(
            "pointer-events-none fixed z-50 max-w-60 truncate rounded border border-border bg-popover px-2 py-1 text-xs shadow-md",
            !drag.chip.overTarget && "opacity-60",
          )}
          style={{ left: drag.chip.x + 12, top: drag.chip.y + 12 }}
          data-testid="files-drag-chip"
        >
          {drag.chip.label}
        </div>
      )}
    </section>
  );
}
