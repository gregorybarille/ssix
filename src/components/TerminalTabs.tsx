import React from "react";
import { Terminal } from "./Terminal";
import { Button } from "./ui/button";
import { X, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

export interface TerminalSession {
  sessionId: string;
  connectionName: string;
}

interface TerminalTabsProps {
  sessions: TerminalSession[];
  activeTabId: string | null;
  onSelectTab: (sessionId: string) => void;
  onCloseTab: (sessionId: string) => void;
  onNewTab: () => void;
}

export function TerminalTabs({
  sessions,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onNewTab,
}: TerminalTabsProps) {
  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="flex items-center bg-card border-b border-border min-h-[36px] overflow-x-auto">
        {sessions.map((session) => (
          <div
            key={session.sessionId}
            className={cn(
              "group flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer border-r border-border shrink-0 max-w-[180px] transition-colors",
              activeTabId === session.sessionId
                ? "bg-background text-foreground"
                : "bg-card text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            )}
            onClick={() => onSelectTab(session.sessionId)}
          >
            <span className="truncate">{session.connectionName}</span>
            <button
              className="ml-1 rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-destructive/20 hover:text-destructive transition-opacity"
              onClick={(e) => {
                e.stopPropagation();
                onCloseTab(session.sessionId);
              }}
              title="Close session"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 mx-1 shrink-0"
          onClick={onNewTab}
          title="New connection"
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Terminal instances — all mounted, only active is visible */}
      <div className="flex-1 min-h-0 relative">
        {sessions.map((session) => (
          <Terminal
            key={session.sessionId}
            sessionId={session.sessionId}
            connectionName={session.connectionName}
            isVisible={activeTabId === session.sessionId}
            onDisconnect={() => onCloseTab(session.sessionId)}
          />
        ))}
      </div>
    </div>
  );
}
