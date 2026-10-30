import { useCallback, useState } from "react";

/**
 * Inline per-field form errors keyed by field name. `clearFieldError`
 * drops one entry (keeping the same object when there is nothing to drop,
 * so typing in a valid field does not re-render the form).
 */
export function useFieldErrors<K extends string>() {
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<K, string>>>({});
  const clearFieldError = useCallback(
    (key: K) =>
      setFieldErrors((errs) => {
        if (!errs[key]) return errs;
        const next = { ...errs };
        delete next[key];
        return next;
      }),
    [],
  );
  return { fieldErrors, setFieldErrors, clearFieldError };
}
