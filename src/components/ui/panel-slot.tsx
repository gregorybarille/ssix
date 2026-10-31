import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Where dialogs render: a column on the right of the app, next to the
 * current view, so editors, SCP, key tools and confirmations open beside
 * the list instead of over it. `<DialogContent>` portals into the element
 * this context holds; outside a provider (unit tests) it falls back to
 * `document.body`.
 */
const PanelSlotContext = React.createContext<{
  slot: HTMLElement | null;
  setSlot: (el: HTMLElement | null) => void;
} | null>(null);

export function PanelSlotProvider({ children }: { children: React.ReactNode }) {
  const [slot, setSlot] = React.useState<HTMLElement | null>(null);
  const value = React.useMemo(() => ({ slot, setSlot }), [slot]);
  return <PanelSlotContext.Provider value={value}>{children}</PanelSlotContext.Provider>;
}

/** The element dialogs should portal into, or null for `document.body`. */
export function usePanelSlot(): HTMLElement | null {
  return React.useContext(PanelSlotContext)?.slot ?? null;
}

/**
 * The column itself. Hidden while empty; confirmations stack above the
 * panel they belong to (see `DialogContent`'s `kind`).
 */
export function PanelSlot({ className }: { className?: string }) {
  const context = React.useContext(PanelSlotContext);
  return (
    <aside
      ref={context?.setSlot}
      data-testid="app-panel-slot"
      aria-label="Side panel"
      className={cn(
        "flex w-[min(560px,50vw)] shrink-0 flex-col min-h-0 overflow-hidden border-l border-border bg-card empty:hidden",
        className,
      )}
    />
  );
}
