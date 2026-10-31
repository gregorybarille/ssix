import React from "react";
import { Server, Key, TerminalSquare, Cable, ScrollText, GitBranch, FileCode } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export type NavItem =
  | "connections"
  | "credentials"
  | "forwards"
  | "scripts"
  | "logs"
  | "git_sync"
  | "settings"
  | "terminals";

interface SidebarProps {
  active: NavItem;
  onNavigate: (item: NavItem) => void;
  terminalCount?: number;
  forwardCount?: number;
  gitPending?: boolean;
}

/**
 * `hint` is the one line under the name in each button's tooltip: the
 * icons alone do not tell a new user what is behind them.
 */
const navItems: { id: NavItem; label: string; hint: string; icon: React.ReactNode }[] = [
  {
    id: "connections",
    label: "Connections",
    hint: "Your saved hosts: open a terminal, transfer files",
    icon: <Server className="h-5 w-5" aria-hidden="true" />,
  },
  {
    id: "forwards",
    label: "Port forwards",
    hint: "Local forwards (ssh -L) and whether they are running",
    icon: <Cable className="h-5 w-5" aria-hidden="true" />,
  },
  {
    id: "credentials",
    label: "Credentials",
    hint: "Passwords and SSH keys used to log in",
    icon: <Key className="h-5 w-5" aria-hidden="true" />,
  },
  {
    id: "scripts",
    label: "Scripts",
    hint: "Saved scripts to run on several hosts at once",
    icon: <FileCode className="h-5 w-5" aria-hidden="true" />,
  },
  {
    id: "logs",
    label: "Logs",
    hint: "What the app and your connections did",
    icon: <ScrollText className="h-5 w-5" aria-hidden="true" />,
  },
];

function NavButton({
  active,
  label,
  hint,
  onClick,
  icon,
  badge,
  dot,
  testId,
}: {
  active: boolean;
  label: string;
  hint: string;
  onClick: () => void;
  icon: React.ReactNode;
  badge?: number;
  dot?: boolean;
  testId?: string;
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
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          // E2E hook — kept on the button itself (not a wrapper) so wdio's
          // waitForClickable resolves on the actual interactive element.
          data-testid={testId}
          // No `title=`: the tooltip below names the view and says what
          // it is for, on hover and on keyboard focus. The badge count and
          // "pending changes" state stay in aria-label and on the icon.
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
      </TooltipTrigger>
      <TooltipContent side="right" data-testid={testId ? `${testId}-tooltip` : undefined}>
        <p className="font-medium">{label}</p>
        <p className="text-muted-foreground">{hint}</p>
      </TooltipContent>
    </Tooltip>
  );
}

export function Sidebar({
  active,
  onNavigate,
  terminalCount = 0,
  forwardCount = 0,
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
      className="w-16 bg-card border-r border-border flex flex-col items-center py-4 gap-2 shrink-0 overflow-hidden"
      data-testid="sidebar"
    >
      <TooltipProvider>
        <nav aria-label="Primary" className="contents">
          {navItems.map(({ id, label, hint, icon }) => (
            <NavButton
              key={id}
              active={active === id}
              label={label}
              hint={hint}
              onClick={() => onNavigate(id)}
              icon={icon}
              badge={id === "forwards" ? forwardCount : undefined}
              testId={`nav-${id.replace("_", "-")}`}
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
                hint="The terminals you have open"
                onClick={() => onNavigate("terminals")}
                icon={<TerminalSquare className="h-5 w-5" aria-hidden="true" />}
                badge={terminalCount}
                testId="nav-terminals"
              />
            </>
          )}

          <div className="mt-auto pt-2">
            <NavButton
              active={active === "git_sync"}
              label="Git Sync"
              hint="Export your connections and settings to a git repository"
              onClick={() => onNavigate("git_sync")}
              icon={<GitBranch className="h-5 w-5" aria-hidden="true" />}
              dot={gitPending}
              testId="nav-git-sync"
            />
          </div>
        </nav>
      </TooltipProvider>
    </aside>
  );
}
