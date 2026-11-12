import React from "react";
import { useLatestCallback } from "@/hooks/useLatestCallback";
import {
  ArrowUpDown,
  Cable,
  ChevronRight,
  Clipboard,
  Copy,
  CornerDownRight,
  Edit,
  FolderInput,
  FolderOpen,
  Play,
  Server,
  Terminal as TerminalIcon,
  Trash2,
} from "lucide-react";
import { KIND_LABELS, forwardEndpoint, isForwardConnection } from "@/lib/sshTerms";
import { getColorHex } from "@/lib/colors";
import { buildSshCommand } from "@/lib/ssh-command";
import { cn } from "@/lib/utils";
import type { Connection, Credential } from "@/types";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { ContextMenu, isContextMenuKey, useContextMenu, type ContextMenuItem } from "./ContextMenu";

function ConnIcon({ conn, className }: { conn: Connection; className?: string }) {
  const cls = cn("h-5 w-5 text-muted-foreground", className);
  if (isForwardConnection(conn)) return <Cable className={cls} aria-hidden="true" />;
  if (conn.type === "jump_shell") return <CornerDownRight className={cls} aria-hidden="true" />;
  return <Server className={cls} aria-hidden="true" />;
}

function describe(conn: Connection): React.ReactNode {
  if (isForwardConnection(conn)) {
    return (
      <>
        {forwardEndpoint(conn)} via {conn.gateway_host}
      </>
    );
  }
  if (conn.type === "jump_shell") {
    return (
      <>
        {conn.destination_host}:{conn.destination_port} via {conn.gateway_host}
      </>
    );
  }
  return (
    <>
      {conn.host}:{conn.port}
    </>
  );
}

function TypeBadge({ conn }: { conn: Connection }) {
  if (conn.type === "direct") return null;
  return (
    <Badge variant="secondary" className="text-xs shrink-0">
      {KIND_LABELS[conn.type].toLowerCase()}
    </Badge>
  );
}

function TagBadges({ tags }: { tags?: string[] }) {
  return (
    <>
      {tags?.map((t) => (
        <Badge key={t} variant="outline" className="text-[10px] py-0 px-1.5">
          {t}
        </Badge>
      ))}
    </>
  );
}

const ACTION_BUTTON = "h-7 w-7";

/** Stops the row's own click (activate) from firing for an action button. */
function stop<T>(fn: (arg: T) => void, arg: T) {
  return (e: React.MouseEvent) => {
    e.stopPropagation();
    fn(arg);
  };
}

/** What a connection's row and its context menu can do. */
export interface ConnectionRowActions {
  onEdit: (connection: Connection) => void;
  onDelete: (id: string) => void;
  onClone: (connection: Connection) => void;
  onConnect?: (connection: Connection) => void;
  onScp?: (connection: Connection) => void;
  onBrowse?: (connection: Connection) => void;
  /** Offered in the context menu only: the row's keyboard path to another folder. */
  onMove?: (connection: Connection) => void;
}

/** The per-row action cluster, identical in row and tile layouts. */
function RowActions({
  conn,
  actions: { onEdit, onDelete, onClone, onConnect, onScp, onBrowse },
  tabIndex,
}: {
  conn: Connection;
  actions: ConnectionRowActions;
  tabIndex?: number;
}) {
  const scpBlocked = isForwardConnection(conn);
  const button = { variant: "ghost", size: "icon", tabIndex } as const;
  return (
    <div className="flex items-center gap-1">
      {onConnect && (
        <Button
          {...button}
          className={cn(ACTION_BUTTON, "text-green-500 hover:text-green-600")}
          onClick={stop(onConnect, conn)}
          aria-label={`Connect to ${conn.name}`}
          data-testid={`connect-button-${conn.id}`}
        >
          <Play className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      )}
      {onBrowse && !isForwardConnection(conn) && (
        <Button
          {...button}
          className={ACTION_BUTTON}
          onClick={stop(onBrowse, conn)}
          aria-label={`Browse files on ${conn.name}`}
          data-testid={`browse-files-${conn.id}`}
        >
          <FolderOpen className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      )}
      {onScp && (
        <span
          title={scpBlocked ? "SCP not available for port forwards" : undefined}
          className="inline-flex"
        >
          <Button
            {...button}
            className={ACTION_BUTTON}
            disabled={scpBlocked}
            onClick={stop((c: Connection) => {
              if (!isForwardConnection(c)) onScp(c);
            }, conn)}
            aria-label={
              scpBlocked
                ? "SCP not available for port forwards"
                : `Transfer files to ${conn.name}`
            }
            data-testid={`scp-open-${conn.id}`}
          >
            <ArrowUpDown className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </span>
      )}
      <Button
        {...button}
        className={ACTION_BUTTON}
        onClick={stop(onClone, conn)}
        aria-label={`Clone ${conn.name}`}
        data-testid={`clone-connection-${conn.id}`}
      >
        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
      <Button
        {...button}
        className={ACTION_BUTTON}
        onClick={stop(onEdit, conn)}
        aria-label={`Edit ${conn.name}`}
        data-testid={`edit-connection-${conn.id}`}
      >
        <Edit className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
      <Button
        {...button}
        className={cn(ACTION_BUTTON, "text-destructive hover:text-destructive")}
        onClick={stop(onDelete, conn.id)}
        aria-label={`Delete ${conn.name}`}
        data-testid={`delete-connection-${conn.id}`}
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
    </div>
  );
}

