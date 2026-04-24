import React from "react";
import { LucideIcon } from "lucide-react";

/**
 * Audit-4 Dup H1: shared empty-state for list views.
 *
 * Both ConnectionList and CredentialList rendered identical
 * "centered icon + heading + hint" blocks. The icon was the only
 * variation. Extracting this also makes it trivial to add a
 * primary action button later (e.g. "Create your first…") without
 * touching every list.
 *
 * Use a unique aria-labelled-by region so screen readers announce the
 * empty state when the list updates from non-empty → empty.
 */
interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  hint?: string;
}

export function EmptyState({ icon: Icon, title, hint }: EmptyStateProps) {
  return (
    <div
      className="flex flex-col items-center justify-center py-12 text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      <Icon className="h-12 w-12 mb-3 opacity-30" aria-hidden="true" />
      <p className="text-sm">{title}</p>
      {hint && <p className="text-xs mt-1">{hint}</p>}
    </div>
  );
}
