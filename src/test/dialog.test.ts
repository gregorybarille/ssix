import { describe, it, expect, vi, beforeEach } from "vitest";
import { pickFile } from "@/lib/dialog";

beforeEach(() => {
  vi.resetModules();
});

describe("pickFile", () => {
  it("forwards options to plugin-dialog.open and returns the chosen path", async () => {
    const open = vi.fn(async () => "/Users/me/.ssh/id_ed25519");
    vi.doMock("@tauri-apps/plugin-dialog", () => ({ open }));
    // Re-import after mocking so the lazy import inside pickFile picks up
    // the mocked module.
    const { pickFile: pf } = await import("@/lib/dialog");
    const result = await pf({
      title: "Pick a key",
      defaultPath: "/Users/me/.ssh",
      filters: [{ name: "All", extensions: ["*"] }],
    });
    expect(result).toBe("/Users/me/.ssh/id_ed25519");
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        multiple: false,
        directory: false,
        title: "Pick a key",
        defaultPath: "/Users/me/.ssh",
        filters: [{ name: "All", extensions: ["*"] }],
      }),
    );
  });

  it("returns null when the user cancels (plugin returns null)", async () => {
    vi.doMock("@tauri-apps/plugin-dialog", () => ({
      open: vi.fn(async () => null),
    }));
    const { pickFile: pf } = await import("@/lib/dialog");
    expect(await pf()).toBeNull();
  });

  it("returns the first entry when the plugin returns an array", async () => {
    vi.doMock("@tauri-apps/plugin-dialog", () => ({
      open: vi.fn(async () => ["/a", "/b"]),
    }));
    const { pickFile: pf } = await import("@/lib/dialog");
    expect(await pf()).toBe("/a");
  });

  it("returns null when the plugin import throws (non-Tauri context)", async () => {
    vi.doMock("@tauri-apps/plugin-dialog", () => {
      throw new Error("not available");
    });
    const { pickFile: pf } = await import("@/lib/dialog");
    expect(await pf()).toBeNull();
  });

  // Sanity check that the production module still exports the function.
  it("module exposes pickFile as a function", () => {
    expect(typeof pickFile).toBe("function");
  });
});
