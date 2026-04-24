import React from "react";
import { Server, Key, TerminalSquare, Cable, ScrollText, GitBranch } from "lucide-react";
import { cn } from "@/lib/utils";

export type NavItem =
  | "connections"
  | "credentials"
  | "tunnels"
  | "logs"
  | "git_sync"
  | "settings"
  | "terminals";

interface SidebarProps {
  active: NavItem;
  onNavigate: (item: NavItem) => void;
  terminalCount?: number;
  tunnelCount?: number;
  gitPending?: boolean;
}

const navItems: { id: NavItem; label: string; icon: React.ReactNode }[] = [
  { id: "connections", label: "Connections", icon: <Server className="h-5 w-5" /> },
  { id: "credentials", label: "Credentials", icon: <Key className="h-5 w-5" /> },
  { id: "tunnels", label: "Tunnels", icon: <Cable className="h-5 w-5" /> },
  { id: "logs", label: "Logs", icon: <ScrollText className="h-5 w-5" /> },
];

function NavButton({
  active,
  label,
  onClick,
  icon,
  badge,
  dot,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  icon: React.ReactNode;
  badge?: number;
  dot?: boolean;
}) {
  /*
   * Audit-3 #1: the only accessible name for these icon-only buttons
   * is aria-label, so it must encode every state a sighted user can
   * see. Previously the orange "pending changes" dot was conveyed via
   * an sr-only <span> nested inside an aria-hidden parent — aria-hidden
   * cascades, so the sr-only text was silently swallowed and an AT
   * user heard "Git Sync" with no hint that a sync was pending.
   */
  const accessibleName = [
    label,
    badge !== undefined && badge > 0 ? `${badge} active` : null,
    dot ? "pending changes" : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <button
      type="button"
      title={badge ? `${label} (${badge})` : label}
      aria-label={accessibleName}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={cn(
        "w-10 h-10 rounded-lg flex items-center justify-center transition-colors relative",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
      )}
    >
      {icon}
      {badge !== undefined && badge > 0 && (
        <span
          className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 rounded-full bg-primary text-primary-foreground text-[10px] font-bold flex items-center justify-center px-1"
          aria-hidden="true"
        >
          {badge}
        </span>
      )}
      {dot && (
        <span
          className="absolute top-1 right-1 h-2.5 w-2.5 rounded-full bg-orange-500"
          aria-hidden="true"
        />
      )}
    </button>
  );
}

export function Sidebar({
  active,
  onNavigate,
  terminalCount = 0,
  tunnelCount = 0,
  gitPending = false,
}: SidebarProps) {
  return (
    <aside
      /*
        Audit-3 follow-up P3#10: previously this <aside> was labelled
        'Primary navigation' AND the inner <nav> was labelled
        'Primary'. Both ended up in the AT landmarks list as
        essentially the same item. The <aside> is just a visual
        sidebar wrapper; the meaningful landmark is the <nav>.
        Drop the aria-label here so AT only surfaces a single
        'Primary' navigation landmark.
      */
      className="w-16 bg-card border-r border-border flex flex-col items-center py-4 gap-2"
    >
      <div className="mb-4" aria-hidden="true">
        <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
          <span className="text-primary-foreground font-bold text-sm">S</span>
        </div>
      </div>
      <nav aria-label="Primary" className="contents">
        {navItems.map(({ id, label, icon }) => (
          <NavButton
            key={id}
            active={active === id}
            label={label}
            onClick={() => onNavigate(id)}
            icon={icon}
            badge={id === "tunnels" ? tunnelCount : undefined}
          />
        ))}

        {terminalCount > 0 && (
          <>
            <div
              className="w-6 border-t border-border my-1"
              aria-hidden="true"
            />
            <NavButton
              active={active === "terminals"}
              label="Terminals"
              onClick={() => onNavigate("terminals")}
              icon={<TerminalSquare className="h-5 w-5" />}
              badge={terminalCount}
            />
          </>
        )}

        <div className="mt-auto pt-2">
          <NavButton
            active={active === "git_sync"}
            label="Git Sync"
            onClick={() => onNavigate("git_sync")}
            icon={<GitBranch className="h-5 w-5" />}
            dot={gitPending}
          />
        </div>
      </nav>
    </aside>
  );
}
