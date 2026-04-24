/**
 * Lazy-loaded wrapper around `@tauri-apps/api/core#invoke`.
 *
 * Lazy import keeps Vitest happy: the test setup mocks this module so
 * unit tests don't need to load the real Tauri bridge (which fails
 * outside the desktop runtime).
 *
 * IMPORTANT: argument naming convention
 * -------------------------------------
 * Tauri's IPC layer converts the **top-level** argument names from
 * camelCase (JS side) to snake_case (Rust side) automatically. So
 * a Rust command like
 *
 *     fn ssh_connect(connection_id: String, conn_id: String) { … }
 *
 * is invoked as
 *
 *     invoke("ssh_connect", { connectionId: "…", connId: "…" })
 *
 * However, **nested fields** inside an object payload (e.g. `input`)
 * are NOT renamed — serde drives the deserialisation directly and
 * expects the snake_case names from the Rust struct:
 *
 *     // Rust:  fn add_connection(input: AddConnectionInput) where
 *     //        AddConnectionInput { name, host, port, credential_id, … }
 *     invoke("add_connection", {
 *       input: { name, host, port, credential_id, … }   // snake_case!
 *     })
 *
 * Mixing these conventions has caused several past bugs (silently
 * dropped fields). When in doubt, look at the Rust handler signature:
 *   - top-level params → camelCase from JS
 *   - struct fields    → snake_case from JS
 */
type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

let _invoke: InvokeFn | null = null;

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!_invoke) {
    try {
      const tauri = await import("@tauri-apps/api/core");
      _invoke = tauri.invoke as InvokeFn;
    } catch {
      throw new Error("Tauri is not available");
    }
  }
  return _invoke<T>(cmd, args);
}
