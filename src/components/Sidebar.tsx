import React, { useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, KeyRound, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { errorMessage } from "@/lib/errors";
import { log as appLog } from "@/lib/log";
import {
  arrangeSidebar,
  defaultSidebarOrder,
  dropSlot,
  moveDown,
  moveToSlot,
  moveUp,
  sameOrder,
  type GroupGeometry,
  type SidebarGroup,
  type SidebarOrder,
  type SidebarSlot,
} from "@/lib/sidebarOrder";
import { VIEWS, type NavItem, type ViewDefinition, type ViewPlacement } from "@/lib/views";
import { usePointerDrag } from "@/hooks/usePointerDrag";
import { ContextMenu, isContextMenuKey, useContextMenu, type ContextMenuItem } from "./ContextMenu";
import { DragChip } from "@/components/ui/drag-chip";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuthPromptStore } from "@/store/useAuthPromptStore";
import { useSettingsStore } from "@/store/useSettingsStore";

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
  buttonRef,
  onPointerDown,
  onContextMenu,
  onKeyDown,
  lifted,
  dimmed,
  dropLine,
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
  buttonRef?: (element: HTMLButtonElement | null) => void;
  onPointerDown?: (event: React.PointerEvent) => void;
  onContextMenu?: (event: React.MouseEvent) => void;
  onKeyDown?: (event: React.KeyboardEvent<HTMLElement>) => void;
  /** Held long enough that moving now would drag it. */
  lifted?: boolean;
  /** Being dragged: it stays in place, faint, until it lands. */
  dimmed?: boolean;
  /** A drop here lands on this side of this button. */
  dropLine?: "before" | "after";
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
          ref={buttonRef}
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
          onPointerDown={onPointerDown}
          onContextMenu={onContextMenu}
          onKeyDown={onKeyDown}
          data-lifted={lifted ? "true" : undefined}
          data-drop-line={dropLine}
          className={cn(
            "w-10 h-10 rounded-lg flex items-center justify-center transition-colors relative",
            lifted && "ring-2 ring-primary",
            dimmed && "opacity-40",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card",
            active
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
          )}
        >
          {icon}
          {dropLine && (
            <span
              className={cn(
                "absolute inset-x-0 h-0.5 rounded-full bg-primary",
                dropLine === "before" ? "-top-[5px]" : "-bottom-[5px]",
              )}
              aria-hidden="true"
            />
          )}
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

/** Long enough that a click, even a slow one, never starts a drag. */
const HOLD_MS = 350;
/** How far outside the sidebar a drag still counts as over it. */
const DROP_MARGIN = 48;

const testIdOf = (id: string) => `nav-${id.replace("_", "-")}`;

const viewById = new Map<string, ViewDefinition<NavItem>>(VIEWS.map((view) => [view.id, view]));

