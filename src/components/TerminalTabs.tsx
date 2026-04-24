import React, { useState } from "react";
import { Terminal } from "./Terminal";
import { FailedTerminal } from "./FailedTerminal";
import { Button } from "./ui/button";
import {
  X,
  Plus,
  SplitSquareHorizontal,
  SplitSquareVertical,
  ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { AppSettings, Connection, OpenMode } from "@/types";
import { getColorHex } from "@/lib/colors";
import { Group, Panel, Separator as PanelSeparator } from "react-resizable-panels";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
  ContextMenu,
  useContextMenu,
  type ContextMenuItem,
} from "./ContextMenu";

export interface TerminalSession {
  /** Unique ID returned by ssh_connect, or a synthetic ID for failed sessions. */
  sessionId: string;
  connectionName: string;
  /** Set when the connection attempt failed before a shell was opened. */
  error?: string;
  /** True while a retry attempt is in flight. */
  retrying?: boolean;
  /** The originating Connection, kept so Retry / Edit can reuse it. */
  connection?: Connection;
}

export type SplitMode = "single" | "horizontal" | "vertical";

export interface TerminalTab {
  id: string;
  mode: SplitMode;
  panes: TerminalSession[]; // length 1 or 2
}

interface TerminalTabsProps {
  tabs: TerminalTab[];
  activeTabId: string | null;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onClosePane: (tabId: string, sessionId: string) => void;
  onNewTab: (mode: OpenMode) => void;
  onRetry: (conn: Connection, sessionId: string) => void;
  onEdit: (conn: Connection, sessionId: string) => void;
  settings?: AppSettings;
}

function PaneRenderer({
  session,
  isVisible,
  onClose,
  onRetry,
  onEdit,
  settings,
}: {
  session: TerminalSession;
  isVisible: boolean;
  onClose: () => void;
  onRetry: (conn: Connection) => void;
  onEdit: (conn: Connection) => void;
  settings?: AppSettings;
}) {
  if (session.error || session.retrying) {
    return (
      <FailedTerminal
        connectionName={session.connectionName}
        error={session.error}
        connection={session.connection}
        isVisible={isVisible}
        retrying={session.retrying}
        onRetry={(conn) => onRetry(conn)}
        onEdit={(conn) => onEdit(conn)}
        onClose={onClose}
      />
    );
  }
  return (
    <Terminal
      sessionId={session.sessionId}
      connectionName={session.connectionName}
      isVisible={isVisible}
      onDisconnect={onClose}
      settings={settings}
    />
  );
}

