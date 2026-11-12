import * as React from "react";
import { XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";

import { focusWasTaken } from "@/lib/focus";
import { cn } from "@/lib/utils";
import { usePanelSlot } from "./panel-slot";
import { overlayHost } from "@/lib/overlayHost";

function Dialog({
  modal,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" modal={modal ?? false} {...props} />;
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

/**
 * How a dialog sits in the app:
 * - `panel` (default): fills the right-hand panel column beside the view.
 * - `confirm`: centred over a dimmed app, which waits for the answer. Its
 *   `<Dialog>` takes `modal`, which is what keeps the app out of reach.
 * - `palette`: centred over the app, for the quick-connect picker.
 */
type DialogKind = "panel" | "confirm" | "palette";

const CENTERED =
  "fixed top-[50%] left-[50%] z-50 max-h-[calc(100vh-5rem)] w-full max-w-[calc(100vw-2rem)] translate-x-[-50%] translate-y-[-50%] rounded-xl border border-border/80 bg-card p-6 shadow-2xl shadow-black/25 outline-none ring-1 ring-white/5";

const KIND_CLASSES: Record<DialogKind, string> = {
  panel:
    "relative flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto border-b border-border bg-card p-6 outline-none last:border-b-0",
  confirm: `${CENTERED} flex flex-col gap-4 overflow-y-auto sm:max-w-md [&_[data-slot=dialog-title]]:pr-6`,
  palette:
    `${CENTERED} grid gap-4 overflow-hidden duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:max-w-lg`,
};

/**
 * Fades in but not out: it stays clickable until it is removed, so fading out
 * it would take the click meant for what is behind it.
 */
function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in-0",
        className,
      )}
      {...props}
    />
  );
}

/*
 * Audit-3 #2: track the last interactive element the user focused
 * outside any open Dialog. Radix's built-in focus restore relies on
 * `document.activeElement` at content-mount time, which is often
 * already <body> in jsdom and Safari/WebKit (button click doesn't
 * always retain focus before a synchronously-opening dialog mounts).
 *
 * We attach document-level focusin and pointerdown listeners (capture
 * phase) and remember the most recent NON-dialog element that received
 * focus or a pointer press. On dialog close we restore focus to that
 * element if it's still connected to the document.
 */
/** Gone as soon as they have been used, so never what focus returns to. */
const PASSING_THROUGH = "[role='dialog'], [role='menu']";
let lastNonDialogFocus: HTMLElement | null = null;
let listenerInstalled = false;
function ensureFocusTrackerInstalled() {
  if (listenerInstalled || typeof document === "undefined") return;
  listenerInstalled = true;
  document.addEventListener(
    "focusin",
    (event) => {
      const target = event.target as HTMLElement | null;
      if (!target || target === document.body) return;
      if (target.closest(PASSING_THROUGH)) return;
      lastNonDialogFocus = target;
    },
    true,
  );
  document.addEventListener(
    "pointerdown",
    (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const focusable = target.closest<HTMLElement>(
        "button, [href], [tabindex]:not([tabindex='-1']), input, select, textarea",
      );
      if (focusable && !focusable.closest(PASSING_THROUGH)) {
        lastNonDialogFocus = focusable;
      }
    },
    true,
  );
}

function readLastNonDialogFocus(): HTMLElement | null {
  if (lastNonDialogFocus && !lastNonDialogFocus.isConnected) {
    // Stale reference (RTL cleanup, parent re-mount, etc.) — drop it.
    lastNonDialogFocus = null;
  }
  return lastNonDialogFocus;
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  kind = "panel",
  onOpenAutoFocus,
  onCloseAutoFocus,
  onInteractOutside,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean;
  kind?: DialogKind;
}) {
  const triggerRef = React.useRef<HTMLElement | null>(null);
  const slot = usePanelSlot();

  ensureFocusTrackerInstalled();

  return (
    <DialogPortal data-slot="dialog-portal" container={kind === "panel" && slot ? slot : overlayHost()}>
      {kind === "confirm" && <DialogOverlay />}
      <DialogPrimitive.Content
        data-slot="app-panel-content"
        data-kind={kind}
        onInteractOutside={(event) => {
          onInteractOutside?.(event);
          // A panel sits beside the view the user keeps working in, so
          // clicking or tabbing there never closes it; Escape, Cancel and
          // the close button do. A stray click must not answer a confirmation
          // either.
          if (kind !== "palette") event.preventDefault();
        }}
        onOpenAutoFocus={(event) => {
          // Only now: this stays mounted with its <Dialog> while closed, so what had
          // focus at its first render says nothing about what opened it. A click need
          // not leave focus on what was clicked, hence the tracker first.
          const active = document.activeElement;
          triggerRef.current =
            readLastNonDialogFocus() ??
            (active instanceof HTMLElement && active !== document.body ? active : null);
          onOpenAutoFocus?.(event);
        }}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          if (event.defaultPrevented) return;
          if (focusWasTaken()) {
            event.preventDefault();
            return;
          }
          // Final attempt: if we never captured a stable trigger, try
          // the live tracker one more time.
          if (!triggerRef.current || !triggerRef.current.isConnected) {
            const candidate = readLastNonDialogFocus();
            if (candidate && candidate.isConnected) {
              triggerRef.current = candidate;
            }
          }
          if (triggerRef.current && triggerRef.current.isConnected) {
            event.preventDefault();
            triggerRef.current.focus();
          }
        }}
        className={cn(KIND_CLASSES[kind], className)}
        {...props}
      >
        {/*
          Audit-3 follow-up P1#5: NO empty fallback DialogDescription
          here. Previously this primitive rendered an empty sr-only
          <DialogPrimitive.Description /> to silence Radix's
          missing-description warning. That broke the wiring: Radix's
          Description provides a stable id via context, and both the
          empty fallback and any caller-rendered <DialogDescription>
          end up sharing that id. Per HTML, getElementById() returns
          the FIRST matching element — i.e. the empty fallback —
          which means screen readers got an empty description even
          when the caller rendered a real one.

          Every dialog in SSIX must now render a real <DialogDescription>
          (or pass `aria-describedby={undefined}` if the dialog truly
          has no descriptive prose, which is rare). The console
          warning Radix emits is the intended signal that a dialog
          needs prose for accessibility.
        */}
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className="absolute top-4 right-4 rounded-xs opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
      {...props}
    />
  );
}

function DialogFooter({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg leading-none font-semibold", className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
};
