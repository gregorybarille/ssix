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

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="flex items-center bg-card border-b border-border min-h-[36px] overflow-x-auto">
        {tabs.map((tab) => {
          const headSession = tab.panes[0];
          // Use first pane's color as the tab accent.
          const color = getColorHex(headSession?.connection?.color);
          return (
            <div
              key={tab.id}
              className={cn(
                "group flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer border-r border-border shrink-0 max-w-[200px] transition-colors",
                activeTabId === tab.id
                  ? "bg-background text-foreground"
                  : "bg-card text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
              style={color ? { borderLeft: `3px solid ${color}` } : undefined}
              onClick={() => onSelectTab(tab.id)}
            >
              {headSession?.error && (
                <span
                  className="h-1.5 w-1.5 rounded-full bg-destructive shrink-0"
                  title="Connection failed"
                />
              )}
              <span className="truncate">
                {tab.panes.map((p) => p.connectionName).join(" | ")}
              </span>
              {tab.mode !== "single" && (
                <span className="text-muted-foreground/60 text-[10px] shrink-0">
                  ({tab.mode === "horizontal" ? "⇆" : "⇅"})
                </span>
              )}
              <button
                className="ml-1 rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-destructive/20 hover:text-destructive transition-opacity"
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(tab.id);
                }}
                title="Close tab"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}

        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-auto px-1 mx-1 shrink-0"
              title="New connection"
            >
              <Plus className="h-3.5 w-3.5" />
              <ChevronDown className="h-3 w-3 ml-0.5" />
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
    </div>
  );
}
