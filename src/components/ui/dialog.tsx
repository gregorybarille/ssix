import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

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

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, onCloseAutoFocus, ...props }, ref) => {
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
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
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
          "fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:rounded-lg",
          className
        )}
        {...props}
      >
        {/*
         * Empty fallback description so Radix doesn't warn when callers omit
         * <DialogDescription>. Callers that DO include a real DialogDescription
         * will replace this via the aria-describedby wiring Radix sets up.
         */}
        <DialogPrimitive.Description className="sr-only" />
        {children}
        <DialogClose className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </DialogClose>
      </DialogPrimitive.Content>
    </DialogPortal>
  );
});
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-1.5 text-center sm:text-left",
      className
    )}
    {...props}
  />
);
DialogHeader.displayName = "DialogHeader";

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
      className
    )}
    {...props}
  />
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-lg font-semibold leading-none tracking-tight",
      className
    )}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
