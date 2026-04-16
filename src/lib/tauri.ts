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
