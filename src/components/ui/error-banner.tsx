import type * as React from "react";
import { Button } from "./button";
import { cn } from "@/lib/utils";

export interface ErrorBannerProps {
  message: React.ReactNode;
  /** When set, a Retry button calls it. */
  onRetry?: () => void;
  className?: string;
  /**
   * Optional `data-testid` prefix: the banner gets `${testId}` and its
   * Retry button `${testId}-retry`.
   */
  testId?: string;
}

/**
 * Inline error region for a failed load or action. Errors are urgent and
 * must interrupt, so it is role=alert + aria-live=assertive;
 * `text-destructive` resolves to the AA-safe destructive-text token.
 */
export function ErrorBanner({ message, onRetry, className, testId }: ErrorBannerProps) {
  return (
    <div
      role="alert"
      aria-live="assertive"
      className={cn(
        "flex items-start gap-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive",
        className,
      )}
      data-testid={testId}
    >
      <p className="min-w-0 flex-1 break-words">{message}</p>
      {onRetry && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={onRetry}
          data-testid={testId ? `${testId}-retry` : undefined}
        >
          Retry
        </Button>
      )}
    </div>
  );
}
