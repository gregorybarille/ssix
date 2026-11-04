import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * A function that never changes but always runs the `fn` of the latest render,
 * so a memoized child can take it without re-rendering whenever its parent does.
 * For event handlers: it must not be called during a render.
 */
export function useLatestCallback<A extends unknown[], R>(fn: (...args: A) => R) {
  const latest = useRef(fn);
  // Layout effect, as in useDebouncedCallback: an event right after a commit
  // must not run the previous render's function.
  useLayoutEffect(() => {
    latest.current = fn;
  });
  return useCallback((...args: A) => latest.current(...args), []);
}