export function Sidebar({
  active,
  onNavigate,
  terminalCount = 0,
  forwardCount = 0,
  gitPending = false,
}: SidebarProps) {
  const promptWaiting = useAuthPromptStore((state) => Object.keys(state.prompts).length > 0);
  const storedTop = useSettingsStore((state) => state.settings.sidebar_top);
  const storedBottom = useSettingsStore((state) => state.settings.sidebar_bottom);
  const defaults = useMemo(() => defaultSidebarOrder(VIEWS), []);
  const order = useMemo(
    () => arrangeSidebar(VIEWS, { top: storedTop, bottom: storedBottom }),
    [storedTop, storedBottom],
  );

  // The live state a button shows on top of what the view table says about it.
  const badges: Partial<Record<NavItem, number>> = {
    forwards: forwardCount,
    terminals: terminalCount,
  };
  const dots: Partial<Record<NavItem, boolean>> = { git_sync: gitPending };
  const waiting: Partial<Record<NavItem, string>> = {
    terminals: promptWaiting ? "login prompt waiting" : undefined,
  };

  const [announcement, setAnnouncement] = useState("");
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const groups = useRef<Partial<Record<SidebarGroup, HTMLDivElement | null>>>({});
  const asideRef = useRef<HTMLElement>(null);

  /** Save an order and say where the button went, for those who cannot see it. */
  const applyOrder = (next: SidebarOrder, movedId?: string) => {
    // Back at the default stores nothing, so the order keeps following the app.
    const atDefault = sameOrder(next, defaults);
    const { settings, saveSettings } = useSettingsStore.getState();
    void saveSettings({
      ...settings,
      sidebar_top: atDefault ? [] : [...next.top],
      sidebar_bottom: atDefault ? [] : [...next.bottom],
    }).catch((error) => {
      appLog.error("settings", `Failed to save the sidebar order: ${errorMessage(error)}`);
    });
    const view = movedId ? viewById.get(movedId) : undefined;
    if (!view) {
      setAnnouncement("Sidebar order reset");
      return;
    }
    const group: SidebarGroup = next.top.includes(view.id) ? "top" : "bottom";
    const place = next[group].indexOf(view.id) + 1;
    setAnnouncement(
      `${view.label} moved to place ${place} of ${next[group].length} in the ${group} group`,
    );
  };

  const [pressedId, setPressedId] = useState<string | null>(null);
  const slotAt = (x: number, y: number): SidebarSlot | null => {
    const aside = asideRef.current?.getBoundingClientRect();
    const { top, bottom } = groups.current;
    if (!aside || !top || !bottom) return null;
    if (x < aside.left - DROP_MARGIN || x > aside.right + DROP_MARGIN) return null;
    const geometry = (group: SidebarGroup, element: HTMLElement): GroupGeometry => {
      const box = element.getBoundingClientRect();
      const centres = order[group]
        .filter((id) => id !== pressedId)
        .flatMap((id) => {
          const rect = buttons.current.get(id)?.getBoundingClientRect();
          return rect ? [rect.top + rect.height / 2] : [];
        });
      return { start: box.top, end: box.bottom, centres };
    };
    return dropSlot(y, geometry("top", top), geometry("bottom", bottom));
  };
  const drag = usePointerDrag<SidebarSlot>(slotAt, { holdMs: HOLD_MS });
  const draggingId = drag.chip ? pressedId : null;

  const startDrag = (event: React.PointerEvent, view: ViewDefinition<NavItem>) => {
    setPressedId(view.id);
    drag.startPress(
      event,
      () => view.label,
      (slot) => {
        const next = moveToSlot(order, view.id, slot);
        if (next !== order) applyOrder(next, view.id);
      },
    );
  };

  /** Which side of a button the line showing where a drop would land goes. */
  const dropLineOn = (id: string): "before" | "after" | undefined => {
    const slot = drag.chip?.target;
    if (!slot || !order[slot.group].includes(id)) return undefined;
    const rest = order[slot.group].filter((other) => other !== draggingId);
    if (rest.length === 0) return "before";
    if (slot.index < rest.length) return rest[slot.index] === id ? "before" : undefined;
    return rest[rest.length - 1] === id ? "after" : undefined;
  };

  const ctx = useContextMenu();
  const [menuViewId, setMenuViewId] = useState<string | null>(null);
  // A button only takes the keyboard back if it had it: a right click must not
  // pull focus out of the terminal the user was typing in.
  const refocus = useRef(false);
  const noteMenuOpener = (event: React.SyntheticEvent, id: string) => {
    setMenuViewId(id);
    refocus.current = event.currentTarget === document.activeElement;
  };
  const moveFromMenu = (id: string, next: SidebarOrder) => {
    applyOrder(next, id);
    // Moving between groups rebuilds the button, so the menu's own restore of
    // focus can land on one that is gone. After the next paint it is in place.
    if (refocus.current) requestAnimationFrame(() => buttons.current.get(id)?.focus());
  };
  const menuItems = (id: string): ContextMenuItem[] => {
    const up = moveUp(order, id);
    const down = moveDown(order, id);
    return [
      {
        label: "Move up",
        icon: <ArrowUp className="h-3.5 w-3.5" />,
        disabled: up === order,
        onClick: () => moveFromMenu(id, up),
      },
      {
        label: "Move down",
        icon: <ArrowDown className="h-3.5 w-3.5" />,
        disabled: down === order,
        onClick: () => moveFromMenu(id, down),
      },
      { separator: true },
      {
        label: "Reset order",
        icon: <RotateCcw className="h-3.5 w-3.5" />,
        disabled: sameOrder(order, defaults),
        onClick: () => {
          applyOrder(defaults);
          if (refocus.current) requestAnimationFrame(() => buttons.current.get(id)?.focus());
        },
      },
    ];
  };

  const navButton = (view: ViewDefinition<NavItem>, movable: boolean) => (
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
      testId={testIdOf(view.id)}
      {...(movable && {
        buttonRef: (element: HTMLButtonElement | null) => {
          if (element) buttons.current.set(view.id, element);
          else buttons.current.delete(view.id);
        },
        onPointerDown: (event: React.PointerEvent) => startDrag(event, view),
        onContextMenu: (event: React.MouseEvent) => {
          noteMenuOpener(event, view.id);
          ctx.open(event);
        },
        onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
          // Before the hook, which stops the event once it has opened the menu.
          if (isContextMenuKey(event)) noteMenuOpener(event, view.id);
          ctx.onKeyDown(event);
        },
        lifted: drag.held && pressedId === view.id,
        dimmed: draggingId === view.id,
        dropLine: dropLineOn(view.id),
      })}
    />
  );
  const movableGroup = (group: SidebarGroup) => {
    const views = order[group].flatMap((id) => {
      const view = viewById.get(id);
      return view ? [navButton(view, true)] : [];
    });
    // A group with nothing in it still has to be somewhere to drop.
    if (views.length > 0 || !draggingId) return views;
    return (
      <div
        className={cn(
          "w-10 h-10 rounded-lg border-2 border-dashed",
          drag.chip?.target?.group === group ? "border-primary" : "border-border",
        )}
        aria-hidden="true"
        data-testid={`sidebar-drop-zone-${group}`}
      />
    );
  };
  const placedIn = (placement: ViewPlacement) =>
    VIEWS.filter((view) => view.placement === placement).map((view) => navButton(view, false));

  return (
    <aside
      ref={asideRef}
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
        {/* No tooltips popping up under a drag: the drag follows the window, not the buttons. */}
        <nav aria-label="Primary" className={cn("contents", draggingId && "pointer-events-none")}>
          <div
            ref={(element) => {
              groups.current.top = element;
            }}
            className="flex flex-col items-center gap-2"
            data-testid="sidebar-top"
          >
            {movableGroup("top")}
          </div>

          {terminalCount > 0 && (
            <>
              <div
                className="w-6 border-t border-border my-1"
                aria-hidden="true"
              />
              {placedIn("sessions")}
            </>
          )}

          <div
            ref={(element) => {
              groups.current.bottom = element;
            }}
            className="mt-auto pt-2 flex flex-col items-center gap-2"
            data-testid="sidebar-bottom"
          >
            {movableGroup("bottom")}
          </div>
        </nav>
      </TooltipProvider>
      <span role="status" className="sr-only" data-testid="sidebar-announcement">
        {announcement}
      </span>
      {drag.chip && <DragChip chip={drag.chip} testId="sidebar-drag-chip" />}
      {ctx.state && menuViewId && (
        <ContextMenu
          position={ctx.state}
          onClose={ctx.close}
          ariaLabel="Sidebar order"
          items={menuItems(menuViewId)}
        />
      )}
    </aside>
  );
}