function rowMenuItems(
  conn: Connection,
  credentials: Credential[],
  { onEdit, onDelete, onClone, onConnect, onScp, onBrowse, onMove }: ConnectionRowActions,
): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  if (onConnect) {
    items.push({
      label: "Connect",
      icon: <TerminalIcon className="h-3.5 w-3.5" />,
      onClick: () => onConnect(conn),
    });
  }
  items.push({
    label: "Edit",
    icon: <Edit className="h-3.5 w-3.5" />,
    onClick: () => onEdit(conn),
  });
  items.push({
    label: "Clone",
    icon: <Copy className="h-3.5 w-3.5" />,
    onClick: () => onClone(conn),
  });
  if (onMove) {
    items.push({
      label: "Move to folder…",
      icon: <FolderInput className="h-3.5 w-3.5" />,
      onClick: () => onMove(conn),
    });
  }
  if (onScp && !isForwardConnection(conn)) {
    items.push({
      label: "Transfer files",
      icon: <ArrowUpDown className="h-3.5 w-3.5" />,
      onClick: () => onScp(conn),
    });
  }
  if (onBrowse && !isForwardConnection(conn)) {
    items.push({
      label: "Browse files",
      icon: <FolderOpen className="h-3.5 w-3.5" />,
      onClick: () => onBrowse(conn),
    });
  }
  items.push({ separator: true });
  items.push({
    label: "Copy SSH command",
    icon: <Clipboard className="h-3.5 w-3.5" />,
    onClick: () => {
      const cmd = buildSshCommand(conn, credentials);
      // Best-effort; clipboard is async but we don't need to wait.
      navigator.clipboard?.writeText(cmd).catch(() => {
        /* surfacing this would require a toast plumbed from App.tsx;
           the menu has already closed by now. */
      });
    },
  });
  items.push({ separator: true });
  items.push({
    label: "Delete",
    icon: <Trash2 className="h-3.5 w-3.5" />,
    destructive: true,
    onClick: () => onDelete(conn.id),
  });
  return items;
}

/**
 * Right-click context menu for any connection row/tile. We track which
 * connection the menu was opened for so the items list can close over the
 * correct connection without re-creating itself for every row.
 *
 * Render `menu` once beside the rows and pass `rowMenuProps` to each of them.
 */
export function useConnectionRowMenu(credentials: Credential[], actions: ConnectionRowActions) {
  const ctx = useContextMenu();
  const [ctxConn, setCtxConn] = React.useState<Connection | null>(null);

  const onRowContextMenu = useLatestCallback((conn: Connection, e: React.MouseEvent) => {
    setCtxConn(conn);
    ctx.open(e);
  });
  const onRowKeyDown = useLatestCallback(
    (conn: Connection, e: React.KeyboardEvent<HTMLElement>) => {
      // Keyboard alternative for the context menu (Shift+F10 or
      // the ContextMenu key). The container-level roving-focus
      // handler still runs on bubble for arrows / Home / End.
      if (isContextMenuKey(e)) {
        e.preventDefault();
        e.stopPropagation();
        setCtxConn(conn);
        ctx.openAt(e.currentTarget);
      }
    },
  );

  const menu =
    ctx.state && ctxConn ? (
      <ContextMenu
        position={ctx.state}
        onClose={() => {
          ctx.close();
          setCtxConn(null);
        }}
        ariaLabel={`Actions for ${ctxConn.name}`}
        items={rowMenuItems(ctxConn, credentials, actions)}
      />
    ) : null;

  return { onRowContextMenu, onRowKeyDown, menu };
}

/**
 * `actions` as one object that keeps its identity, so rows need not re-render
 * for new handlers. It changes only when an optional action appears or goes,
 * since a row shows a button only for the actions it has.
 */
export function useStableRowActions(actions: ConnectionRowActions): ConnectionRowActions {
  const latest = React.useRef(actions);
  React.useLayoutEffect(() => {
    latest.current = actions;
  });
  const hasConnect = !!actions.onConnect;
  const hasScp = !!actions.onScp;
  const hasBrowse = !!actions.onBrowse;
  const hasMove = !!actions.onMove;
  return React.useMemo(
    () => ({
      onEdit: (conn) => latest.current.onEdit(conn),
      onDelete: (id) => latest.current.onDelete(id),
      onClone: (conn) => latest.current.onClone(conn),
      onConnect: hasConnect ? (conn) => latest.current.onConnect?.(conn) : undefined,
      onScp: hasScp ? (conn) => latest.current.onScp?.(conn) : undefined,
      onBrowse: hasBrowse ? (conn) => latest.current.onBrowse?.(conn) : undefined,
      onMove: hasMove ? (conn) => latest.current.onMove?.(conn) : undefined,
    }),
    [hasConnect, hasScp, hasBrowse, hasMove],
  );
}

