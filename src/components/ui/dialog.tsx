import * as React from "react";
import { XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
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
      if (target.closest("[role='dialog']")) return;
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
      if (focusable && !focusable.closest("[role='dialog']")) {
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
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean;
}) {
  const triggerRef = React.useRef<HTMLElement | null>(null);

  // Best-effort: capture the trigger as soon as we know about it. We
  // try at render time, then again in a layout effect (after the dom
  // has settled), then update on every render until we find a stable,
  // connected candidate. This covers three real cases:
  //   1. Trigger had focus when dialog opened (activeElement = trigger).
  //   2. Trigger was clicked but didn't keep focus (lastNonDialogFocus).
  //   3. Stale reference from a previous render/test (isConnected=false).
  if (typeof document !== "undefined") {
    ensureFocusTrackerInstalled();
    if (!triggerRef.current || !triggerRef.current.isConnected) {
      const candidate =
        readLastNonDialogFocus() ??
        (document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null);
      if (candidate && candidate !== document.body && candidate.isConnected) {
        triggerRef.current = candidate;
      }
    }
  }

  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          if (event.defaultPrevented) return;
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
        className={cn(
          "fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border bg-background p-6 shadow-lg duration-200 outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:max-w-lg",
          className,
        )}
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

          Every dialog in SSX must now render a real <DialogDescription>
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
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
