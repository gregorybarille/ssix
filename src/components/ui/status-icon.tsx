import { Ban, CheckCircle2, Circle, Loader2, MinusCircle, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { StepStatus } from "@/lib/bulk-actions";

/** Per-host progress glyph for batch operations (bulk SCP, script runs). */
export function StatusIcon({ status }: { status: StepStatus }) {
  const cls = "h-4 w-4 mt-0.5 shrink-0";
  switch (status) {
    case "pending":
      return <Circle className={cn(cls, "text-muted-foreground-soft")} aria-label="Pending" />;
    case "running":
      return <Loader2 className={cn(cls, "text-foreground animate-spin")} aria-label="Running" />;
    case "success":
      return <CheckCircle2 className={cn(cls, "text-green-500")} aria-label="Success" />;
    case "error":
      return <XCircle className={cn(cls, "text-destructive")} aria-label="Error" />;
    case "skipped":
      return <MinusCircle className={cn(cls, "text-muted-foreground-soft")} aria-label="Skipped" />;
    case "cancelled":
      return <Ban className={cn(cls, "text-muted-foreground")} aria-label="Cancelled" />;
  }
}
