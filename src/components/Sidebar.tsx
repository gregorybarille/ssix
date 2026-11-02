import React from "react";
import { KeyRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { VIEWS, type NavItem, type ViewDefinition, type ViewPlacement } from "@/lib/views";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuthPromptStore } from "@/store/useAuthPromptStore";

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
function NavButton({
  active,
  label,
  hint,
  onClick,
  icon,
  badge,
  dot,
  waiting,
  testId,
}: {
  active: boolean;
  label: string;
  hint: string;
  onClick: () => void;
  icon: React.ReactNode;
  badge?: number;
  dot?: boolean;
  /** What is waiting for the user behind this button, in words. */
  waiting?: string;
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
    waiting ?? null,
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
          {waiting && (
            <span
              className="absolute -bottom-0.5 -right-0.5 rounded-full p-0.5 bg-primary text-primary-foreground"
              aria-hidden="true"
              data-testid={testId ? `${testId}-waiting` : undefined}
            >
              <KeyRound className="h-2.5 w-2.5" />
            </span>
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
  const promptWaiting = useAuthPromptStore((state) => Object.keys(state.prompts).length > 0);
  // The live state a button shows on top of what the view table says about it.
  const badges: Partial<Record<NavItem, number>> = {
    forwards: forwardCount,
    terminals: terminalCount,
  };
  const dots: Partial<Record<NavItem, boolean>> = { git_sync: gitPending };
  const waiting: Partial<Record<NavItem, string>> = {
    terminals: promptWaiting ? "login prompt waiting" : undefined,
  };

  const navButton = (view: ViewDefinition<NavItem>) => (
    <NavButton
      key={view.id}
      active={active === view.id}
      label={view.label}
      hint={view.description}
      onClick={() => onNavigate(view.id)}
      icon={<view.icon className="h-5 w-5" aria-hidden="true" />}
      badge={badges[view.id]}
      dot={dots[view.id]}
      waiting={waiting[view.id]}
      testId={`nav-${view.id.replace("_", "-")}`}
    />
  );
  const placedIn = (placement: ViewPlacement) =>
    VIEWS.filter((view) => view.placement === placement).map(navButton);

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
          {placedIn("main")}

          {terminalCount > 0 && (
            <>
              <div
                className="w-6 border-t border-border my-1"
                aria-hidden="true"
              />
              {placedIn("sessions")}
            </>
          )}

          <div className="mt-auto pt-2">{placedIn("footer")}</div>
        </nav>
      </TooltipProvider>
    </aside>
  );
}
