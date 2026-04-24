/**
 * Thin wrapper around `@tauri-apps/plugin-dialog`'s file picker.
 *
 * Lazily imports the plugin so unit tests (which mock this module) never
 * touch the Tauri runtime. Returns `null` when the user cancels the dialog
 * or when the dialog plugin isn't available (non-Tauri context, e.g.
 * Storybook or a future web build).
 */
export interface PickFileOptions {
  /** Window title for the native dialog. */
  title?: string;
  /** Initial directory (absolute path). When omitted the OS default is used. */
  defaultPath?: string;
  /**
   * File-extension filters. Pass an empty `extensions` array to allow any
   * file (the implementation maps that to a permissive single filter).
   */
  filters?: Array<{ name: string; extensions: string[] }>;
}

export async function pickFile(options: PickFileOptions = {}): Promise<string | null> {
  try {
    const dialog = await import("@tauri-apps/plugin-dialog");
    const result = await dialog.open({
      multiple: false,
      directory: false,
      title: options.title,
      defaultPath: options.defaultPath,
      filters: options.filters,
    });
    if (result === null || result === undefined) return null;
    // The plugin returns either `string | null` (single) or `string[] | null`
    // (multiple). We always pass `multiple: false`, so a string is expected,
    // but we defensively handle the array shape too.
    if (Array.isArray(result)) return result[0] ?? null;
    return typeof result === "string" ? result : null;
  } catch {
    // Plugin unavailable (non-Tauri context) or the user denied it. Treat as
    // "no selection" so callers can fall back to manual entry.
    return null;
  }
}
