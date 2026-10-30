/**
 * Outside the desktop webview (the Vite dev server opened in a browser)
 * there is no `window.__TAURI_INTERNALS__`, and the raw bridge fails with an
 * opaque TypeError. `invoke` and the output channel check first and reject
 * with one readable message instead.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as core from "@tauri-apps/api/core";
import { invoke } from "@/lib/tauri";
import { isTauriRuntime, TAURI_UNAVAILABLE_MESSAGE } from "@/lib/runtime";
import { createOutputChannel } from "@/lib/terminalOutput";

type Bridge = Record<string, unknown>;
const win = window as unknown as Bridge;
const bridge = win.__TAURI_INTERNALS__;

function leaveDesktopRuntime() {
  delete win.__TAURI_INTERNALS__;
}

describe("Tauri runtime detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    win.__TAURI_INTERNALS__ = bridge;
  });

  it("detects the desktop runtime through the injected bridge", () => {
    expect(isTauriRuntime()).toBe(true);
    leaveDesktopRuntime();
    expect(isTauriRuntime()).toBe(false);
  });

  it("invoke forwards to the bridge inside the desktop runtime", async () => {
    vi.mocked(core.invoke).mockResolvedValueOnce([]);
    await expect(invoke("get_connections")).resolves.toEqual([]);
    expect(core.invoke).toHaveBeenCalledWith("get_connections", undefined);
  });

  it("invoke rejects with a readable message outside it and never touches the bridge", async () => {
    leaveDesktopRuntime();
    await expect(invoke("get_connections")).rejects.toThrow(TAURI_UNAVAILABLE_MESSAGE);
    expect(core.invoke).not.toHaveBeenCalled();
    expect(TAURI_UNAVAILABLE_MESSAGE).toMatch(/npm run tauri dev/);
  });

  it("the terminal output channel refuses the same way", async () => {
    leaveDesktopRuntime();
    await expect(createOutputChannel()).rejects.toThrow(TAURI_UNAVAILABLE_MESSAGE);
  });
});
