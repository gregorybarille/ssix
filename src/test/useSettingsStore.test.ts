import { describe, it, expect, vi, beforeEach } from "vitest";
import { useSettingsStore } from "@/store/useSettingsStore";
import { invoke } from "@/lib/tauri";
import type { AppSettings } from "@/types";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useSettingsStore.saveSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("applies the new settings optimistically, then adopts the saved result", async () => {
    const pending = deferred<AppSettings>();
    vi.mocked(invoke).mockReturnValueOnce(pending.promise);
    const before = useSettingsStore.getState().settings;
    const next = { ...before, theme: "light" as const };

    const save = useSettingsStore.getState().saveSettings(next);
    expect(useSettingsStore.getState().settings.theme).toBe("light");

    pending.resolve({ ...next, font_size: 16 });
    await save;
    expect(useSettingsStore.getState().settings.font_size).toBe(16);
  });

  it("restores the previous settings when the backend rejects the save", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("Git remote must not start with '-'."));
    const before = useSettingsStore.getState().settings;
    const next = { ...before, git_sync_remote: "-f" };

    await expect(useSettingsStore.getState().saveSettings(next)).rejects.toThrow(/Git remote/);
    expect(useSettingsStore.getState().settings).toEqual(before);
  });
});