interface ConnectionRowProps extends Omit<React.ComponentProps<"div">, "onClick"> {
  conn: Connection;
  credentials: Credential[];
  /** "tile" renders a card; otherwise a full-width row. */
  tile?: boolean;
  actions: ConnectionRowActions;
  /** Click on the row itself. */
  onActivate: (conn: Connection) => void;
  /** From `useConnectionRowMenu`. */
  onRowContextMenu: (conn: Connection, e: React.MouseEvent) => void;
  onRowKeyDown: (conn: Connection, e: React.KeyboardEvent<HTMLElement>) => void;
  /** A press on the row, for a layout that can drag it. */
  onRowPointerDown?: (conn: Connection, e: React.PointerEvent<HTMLElement>) => void;
  /**
   * `tabIndex` of the row's action buttons, for a layout that is one tab stop.
   * Everything they do must then also be in the row's context menu.
   */
  actionTabIndex?: number;
}

/**
 * One connection, in any layout. Everything else on the element (its role, the
 * roving-focus props, a tree row's ARIA) comes from the layout through the
 * remaining props. Memoized: a list re-renders on every focus move and right
 * click, and with hundreds of rows that was most of the wait. Every function
 * passed here has to keep its identity, or this does nothing.
 */
export const ConnectionRow = React.memo(function ConnectionRow({
  conn,
  credentials,
  tile = false,
  actions,
  onActivate,
  onRowContextMenu,
  onRowKeyDown,
  onRowPointerDown,
  actionTabIndex,
  className,
  style,
  ...rowProps
}: ConnectionRowProps) {
  const color = getColorHex(conn.color);
  const credentialName = conn.credential_id
    ? (credentials.find((c) => c.id === conn.credential_id)?.name ?? null)
    : null;
  return (
    <div
      role="listitem"
      {...rowProps}
      data-testid={`connection-row-${conn.id}`}
      data-name={conn.name}
      aria-label={`${conn.name}${conn.tags && conn.tags.length > 0 ? `, tagged ${conn.tags.join(", ")}` : ""}`}
      className={cn(
        "group rounded-lg cursor-pointer transition-colors hover:bg-accent",
        // Rows off screen skip layout and paint, as in the Files view.
        "[content-visibility:auto]",
        tile ? "[contain-intrinsic-size:auto_132px]" : "[contain-intrinsic-size:auto_62px]",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        tile ? "border p-3 flex flex-col gap-2 h-full" : "flex flex-wrap items-center gap-3 p-3",
        className,
      )}
      style={color ? { ...style, borderLeft: `3px solid ${color}` } : style}
      // The second click of a double-click must not activate again
      // (it used to open two sessions).
      onClick={(e) => e.detail <= 1 && onActivate(conn)}
      onContextMenu={(e) => onRowContextMenu(conn, e)}
      onKeyDown={(e) => onRowKeyDown(conn, e)}
      onPointerDown={onRowPointerDown && ((e) => onRowPointerDown(conn, e))}
    >
      {tile ? (
        <>
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <ConnIcon conn={conn} />
              <span className="font-medium text-sm truncate">{conn.name}</span>
            </div>
            <TypeBadge conn={conn} />
          </div>
          <p className="text-xs text-muted-foreground truncate">
            {describe(conn)}
            {credentialName && (
              <span className="ml-1 text-muted-foreground-soft">· {credentialName}</span>
            )}
          </p>
          {/* Always rendered (empty when untagged) so the action row
              sits on the same baseline across every tile. */}
          <div className="flex flex-wrap gap-1 min-h-[18px]">
            <TagBadges tags={conn.tags} />
          </div>
          <div className="flex items-center justify-start mt-auto">
            <RowActions conn={conn} actions={actions} tabIndex={actionTabIndex} />
          </div>
        </>
      ) : (
        <>
          <div className="flex-shrink-0">
            <ConnIcon conn={conn} />
          </div>
          {/* The name keeps its room: without it the actions go on a line of their own. */}
          <div className="flex-1 min-w-40">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium text-sm truncate">{conn.name}</span>
              <TypeBadge conn={conn} />
              <TagBadges tags={conn.tags} />
            </div>
            <p className="text-xs text-muted-foreground truncate">
              {describe(conn)}
              {credentialName && (
                <span className="ml-2 text-muted-foreground-soft">· {credentialName}</span>
              )}
            </p>
          </div>
          <div className="ml-auto">
            <RowActions conn={conn} actions={actions} tabIndex={actionTabIndex} />
          </div>
          <ChevronRight
            className="h-4 w-4 text-muted-foreground-soft shrink-0"
            aria-hidden="true"
          />
        </>
      )}
    </div>
  );
});