export function TerminalTabs({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onClosePane,
  onNewTab,
  onRetry,
  onEdit,
  settings,
}: TerminalTabsProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const tabRefs = React.useRef(new Map<string, HTMLButtonElement>());

  // Right-click context menu for terminal tabs.
  const ctx = useContextMenu();
  const [ctxTabId, setCtxTabId] = React.useState<string | null>(null);
  const openTabContextMenu = (e: React.MouseEvent, tabId: string) => {
    setCtxTabId(tabId);
    ctx.open(e);
  };
  const buildTabItems = (tabId: string): ContextMenuItem[] => {
    const idx = tabs.findIndex((t) => t.id === tabId);
    const tab = tabs[idx];
    if (!tab) return [];
    const otherTabs = tabs.filter((t) => t.id !== tabId);
    const tabsToRight = tabs.slice(idx + 1);
    return [
      {
        label: "Close tab",
        icon: <X className="h-3.5 w-3.5" />,
        onClick: () => onCloseTab(tabId),
      },
      {
        label: "Close other tabs",
        icon: <X className="h-3.5 w-3.5" />,
        disabled: otherTabs.length === 0,
        onClick: () => otherTabs.forEach((t) => onCloseTab(t.id)),
      },
      {
        label: "Close tabs to the right",
        icon: <X className="h-3.5 w-3.5" />,
        disabled: tabsToRight.length === 0,
        onClick: () => tabsToRight.forEach((t) => onCloseTab(t.id)),
      },
    ];
  };

  const focusTabAt = (index: number) => {
    const wrapped = (index + tabs.length) % tabs.length;
    const id = tabs[wrapped]?.id;
    if (!id) return;
    const el = tabRefs.current.get(id);
    el?.focus();
    onSelectTab(id);
  };

  const handleTabKeyDown = (
    e: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      focusTabAt(index + 1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      focusTabAt(index - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusTabAt(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusTabAt(tabs.length - 1);
    } else if ((e.key === "Delete" || (e.metaKey && e.key === "w")) && tabs[index]) {
      e.preventDefault();
      onCloseTab(tabs[index].id);
    } else if (((e.shiftKey && e.key === "F10") || e.key === "ContextMenu") && tabs[index]) {
      // Keyboard alternative for the right-click context menu
      // (WCAG 2.1.1 — every mouse-only path must have a keyboard
      // equivalent). Anchor the menu to the bottom-left of the focused
      // tab button.
      e.preventDefault();
      e.stopPropagation();
      setCtxTabId(tabs[index].id);
      ctx.openAt(e.currentTarget);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div
        role="tablist"
        aria-label="Terminal sessions"
        className="flex items-center bg-card border-b border-border min-h-[36px] overflow-x-auto"
      >
        {tabs.map((tab, idx) => {
          const headSession = tab.panes[0];
          // Use first pane's color as the tab accent.
          const color = getColorHex(headSession?.connection?.color);
          const isActive = activeTabId === tab.id;
          const label = tab.panes.map((p) => p.connectionName).join(" | ");
          return (
            <button
              key={tab.id}
              ref={(el) => {
                if (el) tabRefs.current.set(tab.id, el);
                else tabRefs.current.delete(tab.id);
              }}
              role="tab"
              type="button"
              aria-selected={isActive}
              aria-label={`Terminal ${label}${tab.mode !== "single" ? ` (${tab.mode} split)` : ""}`}
              tabIndex={isActive ? 0 : -1}
              className={cn(
                "group flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer border-r border-border shrink-0 max-w-[200px] transition-colors text-left",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                isActive
                  ? "bg-background text-foreground"
                  : "bg-card text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
              style={color ? { borderLeft: `3px solid ${color}` } : undefined}
              onClick={() => onSelectTab(tab.id)}
              onContextMenu={(e) => openTabContextMenu(e, tab.id)}
              onKeyDown={(e) => handleTabKeyDown(e, idx)}
            >
              {tab.panes.some((p) => p.error) && (
                <span
                  className="h-1.5 w-1.5 rounded-full bg-destructive shrink-0"
                  title="Connection failed"
                  aria-hidden="true"
                />
              )}
              <span className="truncate">{label}</span>
              {tab.mode !== "single" && (
                <span
                  className="text-muted-foreground-soft text-[10px] shrink-0"
                  aria-hidden="true"
                >
                  ({tab.mode === "horizontal" ? "⇆" : "⇅"})
                </span>
              )}
              {/*
               * Visual close affordance for mouse users. Keyboard users
               * close the focused tab with Delete (or Cmd/Ctrl+W). We
               * intentionally avoid nesting an interactive element inside
               * the role=tab button (invalid HTML); this span is mouse-only.
               */}
              <span
                aria-hidden="true"
                data-testid={`close-tab-${tab.id}`}
                className="ml-1 rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-destructive/20 hover:text-destructive transition-opacity"
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(tab.id);
                }}
              >
                <X className="h-3 w-3" />
              </span>
            </button>
          );
        })}

        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-auto px-1 mx-1 shrink-0"
              title="New connection"
              aria-label="Open a new tab or split"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              <ChevronDown className="h-3 w-3 ml-0.5" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => onNewTab("tab")}>
              <Plus className="h-3.5 w-3.5 mr-2" />
              New tab
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => onNewTab("split_right")}
              disabled={
                !activeTabId ||
                (tabs.find((t) => t.id === activeTabId)?.panes.length ?? 0) >= 2
              }
            >
              <SplitSquareHorizontal className="h-3.5 w-3.5 mr-2" />
              Split right
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => onNewTab("split_down")}
              disabled={
                !activeTabId ||
                (tabs.find((t) => t.id === activeTabId)?.panes.length ?? 0) >= 2
              }
            >
              <SplitSquareVertical className="h-3.5 w-3.5 mr-2" />
              Split down
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Tab bodies — all mounted, only active is visible */}
      <div className="flex-1 min-h-0 relative">
        {tabs.map((tab) => {
          const isActiveTab = tab.id === activeTabId;
          if (tab.mode === "single" || tab.panes.length === 1) {
            const pane = tab.panes[0];
            return (
              <div
                key={tab.id}
                className="absolute inset-0"
                style={{ display: isActiveTab ? "block" : "none" }}
              >
                {pane && (
                  <PaneRenderer
                    session={pane}
                    isVisible={isActiveTab}
                    onClose={() => onClosePane(tab.id, pane.sessionId)}
                    onRetry={(c) => onRetry(c, pane.sessionId)}
                    onEdit={(c) => onEdit(c, pane.sessionId)}
                    settings={settings}
                  />
                )}
              </div>
            );
          }
          const direction = tab.mode === "horizontal" ? "horizontal" : "vertical";
          return (
            <div
              key={tab.id}
              className="absolute inset-0"
              style={{ display: isActiveTab ? "block" : "none" }}
            >
              <Group orientation={direction} className="h-full">
                {tab.panes.map((pane, idx) => (
                  <React.Fragment key={pane.sessionId}>
                    {idx > 0 && (
                      <PanelSeparator
                        className={cn(
                          "bg-border hover:bg-primary/30 transition-colors",
                          direction === "horizontal" ? "w-px" : "h-px",
                        )}
                      />
                    )}
                    <Panel defaultSize={50} minSize={15}>
                      <div className="h-full w-full relative">
                        <PaneRenderer
                          session={pane}
                          isVisible={isActiveTab}
                          onClose={() => onClosePane(tab.id, pane.sessionId)}
                          onRetry={(c) => onRetry(c, pane.sessionId)}
                          onEdit={(c) => onEdit(c, pane.sessionId)}
                          settings={settings}
                        />
                      </div>
                    </Panel>
                  </React.Fragment>
                ))}
              </Group>
            </div>
          );
        })}
      </div>
      {ctx.state && ctxTabId && (
        <ContextMenu
          position={ctx.state}
          onClose={() => {
            ctx.close();
            setCtxTabId(null);
          }}
          ariaLabel="Tab actions"
          items={buildTabItems(ctxTabId)}
        />
      )}
    </div>
  );
}
