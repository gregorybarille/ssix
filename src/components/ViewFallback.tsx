/**
 * Minimal Suspense fallback for lazy-loaded views. Intentionally
 * spartan: chunks load fast from local disk and a skeleton would just
 * flash. Centralised so every view fallback looks identical.
 */
export function ViewFallback({ label }: { label: string }) {
  return (
    <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground-soft">
      {label}
    </div>
  );
}
