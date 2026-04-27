import React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** "destructive" renders the confirm button red. */
  variant?: "destructive" | "default";
  onConfirm: () => void | Promise<void>;
  /**
   * Optional `data-testid` prefix. When set, the dialog content,
   * confirm and cancel buttons receive `${testId}`, `${testId}-confirm`
   * and `${testId}-cancel` respectively. Used by E2E specs to disambiguate
   * which ConfirmDialog instance is on screen (the App mounts several).
   */
  testId?: string;
}

/**
 * Generic Yes/No confirmation dialog. Built on Radix so it gets
 * focus trap, Escape-to-close, and aria-labelledby/aria-describedby
 * for free.
 *
 * Default focus lands on the cancel button — never on the destructive
 * action — so a careless Enter press cannot delete data.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = "default",
  onConfirm,
  testId,
}: ConfirmDialogProps) {
  const [busy, setBusy] = React.useState(false);
  // Focus-return on close is implemented in the shared <DialogContent>
  // primitive (Audit-3 #2) so every dialog in the app benefits without
  // per-call wiring.

  const handleConfirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-sm" data-testid={testId}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button
            variant="ghost"
            autoFocus
            onClick={() => onOpenChange(false)}
            disabled={busy}
            data-testid={testId ? `${testId}-cancel` : undefined}
          >
            {cancelLabel}
          </Button>
          <Button
            variant={variant === "destructive" ? "destructive" : "default"}
            onClick={handleConfirm}
            disabled={busy}
            data-testid={testId ? `${testId}-confirm` : undefined}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
