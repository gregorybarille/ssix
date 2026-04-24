/**
 * Audit-4 Dup H1: shared async-action wrapper for Zustand stores.
 *
 * Every store action followed the same 4-line pattern:
 *
 *   set({ isLoading: true, error: null });
 *   try {
 *     // … invoke + state update …
 *     set({ isLoading: false });
 *   } catch (err) {
 *     set({ error: String(err), isLoading: false });
 *     throw err;   // sometimes
 *   }
 *
 * The "sometimes" was the problem: 4 stores, 20+ actions, and the
 * rethrow was inconsistent. Fetches usually didn't rethrow, mutations
 * usually did, but exceptions to both rules existed and call sites
 * couldn't tell which to expect. With this helper:
 *
 *   - `runAsync(set, fn)`        → never rethrows; for fire-and-forget fetches
 *   - `runAsyncRethrow(set, fn)` → always rethrows; for actions where the
 *     caller needs to know whether to close a dialog
 *
 * Both manage `isLoading` and `error` identically.
 */

type SetLoadingError = (
  patch:
    | { isLoading?: boolean; error?: string | null }
    | ((prev: { isLoading?: boolean; error?: string | null }) => unknown),
) => void;

/**
 * Wrap an async store action so loading/error state is managed automatically.
 * Errors are recorded but NOT rethrown — the caller can poll `error`.
 */
export async function runAsync<T>(
  set: SetLoadingError,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  set({ isLoading: true, error: null });
  try {
    const result = await fn();
    set({ isLoading: false });
    return result;
  } catch (err) {
    set({ error: String(err), isLoading: false });
    return undefined;
  }
}

/**
 * Same as `runAsync`, but rethrows so the caller can `.catch()` and react
 * (e.g. keep a dialog open on validation failure).
 */
export async function runAsyncRethrow<T>(
  set: SetLoadingError,
  fn: () => Promise<T>,
): Promise<T> {
  set({ isLoading: true, error: null });
  try {
    const result = await fn();
    set({ isLoading: false });
    return result;
  } catch (err) {
    set({ error: String(err), isLoading: false });
    throw err;
  }
}
