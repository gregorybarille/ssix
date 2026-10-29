import { useEffect, useMemo, useRef } from "react";

export interface DebouncedCallback<A extends unknown[]> {
  /** Schedule `fn(...args)` after the delay, replacing any pending call. */
  (...args: A): void;
  /** Run the pending call now. No-op when nothing is pending. */
  flush(): void;
  /** Drop the pending call without running it. */
  cancel(): void;
  /** True while a call is scheduled but has not run yet. */
  isPending(): boolean;
}

export interface UseDebouncedCallbackOptions {
  /**
   * What happens to a pending call when the component unmounts.
   * `"cancel"` (default) drops it; `"flush"` runs it synchronously in
   * the unmount cleanup so the last value is never lost.
   */
  onUnmount?: "flush" | "cancel";
}

/**
 * Trailing-edge debounce for a callback. The returned function is
 * referentially stable for a given `delayMs`, so it can be used in
 * effect dependency arrays and event listeners without churn, and it
 * always invokes the latest `fn` passed on the most recent render.
 *
 * Only the arguments of the most recent call are delivered; earlier
 * calls inside the window are coalesced away.
 */
export function useDebouncedCallback<A extends unknown[]>(
  fn: (...args: A) => void,
  delayMs: number,
  { onUnmount = "cancel" }: UseDebouncedCallbackOptions = {},
): DebouncedCallback<A> {
  const fnRef = useRef(fn);
  const onUnmountRef = useRef(onUnmount);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const argsRef = useRef<A | null>(null);

  useEffect(() => {
    fnRef.current = fn;
    onUnmountRef.current = onUnmount;
  }, [fn, onUnmount]);

  const debounced = useMemo(() => {
    const run = () => {
      timerRef.current = null;
      const args = argsRef.current;
      argsRef.current = null;
      if (args) fnRef.current(...args);
    };
    const call = ((...args: A) => {
      argsRef.current = args;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(run, delayMs);
    }) as DebouncedCallback<A>;
    call.cancel = () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
      argsRef.current = null;
    };
    call.flush = () => {
      if (timerRef.current === null) return;
      clearTimeout(timerRef.current);
      run();
    };
    call.isPending = () => timerRef.current !== null;
    return call;
  }, [delayMs]);

  useEffect(
    () => () => {
      if (onUnmountRef.current === "flush") debounced.flush();
      else debounced.cancel();
    },
    [debounced],
  );

  return debounced;
}
